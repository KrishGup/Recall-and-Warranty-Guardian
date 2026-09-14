"""Record the Guardian demo video: the deck slides (rendered to PNG) plus live clips of the real site, assembled into one
MP4 with a timeline for the voice-over. Playwright drives its own Chromium, so nothing here touches the user's browser.

    python scripts/record_demo.py slides                 # scripts/deck_content.py -> var/demo/slides/NN-<id>.png (1920x1080)
    python scripts/record_demo.py screens                # fresh dashboard screenshots for the deck -> design/deck/assets/screens/
    python scripts/record_demo.py record [--reset]       # drive the site through the demo beats, one WebM clip per beat
    python scripts/record_demo.py assemble               # slides + clips -> var/demo/guardian-demo.mp4 + timeline.json + docs/DEMO_SCRIPT.md
    python scripts/record_demo.py all [--reset]
    python scripts/record_demo.py prompter            # docs/teleprompter.html paced to the timeline (also written by assemble)
    python scripts/record_demo.py mux narration.wav   # voice-over + video -> var/demo/guardian-demo-final.mp4

Options:
    --base-url URL     the site (default GUARDIAN_URL from .env; use http://127.0.0.1:8790 for a local dry run)
    --token TOKEN      GUARDIAN_API_TOKEN for actions (default from .env; --no-token for a server started without one)
    --reset            reset and reseed the target's store first (live: over SSM; local: on disk)
    --skip-sweep       do not start a sweep; the site is already paused on a decision (records the gate, decision and after beats)
    --headed           watch the recording in a visible browser
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from typing import Any

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import guardian  # noqa: E402,F401  (loads .env)
from deck_content import CLIPS, INK, LIVE, PAPER, REPO, SLIDES, logo_svg  # noqa: E402

OUT = os.path.join(ROOT, "var", "demo")
SLIDES_DIR = os.path.join(OUT, "slides")
CLIPS_DIR = os.path.join(OUT, "clips")
SCREENS_DIR = os.path.join(ROOT, "design", "deck", "assets", "screens")
W, H = 1920, 1080
FPS = 30

FONTS_CSS = "https://fonts.googleapis.com/css2?family=Roboto+Slab:wght@400;500;600;700&family=Lora:ital,wght@0,400;0,500;0,600;1,400&family=Habibi&display=swap"

CURSOR_JS = """
(() => {
  const c = document.createElement('div');
  c.id = '__cursor';
  Object.assign(c.style, { position: 'fixed', left: '-100px', top: '-100px', width: '26px', height: '26px', borderRadius: '50%',
    background: 'rgba(34,116,165,.28)', border: '2.5px solid #2274A5', boxShadow: '0 0 0 3px rgba(247,244,243,.85)',
    pointerEvents: 'none', zIndex: '2147483647', transform: 'translate(-50%,-50%)', transition: 'transform .09s ease, background .09s ease' });
  const add = () => { if (document.body && !document.getElementById('__cursor')) document.body.appendChild(c); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add();
  window.addEventListener('mousemove', e => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
  window.addEventListener('mousedown', () => { c.style.transform = 'translate(-50%,-50%) scale(.65)'; c.style.background = 'rgba(34,116,165,.6)'; }, true);
  window.addEventListener('mouseup', () => { c.style.transform = 'translate(-50%,-50%) scale(1)'; c.style.background = 'rgba(34,116,165,.28)'; }, true);
})();
"""


def say(m: str) -> None:
    print(m, flush=True)


def ffmpeg() -> str:
    import imageio_ffmpeg  # type: ignore

    return imageio_ffmpeg.get_ffmpeg_exe()


# ------------------------------------------------------------------------------------------------ slides (HTML -> PNG)
def esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def node_card(name: str, label: str, kind: str) -> str:
    color = {"code": "#B9C3BD", "agent": "#6FB3E3", "verify": "#5DBB86", "gate": "#FCBA04"}[kind]
    # Node ids never wrap (underscores give no break opportunity), so long ids get a smaller size instead of overflowing.
    name_px = 26 if len(name) <= 11 else 23 if len(name) <= 14 else 20
    label_px = 20 if len(label) <= 13 else 17
    return (
        f'<div style="background:#131F18;border:1px solid #2C3B33;border-left:6px solid {color};border-radius:12px;padding:16px 18px;width:258px;box-sizing:border-box;display:flex;flex-direction:column;gap:6px">'
        f'<span style="font-family:\'Roboto Slab\',Georgia,serif;font-weight:600;font-size:{name_px}px;line-height:1.2;white-space:nowrap">{esc(name)}</span>'
        f'<span style="font-family:Habibi,serif;font-size:{label_px}px;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap;color:{color}">{esc(label)}</span></div>'
    )


ARROW = '<div style="width:30px;display:flex;align-items:center;flex:0 0 auto"><span style="flex:1;height:2px;background:#4A5551"></span><span style="width:0;height:0;border-top:7px solid transparent;border-bottom:7px solid transparent;border-left:11px solid #4A5551"></span></div>'


def column(cards: list[tuple[str, str, str]]) -> str:
    inner = "".join(node_card(*c) for c in cards)
    return f'<div style="display:flex;flex-direction:column;gap:14px">{inner}</div>'


def slide_html(s: dict, video: bool = False) -> str:
    ink = s["bg"] == "ink"
    fg = PAPER if ink else INK
    muted = "#B9C3BD" if ink else "#4A5551"
    rule = "#2C3B33" if ink else "#DDD7D4"
    bg = INK if ink else PAPER
    eyebrow_color = "#FCBA04" if ink else "#4A5551"
    pad = "96px 110px 90px 110px"
    body = ""
    k = s["kind"]
    if k == "title":
        body = f"""
<div style="display:flex;align-items:center;gap:24px">{logo_svg(72)}<span style="font-family:'Roboto Slab',Georgia,serif;font-weight:600;font-size:44px">Guardian</span></div>
<div style="flex:1;display:flex;flex-direction:column;justify-content:center;gap:44px">
  <h1 style="font-family:'Roboto Slab',Georgia,serif;font-weight:700;font-size:128px;line-height:1.02;letter-spacing:-.015em;margin:0;max-width:1500px">{esc(s['h1'])}</h1>
  <p style="font-size:40px;line-height:1.35;margin:0;max-width:1300px">{esc(s['sub'])}</p>
  <p style="font-style:italic;font-size:34px;line-height:1.3;margin:0;color:{muted}">{esc(s['tagline'])}</p>
</div>
<div style="display:flex;flex-direction:column;gap:14px;border-top:1px solid {rule};padding-top:32px">
  <p class="eyebrow" style="color:#FCBA04;margin:0">{esc(s['footer_eyebrow'])}</p>
  <p class="mono" style="color:{muted};margin:0">{esc(s['footer_mono'])}</p>
</div>"""
    elif k == "problem":
        stats = "".join(
            f'<div style="display:flex;flex-direction:column;gap:8px"><p class="big">{esc(n)}</p><p style="font-size:28px;line-height:1.35;margin:0;color:{muted}">{esc(c)}</p></div>' for n, c in s["stats"]
        )
        body = f"""
<p class="eyebrow" style="color:{eyebrow_color};margin:0 0 20px 0">{esc(s['eyebrow'])}</p>
<h2 style="font-family:'Roboto Slab',Georgia,serif;font-weight:700;font-size:80px;line-height:1.08;letter-spacing:-.01em;margin:0;max-width:1500px">{esc(s['h2'])}</h2>
<p style="font-size:34px;line-height:1.45;margin:44px 0 0 0;max-width:1240px;color:{muted}">{esc(s['body'])}</p>
<div style="margin-top:auto;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:48px;border-top:1px solid {rule};padding-top:36px">{stats}</div>"""
    elif k == "who":
        bullets = "".join(f'<li style="display:flex;align-items:center;gap:20px"><span style="width:14px;height:14px;background:#FCBA04;flex:0 0 auto"></span><span>{esc(b)}</span></li>' for b in s["bullets"])
        body = f"""
<div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:80px;align-items:center;flex:1">
  <div style="display:flex;flex-direction:column;gap:44px">
    <div style="display:flex;flex-direction:column;gap:20px"><p class="eyebrow" style="color:{eyebrow_color};margin:0">{esc(s['eyebrow'])}</p>
    <h2 style="font-family:'Roboto Slab',Georgia,serif;font-weight:700;font-size:64px;line-height:1.1;letter-spacing:-.01em;margin:0">{esc(s['h2'])}</h2></div>
    <ul style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:24px;font-size:36px;line-height:1.3">{bullets}</ul>
    <p style="font-size:30px;line-height:1.45;margin:0;max-width:820px;color:{muted}">{esc(s['body'])}</p>
  </div>
  <img src="assets/screens/{s['image']}" style="display:block;height:820px;width:auto;border:1px solid #2C3B33;border-radius:28px">
</div>"""
    elif k == "steps":
        steps = "".join(
            f'<div style="display:flex;flex-direction:column;gap:16px;border-top:2px solid {INK};padding-top:24px">'
            f'<p style="font-family:\'Roboto Slab\',Georgia,serif;font-weight:600;font-size:28px;color:#2274A5;margin:0">{esc(n)}</p>'
            f'<h3 style="font-family:\'Roboto Slab\',Georgia,serif;font-weight:600;font-size:40px;line-height:1.15;margin:0">{esc(t)}</h3>'
            f'<p style="font-family:Habibi,serif;font-size:24px;letter-spacing:.04em;text-transform:uppercase;color:#4A5551;margin:0">{esc(l)}</p>'
            f'<p style="font-size:28px;line-height:1.45;margin:8px 0 0 0">{esc(b)}</p></div>'
            for n, t, l, b in s["steps"]
        )
        body = f"""
<p class="eyebrow" style="color:{eyebrow_color};margin:0 0 20px 0">{esc(s['eyebrow'])}</p>
<h2 style="font-family:'Roboto Slab',Georgia,serif;font-weight:700;font-size:64px;line-height:1.1;letter-spacing:-.01em;margin:0">{esc(s['h2'])}</h2>
<div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:40px;margin-top:64px;flex:1;align-content:center">{steps}</div>"""
    elif k == "demo":
        pad = "96px 80px 90px 80px"
        shown = s["paras"][:1] if video else s["paras"]
        para_px = 34 if video else 28
        paras = "".join(f'<p style="font-size:{para_px}px;line-height:1.4;margin:0;border-top:1px solid {rule};padding-top:20px">{esc(p)}</p>' for p in shown)
        if video:
            paras += f'<p class="eyebrow" style="color:{muted};margin:0;padding-top:8px">Live recording follows</p>'
        if not os.path.isfile(os.path.join(SCREENS_DIR, s["image"])):
            s = {**s, "image": "trace-tasks-gate.png"}  # until `screens` captures the fresh one
        body = f"""
<div style="display:grid;grid-template-columns:520px minmax(0,1fr);gap:60px;align-items:start;flex:1">
  <div style="display:flex;flex-direction:column;gap:44px">
    <div style="display:flex;flex-direction:column;gap:20px"><p class="eyebrow" style="color:{eyebrow_color};margin:0">{esc(s['eyebrow'])}</p>
    <h2 style="font-family:'Roboto Slab',Georgia,serif;font-weight:700;font-size:54px;line-height:1.12;letter-spacing:-.01em;margin:0">{esc(s['h2'])}</h2></div>
    <div style="display:flex;flex-direction:column;gap:20px">{paras}</div>
  </div>
  <img src="assets/screens/{s['image']}" style="display:block;width:100%;height:auto;max-height:860px;object-fit:contain;object-position:top;border:1px solid #DDD7D4;border-radius:12px;box-shadow:0 8px 24px rgba(0,15,8,.12)">
</div>"""
    elif k == "graph":
        row1 = ARROW.join(column(c) for c in s["row1"][:5])
        # the last two of row 1 carry the repair arc: triage <- severity_check
        tri, sev = s["row1"][4][0], s["row1"][5][0]
        row1 = ARROW.join(column(c) for c in s["row1"][:4]) + ARROW + (
            '<div style="position:relative;display:flex;align-items:center">'
            '<span style="position:absolute;left:129px;right:129px;top:-40px;height:36px;border:2px dashed #E4746A;border-bottom:none;border-radius:14px 14px 0 0"></span>'
            '<span style="position:absolute;left:0;right:0;top:-78px;text-align:center;font-family:Habibi,serif;font-size:24px;letter-spacing:.06em;text-transform:uppercase;color:#E4746A">repair ×1</span>'
            + node_card(*tri) + ARROW + node_card(*sev) + "</div>"
        )
        row2 = ARROW.join(column(c) for c in s["row2"]) + f'<p style="flex:1;font-size:26px;line-height:1.45;margin:0 0 0 56px;color:{muted}">{esc(s["explainer"])}</p>'
        legend = "".join(f'<span style="display:flex;align-items:center;gap:12px"><span style="width:18px;height:18px;background:{c}"></span><span>{esc(n)}</span></span>' for n, c in s["legend"])
        body = f"""
<p class="eyebrow" style="color:{eyebrow_color};margin:0 0 20px 0">{esc(s['eyebrow'])}</p>
<h2 style="font-family:'Roboto Slab',Georgia,serif;font-weight:700;font-size:64px;line-height:1.1;letter-spacing:-.01em;margin:0">{esc(s['h2'])}</h2>
<div style="display:flex;align-items:center;gap:0;margin-top:112px">{row1}</div>
<div style="display:flex;align-items:center;gap:0;margin-top:56px">{row2}</div>
<div style="margin-top:auto;display:flex;gap:40px;align-items:center;font-family:Habibi,serif;font-size:24px;letter-spacing:.06em;text-transform:uppercase;color:{muted}">{legend}</div>"""
    elif k == "cards":
        cards = "".join(
            f'<div style="background:#131F18;border:1px solid #2C3B33;border-radius:16px;padding:28px 32px;display:flex;flex-direction:column;gap:14px">'
            f'<p style="font-family:Habibi,serif;font-size:24px;letter-spacing:.06em;text-transform:uppercase;color:#FCBA04;margin:0">{esc(t)}</p>'
            f'<p style="font-size:27px;line-height:1.4;margin:0">{esc(b)}</p></div>'
            for t, b in s["cards"]
        )
        body = f"""
<p class="eyebrow" style="color:{eyebrow_color};margin:0 0 20px 0">{esc(s['eyebrow'])}</p>
<h2 style="font-family:'Roboto Slab',Georgia,serif;font-weight:700;font-size:64px;line-height:1.1;letter-spacing:-.01em;margin:0">{esc(s['h2'])}</h2>
<div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px;margin-top:44px">{cards}</div>
<p style="margin:auto 0 0 0;font-size:24px;line-height:1.4;color:{muted}">{esc(s['footnote'])}</p>"""
    elif k == "numbers":
        nums = "".join(
            f'<div style="display:flex;flex-direction:column;gap:10px;border-top:1px solid {rule};padding-top:28px"><p class="big">{esc(n)}</p><p style="font-size:28px;line-height:1.35;margin:0;color:{muted}">{esc(c)}</p></div>' for n, c in s["numbers"]
        )
        body = f"""
<p class="eyebrow" style="color:{eyebrow_color};margin:0 0 20px 0">{esc(s['eyebrow'])}</p>
<h2 style="font-family:'Roboto Slab',Georgia,serif;font-weight:700;font-size:64px;line-height:1.1;letter-spacing:-.01em;margin:0">{esc(s['h2'])}</h2>
<div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:40px 48px;margin-top:72px">{nums}</div>
<p style="margin:auto 0 0 0;font-size:26px;line-height:1.4;color:{muted};max-width:1500px">{esc(s['footer'])}</p>"""
    elif k == "closing":
        body = f"""
<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center">
  <div style="display:flex;align-items:center;gap:28px">{logo_svg(96)}<span style="font-family:'Roboto Slab',Georgia,serif;font-weight:600;font-size:56px">Guardian</span></div>
  <p style="font-style:italic;font-size:60px;line-height:1.25;margin:64px 0 0 0;max-width:1440px">{esc(s['quote'])}</p>
  <p class="mono" style="font-size:32px;margin:72px 0 0 0;color:#6FB3E3">{esc(s['mono'])}</p>
  <p class="mono" style="font-size:32px;margin:12px 0 0 0;color:#6FB3E3">{esc(s['mono2'])}</p>
  <p class="eyebrow" style="color:#FCBA04;margin:24px 0 0 0">{esc(s['eyebrow'])}</p>
</div>"""
    return f"""<!doctype html><html><head><meta charset="utf-8"><base href="file:///{os.path.join(ROOT, 'design', 'deck').replace(os.sep, '/')}/">
<link rel="stylesheet" href="{FONTS_CSS}">
<style>
html,body{{margin:0;padding:0;background:{bg}}}
section{{width:{W}px;height:{H}px;box-sizing:border-box;padding:{pad};display:flex;flex-direction:column;overflow:hidden;background:{bg};color:{fg};font-family:Lora,Georgia,serif}}
.eyebrow{{font-family:Habibi,serif;font-size:26px;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap}}
.mono{{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:26px;white-space:nowrap}}
.big{{font-family:'Roboto Slab',Georgia,serif;font-weight:700;font-size:104px;line-height:1;margin:0}}
</style></head><body><section>{body}</section></body></html>"""


def render_slides() -> list[str]:
    from playwright.sync_api import sync_playwright  # type: ignore

    os.makedirs(SLIDES_DIR, exist_ok=True)
    paths: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": W, "height": H}, device_scale_factor=1)
        for i, s in enumerate(SLIDES, 1):
            html_path = os.path.join(SLIDES_DIR, f"{i:02d}-{s['id']}.html")
            with open(html_path, "w", encoding="utf-8") as f:
                f.write(slide_html(s, video=True))
            page.goto("file:///" + html_path.replace(os.sep, "/"))
            page.evaluate("document.fonts.ready.then(() => true)")
            page.wait_for_timeout(700)
            out = os.path.join(SLIDES_DIR, f"{i:02d}-{s['id']}.png")
            page.screenshot(path=out, clip={"x": 0, "y": 0, "width": W, "height": H})
            paths.append(out)
            say(f"slide {i:02d} {s['id']}")
        browser.close()
    return paths


# ------------------------------------------------------------------------------------------------ the site
class Site:
    def __init__(self, base: str, token: str | None, headed: bool):
        self.base = base.rstrip("/")
        self.token = token
        self.headed = headed
        self.timeline: list[dict[str, Any]] = []

    def api(self, path: str) -> Any:
        with urllib.request.urlopen(self.base + path, timeout=20) as r:  # noqa: S310
            return json.loads(r.read().decode("utf-8"))

    def wait_until(self, pred, timeout_s: int, every: float = 5.0, label: str = "") -> Any:
        t0 = time.time()
        while time.time() - t0 < timeout_s:
            try:
                v = self.api("/api/summary")
                if pred(v):
                    return v
            except Exception as e:  # noqa: BLE001
                say(f"  (summary unavailable: {e})")
            time.sleep(every)
        raise TimeoutError(f"timed out waiting for {label}")

    def context(self, pw, name: str, mobile: bool = False, dark: bool = False):
        os.makedirs(CLIPS_DIR, exist_ok=True)
        browser = pw.chromium.launch(headless=not self.headed)
        vp = {"width": 390, "height": 844} if mobile else {"width": W, "height": H}
        ctx = browser.new_context(viewport=vp, device_scale_factor=2 if mobile else 1, record_video_dir=os.path.join(CLIPS_DIR, name), record_video_size=vp, color_scheme="dark" if dark else "light", locale="en-US", timezone_id="America/New_York")
        if self.token:
            ctx.add_cookies([{"name": "guardian_token", "value": self.token, "url": self.base}])
        ctx.add_init_script(CURSOR_JS)
        page = ctx.new_page()
        return browser, ctx, page

    def goto(self, page, path: str, settle: int = 1800) -> None:
        page.goto(self.base + path, wait_until="networkidle")
        page.wait_for_timeout(settle)

    @staticmethod
    def glide(page, x: float, y: float, steps: int = 36) -> None:
        page.mouse.move(x, y, steps=steps)
        page.wait_for_timeout(180)

    def click(self, page, locator, hold: int = 900) -> None:
        locator.first.scroll_into_view_if_needed()
        box = locator.first.bounding_box(timeout=8000)
        if not box:
            raise RuntimeError("element not visible")
        self.glide(page, box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.wait_for_timeout(250)
        locator.first.click()
        page.wait_for_timeout(hold)

    def hover_boxes(self, page, locators: list, hold: int = 700) -> None:
        for loc in locators:
            try:
                box = loc.first.bounding_box(timeout=3000)
            except Exception:  # noqa: BLE001
                box = None
            if box:
                self.glide(page, box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
                page.wait_for_timeout(hold)

    def finish(self, browser, ctx, page, name: str) -> str:
        page.wait_for_timeout(600)
        video = page.video
        ctx.close()
        path = video.path() if video else None
        browser.close()
        if not path:
            raise RuntimeError("no video recorded")
        final = os.path.join(CLIPS_DIR, f"{name}.webm")
        shutil.move(path, final)
        say(f"clip {name}: {final}")
        return final


# ------------------------------------------------------------------------------------------------ beats
def beat_inventory(site: Site, pw) -> str:
    b, ctx, page = site.context(pw, "inventory")
    site.goto(page, "/inventory")
    page.wait_for_timeout(2000)
    rows = page.locator(".g-linkbtn")
    site.hover_boxes(page, [rows.nth(2), rows.nth(4)], hold=700)
    site.click(page, page.get_by_role("button", name="NURSH", exact=False), hold=2000)
    site.hover_boxes(page, [page.locator(".g-receipt").first, page.get_by_text("Warranty", exact=True).first, page.get_by_text("Recall checks", exact=False).first], hold=2000)
    page.wait_for_timeout(3000)
    return site.finish(b, ctx, page, "inventory")


def beat_sweep_start(site: Site, pw) -> str:
    b, ctx, page = site.context(pw, "sweep-start")
    site.goto(page, "/flow")
    page.wait_for_timeout(1200)
    before = (site.api("/api/summary").get("last_sweep") or {}).get("run_id")
    site.click(page, page.get_by_role("button", name="Run sweep now"), hold=1200)
    # Watch the graph fill in for a while: the run is now the newest and selected. Fail fast if nothing started
    # (a missing token, a budget stop) instead of waiting twelve minutes for a gate that never comes.
    started = False
    for i in range(9):
        page.wait_for_timeout(2500)
        if not started and i >= 1:
            s = site.api("/api/summary")
            started = s.get("agent_status") == "working" or (s.get("last_sweep") or {}).get("run_id") not in (None, before)
            if not started and i >= 3:
                site.finish(b, ctx, page, "sweep-start")
                raise RuntimeError("the sweep did not start (check the token and the daily budget; the dashboard toast has the reason)")
    return site.finish(b, ctx, page, "sweep-start")


def beat_sweep_paused(site: Site, pw) -> str:
    b, ctx, page = site.context(pw, "sweep-paused")
    site.goto(page, "/flow")
    page.wait_for_timeout(2200)
    # The deck's sweep slide: the paused run before the cursor enters the frame.
    os.makedirs(SCREENS_DIR, exist_ok=True)
    page.screenshot(path=os.path.join(SCREENS_DIR, "flow-paused.png"))
    site.hover_boxes(page, [page.get_by_text("Waiting on you", exact=False).first], hold=1600)
    site.click(page, page.get_by_role("tab", name="Timeline"), hold=3200)
    gate = page.locator(".tr-node", has_text="household_decision")
    if gate.count():
        site.click(page, gate, hold=3600)
    else:
        page.wait_for_timeout(2000)
    return site.finish(b, ctx, page, "sweep-paused")


def beat_home(site: Site, pw) -> str:
    b, ctx, page = site.context(pw, "home")
    site.goto(page, "/")
    page.wait_for_timeout(1500)
    site.hover_boxes(page, [page.get_by_text("days since", exact=False).first, page.get_by_text("Decisions pending", exact=False).first, page.get_by_text("Last night's sweep", exact=False).first], hold=1900)
    page.wait_for_timeout(1500)
    return site.finish(b, ctx, page, "home")


def beat_decision(site: Site, pw) -> str:
    b, ctx, page = site.context(pw, "decision")
    site.goto(page, "/decisions")
    page.wait_for_timeout(2200)
    why = page.get_by_text("Why Guardian thinks this is yours", exact=False)
    if why.count():
        site.click(page, why, hold=4000)
    primary = page.locator(".g-btn--critical").first
    site.hover_boxes(page, [page.get_by_text("No longer own it", exact=False).first, page.get_by_text("Not mine", exact=False).first], hold=700)
    site.click(page, primary, hold=1200)
    page.get_by_text("Remedy requested", exact=False).first.wait_for(timeout=15000)
    page.wait_for_timeout(5000)
    return site.finish(b, ctx, page, "decision")


def beat_after(site: Site, pw) -> str:
    b, ctx, page = site.context(pw, "after")
    site.goto(page, "/flow")
    page.wait_for_timeout(2400)
    site.hover_boxes(page, [page.get_by_text("Completed in", exact=False).first], hold=1600)
    site.click(page, page.get_by_role("tab", name="Timeline"), hold=3600)
    site.goto(page, "/activity", settle=1400)
    page.wait_for_timeout(3800)
    return site.finish(b, ctx, page, "after")


# ------------------------------------------------------------------------------------------------ screenshots for the deck
def screens(site: Site) -> None:
    from playwright.sync_api import sync_playwright  # type: ignore

    os.makedirs(SCREENS_DIR, exist_ok=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1, locale="en-US", timezone_id="America/New_York")
        if site.token:
            ctx.add_cookies([{"name": "guardian_token", "value": site.token, "url": site.base}])
        page = ctx.new_page()
        for path, name, prep in (
            ("/", "home.png", None),
            ("/inventory", "inventory.png", lambda: page.get_by_role("button", name="NURSH", exact=False).first.click()),
            ("/decisions", "decisions.png", None),
            # The paused-run capture belongs to the recording (beat_sweep_paused); `screens` only refreshes it while a run waits.
            *([("/flow", "flow-paused.png", lambda: page.locator(".tr-node", has_text="household_decision").first.click(force=True) if page.locator(".tr-node", has_text="household_decision").count() else None)] if site.api("/api/summary").get("agent_status") == "pending" else []),
            ("/activity", "activity.png", None),
        ):
            page.goto(site.base + path, wait_until="networkidle")
            page.wait_for_timeout(1500)
            if prep:
                try:
                    prep()
                    page.wait_for_timeout(1200)
                except Exception as e:  # noqa: BLE001
                    say(f"  ({name}: prep skipped: {e})")
            page.screenshot(path=os.path.join(SCREENS_DIR, name))
            say(f"screen {name}")
        ctx.close()
        mob = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, locale="en-US", timezone_id="America/New_York")
        if site.token:
            mob.add_cookies([{"name": "guardian_token", "value": site.token, "url": site.base}])
        mp = mob.new_page()
        mp.goto(site.base + "/decisions?scheme=dark", wait_until="networkidle")
        mp.wait_for_timeout(1800)
        mp.screenshot(path=os.path.join(SCREENS_DIR, "decisions-mobile-dark.png"))
        say("screen decisions-mobile-dark.png")
        browser.close()


# ------------------------------------------------------------------------------------------------ record
def reset_target(site: Site) -> None:
    if site.base.startswith("http://127.0.0.1") or site.base.startswith("http://localhost"):
        say("reset: local server; stop it, run `guardian seed --no-case-studies --data <dir>`, clear its runs dir, start it with --no-schedule")
        return
    say("reset: live server over SSM (stop, purge, seed, start)")
    script = (
        "systemctl stop guardian; set -a; . /etc/guardian/env; set +a; cd /opt/guardian/app && "
        "sudo -E -u guardian /opt/guardian/venv/bin/python -c \"import os, shutil\nfrom guardian.service import Guardian\nfrom guardian.state_sync import push_all\n"
        "g, _ = Guardian.build(with_gren_app=False)\ng.store.reset()\nshutil.rmtree(g.run_store.root, ignore_errors=True); os.makedirs(g.run_store.root, exist_ok=True)\n"
        "print(push_all(g._sync_targets))\" && sudo -E -u guardian /opt/guardian/venv/bin/guardian seed --no-case-studies && systemctl start guardian && sleep 3 && curl -sS http://127.0.0.1:8787/api/health"
    )
    subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "deploy_ec2.py"), "run", script], check=True)


def record(site: Site, skip_sweep: bool) -> dict[str, str]:
    from playwright.sync_api import sync_playwright  # type: ignore

    clips: dict[str, str] = {}
    with sync_playwright() as pw:
        summary = site.api("/api/summary")
        say(f"site: {site.base} · provider {summary.get('provider', {}).get('label')} · items {summary.get('items_watched')} · pending {summary.get('decisions_pending')}")
        clips["inventory"] = beat_inventory(site, pw)
        if not skip_sweep:
            clips["sweep-start"] = beat_sweep_start(site, pw)
            say("waiting for the sweep to reach the household gate (up to 12 minutes)…")
            v = site.wait_until(lambda s: s.get("agent_status") == "pending" or (s.get("last_sweep", {}).get("status") in ("failed", "completed")), 720, label="the gate")
            st = v.get("last_sweep", {}).get("status")
            if v.get("agent_status") != "pending":
                raise RuntimeError(f"the sweep ended with status {st} and nothing to decide; the demo needs a matched recall")
        clips["sweep-paused"] = beat_sweep_paused(site, pw)
        clips["home"] = beat_home(site, pw)
        clips["decision"] = beat_decision(site, pw)
        say("waiting for the run to finish remedy and follow-up (up to 6 minutes)…")
        site.wait_until(lambda s: s.get("last_sweep", {}).get("status") in ("completed", "failed") and s.get("agent_status") != "working", 360, label="completion")
        clips["after"] = beat_after(site, pw)
    with open(os.path.join(OUT, "clips.json"), "w", encoding="utf-8") as f:
        json.dump(clips, f, indent=1)
    return clips


# ------------------------------------------------------------------------------------------------ assemble
def duration_of(path: str) -> float:
    out = subprocess.run([ffmpeg(), "-i", path], capture_output=True, text=True)
    for line in out.stderr.splitlines():
        if "Duration:" in line:
            hms = line.split("Duration:")[1].split(",")[0].strip()
            h, m, s = hms.split(":")
            return int(h) * 3600 + int(m) * 60 + float(s)
    return 0.0


def encode_still(png: str, seconds: float, out: str) -> None:
    subprocess.run([ffmpeg(), "-y", "-loglevel", "error", "-loop", "1", "-framerate", str(FPS), "-t", f"{seconds:.2f}", "-i", png, "-vf", f"scale={W}:{H},format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-r", str(FPS), "-an", out], check=True)


def encode_clip(webm: str, out: str, cap: float | None = None) -> float:
    args = [ffmpeg(), "-y", "-loglevel", "error", "-i", webm]
    if cap:
        args += ["-t", f"{cap:.2f}"]
    args += ["-vf", f"scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=0x000F08,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-r", str(FPS), "-an", out]
    subprocess.run(args, check=True)
    return duration_of(out)


XFADE = 0.7  # seconds of crossfade between two blocks
XFADE_CUT = 1.2  # a longer dissolve where minutes are cut between two live clips
FADE_IN, FADE_OUT = 0.8, 1.2


def assemble() -> None:
    """Slides and clips become one MP4. Every boundary is a crossfade (a hard cut from a slide into a live page was
    unreadable); the video fades in from black and out to black. The timeline records where each block is fully on
    screen, and the script is written from it."""
    segs_dir = os.path.join(OUT, "segments")
    os.makedirs(segs_dir, exist_ok=True)
    clips_path = os.path.join(OUT, "clips.json")
    clips: dict[str, str] = json.load(open(clips_path, encoding="utf-8")) if os.path.isfile(clips_path) else {}
    order: list[dict[str, Any]] = []  # {id, kind, file, seconds, notes?}
    n = 0
    for i, s in enumerate(SLIDES, 1):
        png = os.path.join(SLIDES_DIR, f"{i:02d}-{s['id']}.png")
        if not os.path.isfile(png):
            raise SystemExit(f"missing {png}; run `slides` first")
        n += 1
        seg = os.path.join(segs_dir, f"{n:02d}-{s['id']}.mp4")
        encode_still(png, s["seconds"], seg)
        order.append({"id": s["id"], "kind": "slide", "file": seg, "seconds": float(s["seconds"]), "notes": s["notes"]})
        clip_key = s.get("clip")
        if clip_key:
            keys = {"sweep": ["sweep-start", "sweep-paused"]}.get(clip_key, [clip_key])
            found = [k for k in keys if k in clips]
            for k in found:
                n += 1
                seg = os.path.join(segs_dir, f"{n:02d}-{k}.mp4")
                d = encode_clip(clips[k], seg)
                order.append({"id": k, "kind": "clip", "file": seg, "seconds": d})
            if not found:
                say(f"  (no clip recorded for {clip_key}; the slide stands alone)")
    # Crossfade chain: offset_i is where block i starts to fade in on the output's clock.
    args = [ffmpeg(), "-y", "-loglevel", "error"]
    for o in order:
        args += ["-i", o["file"]]
    last = len(order) - 1
    parts = [f"[0:v]fade=t=in:st=0:d={FADE_IN}[v0]"]
    parts.append(f"[{last}:v]fade=t=out:st={max(0.0, order[last]['seconds'] - FADE_OUT):.2f}:d={FADE_OUT}[vl]")
    prev = "[v0]"
    offset = 0.0
    timeline: list[dict[str, Any]] = []
    for i, o in enumerate(order):
        if i == 0:
            timeline.append({"start": 0.0, "id": o["id"], "kind": o["kind"], **({"notes": o["notes"]} if "notes" in o else {})})
            continue
        dur = XFADE_CUT if (o["kind"] == "clip" and order[i - 1]["kind"] == "clip") else XFADE
        offset = offset + order[i - 1]["seconds"] - dur
        src = "[vl]" if i == last else f"[{i}:v]"
        out = f"[x{i}]"
        parts.append(f"{prev}{src}xfade=transition=fade:duration={dur}:offset={offset:.2f}{out}")
        prev = out
        timeline.append({"start": round(offset + dur / 2, 1), "id": o["id"], "kind": o["kind"], **({"notes": o["notes"]} if "notes" in o else {})})
    if len(order) == 1:
        prev = "[v0]"
    total = offset + order[last]["seconds"]
    for i, seg in enumerate(timeline):
        seg["end"] = round(timeline[i + 1]["start"], 1) if i + 1 < len(timeline) else round(total, 1)
    final = os.path.join(OUT, "guardian-demo.mp4")
    args += ["-filter_complex", ";".join(parts), "-map", prev, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-r", str(FPS), "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", final]
    subprocess.run(args, check=True)
    total = duration_of(final)
    with open(os.path.join(OUT, "timeline.json"), "w", encoding="utf-8") as f:
        json.dump({"total_seconds": round(total, 1), "crossfade_seconds": XFADE, "segments": timeline}, f, indent=1)
    write_script(timeline, total)
    say(f"video: {final} ({total:.0f} s = {int(total // 60)}:{int(total % 60):02d})")


def mmss(t: float) -> str:
    return f"{int(t // 60)}:{int(t % 60):02d}"


def slide_label(s: dict[str, Any]) -> str:
    return s.get("h2") or s.get("h1") or s.get("quote", "").split(".")[0]


CLIP_TEXT = {
    "inventory": "the Inventory page; the cursor opens the Boon NURSH bottles: receipt, warranty bar, recall checks (not yet swept)",
    "sweep-start": "the Agent flow tab; one click on Run sweep now, then the graph fills in node by node",
    "sweep-paused": "the run paused at the household gate: the amber banner, the Timeline tab with the human wait, the gate node",
    "home": "the Home page: quiet score 0, decisions pending, last night's sweep",
    "decision": "the Decisions page: the critical card, the rationale, one tap on the remedy button, then Remedy requested",
    "after": "the Agent flow after the approval: completed, the Timeline with the human wait; then the Activity log",
}


def write_script(timeline: list[dict[str, Any]], total: float) -> None:
    by_id = {s["id"]: s for s in SLIDES}
    # One row per spoken block: a slide on its own, or a demo title card with the live clips that follow it.
    rows: list[dict[str, Any]] = []
    for seg in timeline:
        if seg["kind"] == "slide":
            s = by_id[seg["id"]]
            card = s.get("clip") is not None
            on = f"Title card ({seg['end'] - seg['start']:.0f} s): {slide_label(s)}." if card else f"Slide: {slide_label(s)}"
            rows.append({"start": seg["start"], "end": seg["end"], "on": [on], "say": s["notes"]})
        else:
            rows[-1]["end"] = seg["end"]
            rows[-1]["on"].append(f"Live ({seg['end'] - seg['start']:.0f} s): {CLIP_TEXT.get(seg['id'], seg['id'])}.")
    lines = [
        "# Demo video script",
        "",
        f"The video is `var/demo/guardian-demo.mp4` ({mmss(total)}). Record the voice-over against these timecodes. Each row is one block of the video. Speak the text in the last column while the block is on screen. A comfortable pace is about 3.5 syllables a second. The pace column shows the words in the block, the syllable rate that fills the block, and the equivalent words a minute.",
        "",
        "| Time | On screen | Pace | Say |",
        "|---|---|---|---|",
    ]
    fast: list[str] = []
    for r in rows:
        secs = max(0.1, r["end"] - r["start"])
        words = len(r["say"].split())
        wpm = words / secs * 60
        if sum(syllables(w) for w in r["say"].split()) / secs > 3.8:
            fast.append(f"{mmss(r['start'])} ({wpm:.0f} wpm)")
        sps = sum(syllables(w) for w in r["say"].split()) / secs
        pace = f"{words} words · {sps:.1f} syl/s · {wpm:.0f} wpm" + (" · fast" if sps > 3.8 else "")
        lines.append(f"| {mmss(r['start'])}–{mmss(r['end'])} | {' '.join(r['on'])} | {pace} | {r['say']} |")
    lines += [
        "",
        "## Notes for the recording",
        "",
        "- Start each line when its block appears. Over a live clip, keep talking. Pause for a beat when the cursor clicks.",
        "- Every boundary is a crossfade of about a second; the timecodes mark the middle of each dissolve. The sweep block has two clips: the start (about 30 seconds of nodes as they light up) and the paused run; a longer dissolve stands for the minutes cut between them.",
        "- The numbers on the problem slide and on the sweep slide come from the real first sweep of 2026-09-13. `var/demo/timeline.json` has the exact segment boundaries.",
        "- To record the video again: `python scripts/record_demo.py all --reset` against the live site. The timecodes change with the clip lengths, so read the new table.",
        "- To add the voice-over: record it as one file (WAV or M4A) against the video, then run `python scripts/record_demo.py mux narration.wav`. The result is `var/demo/guardian-demo-final.mp4`.",
    ]
    if fast:
        lines.append(f"- Blocks above 3.8 syllables a second: {', '.join(fast)}. Cut words or lengthen the block before you record.")
    os.makedirs(os.path.join(ROOT, "docs"), exist_ok=True)
    with open(os.path.join(ROOT, "docs", "DEMO_SCRIPT.md"), "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    say("script: docs/DEMO_SCRIPT.md" + (f" (fast blocks: {len(fast)})" if fast else ""))


def mux(audio: str) -> None:
    """Lay the recorded voice-over under the assembled video. Audio shorter than the video is padded with silence; longer audio is cut."""
    video = os.path.join(OUT, "guardian-demo.mp4")
    if not os.path.isfile(video):
        raise SystemExit("no var/demo/guardian-demo.mp4; run `assemble` first")
    if not os.path.isfile(audio):
        raise SystemExit(f"no such audio file: {audio}")
    final = os.path.join(OUT, "guardian-demo-final.mp4")
    subprocess.run([ffmpeg(), "-y", "-loglevel", "error", "-i", video, "-i", audio, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-af", "apad", "-shortest", "-movflags", "+faststart", final], check=True)
    say(f"final: {final} ({mmss(duration_of(final))})")


HTML = '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n<title>Guardian narration prompter</title>\n<link href="https://fonts.googleapis.com/css2?family=Lora:wght@500;600&family=Roboto+Slab:wght@600;700&display=swap" rel="stylesheet">\n<style>\n:root { --ink:#000F08; --paper:#F7F4F3; --dim:#5f6b66; --amber:#FCBA04; --blue:#2274A5; --red:#E0463A; --green:#3FBF7F; --size:46px; }\nhtml,body { margin:0; height:100%; background:var(--ink); color:var(--paper); font-family:Lora,Georgia,serif; overflow:hidden; }\n#top { position:fixed; inset:0 0 auto 0; height:64px; display:flex; align-items:center; gap:22px; padding:0 24px; font-family:\'Roboto Slab\',serif; font-size:22px; background:rgba(0,15,8,.92); border-bottom:1px solid #1f2b25; z-index:5; }\n#clock { font-size:34px; font-weight:700; min-width:230px; font-variant-numeric:tabular-nums; }\n#blockno { color:var(--amber); }\n#pace { color:#B9C3BD; font-size:18px; }\n#hint { margin-inline-start:auto; color:#8a948f; font-size:14px; font-family:Lora,serif; }\n#bar { position:fixed; top:64px; left:0; height:5px; background:var(--blue); width:0; z-index:5; }\n#blockbar { position:fixed; top:69px; left:0; height:3px; background:var(--amber); width:0; z-index:5; }\n#stage { position:fixed; top:80px; bottom:0; left:0; right:0; display:grid; grid-template-columns:minmax(0,1fr) 0; transition:grid-template-columns .2s; }\n#stage.video { grid-template-columns:minmax(0,1fr) 34vw; }\n#text { padding:22px 5vw 40px; overflow:hidden; display:flex; flex-direction:column; justify-content:center; gap:34px; }\n#cur { font-size:var(--size); line-height:1.42; font-weight:500; letter-spacing:.005em; }\n#cur .w { color:#3a4540; transition:color .12s; }\n#cur .w.said { color:var(--paper); }\n#cur .w.now { color:var(--amber); text-decoration:underline; text-decoration-color:var(--amber); text-underline-offset:.16em; }\n#next { font-size:calc(var(--size) * .5); line-height:1.4; color:#6e7a75; border-top:1px solid #22302a; padding-top:22px; }\n#next b { color:#9aa6a0; font-family:\'Roboto Slab\',serif; font-weight:600; font-size:.7em; letter-spacing:.08em; text-transform:uppercase; display:block; margin-bottom:8px; }\n#cue { font-family:\'Roboto Slab\',serif; font-size:19px; color:var(--amber); letter-spacing:.06em; text-transform:uppercase; }\n#cue span { color:#B9C3BD; text-transform:none; letter-spacing:0; font-family:Lora,serif; font-size:19px; }\n#vid { background:#000; display:flex; align-items:center; justify-content:center; border-left:1px solid #1f2b25; }\n#vid video { width:100%; max-height:100%; }\n#count { position:fixed; inset:0; display:none; align-items:center; justify-content:center; font-family:\'Roboto Slab\',serif; font-size:260px; font-weight:700; color:var(--amber); background:rgba(0,15,8,.85); z-index:9; }\n#count.on { display:flex; }\n#done { display:none; font-family:\'Roboto Slab\',serif; font-size:56px; color:var(--green); }\nbody.mirror #text { transform:scaleX(-1); }\n</style></head>\n<body>\n<div id="top"><div id="clock">0:00.0 / 0:00</div><div id="blockno">block 1 / 13</div><div id="pace"></div><div id="hint">Space start/pause · R restart · ←/→ block · + − size · V video · M mirror · F fullscreen</div></div>\n<div id="bar"></div><div id="blockbar"></div>\n<div id="stage">\n  <div id="text"><div id="cue"></div><div id="cur"></div><div id="done">End. Stop the recording.</div><div id="next"></div></div>\n  <div id="vid"><video id="video" muted playsinline preload="auto" src="__VIDEO__"></video></div>\n</div>\n<div id="count">3</div>\n<script>\nconst BLOCKS = __BLOCKS__;\nconst TOTAL = __TOTAL__;\nconst LEAD = 0.35;   // seconds after a block starts before the first word is due (the dissolve settles)\nconst TAIL = 0.92;   // words are paced to finish at 92% of the block, leaving a breath before the next cut\nconst TICK = 1 / 30;\nfor (const b of BLOCKS) { b.cum = []; let acc = 0; for (const w of b.weights) { acc += w; b.cum.push(acc); } }\nlet t = 0, playing = false, last = null, raf = null, size = 46, useVideo = false;\nconst video = document.getElementById(\'video\');\nconst curEl = document.getElementById(\'cur\'), nextEl = document.getElementById(\'next\'), cueEl = document.getElementById(\'cue\');\nconst clockEl = document.getElementById(\'clock\'), blockEl = document.getElementById(\'blockno\'), paceEl = document.getElementById(\'pace\');\nconst bar = document.getElementById(\'bar\'), bbar = document.getElementById(\'blockbar\'), doneEl = document.getElementById(\'done\');\nconst mmss = s => { s = Math.max(0, s); const m = Math.floor(s / 60), r = s - m * 60; return m + \':\' + (r < 10 ? \'0\' : \'\') + r.toFixed(1); };\nconst mmssI = s => { const m = Math.floor(s / 60), r = Math.round(s - m * 60); return m + \':\' + (r < 10 ? \'0\' : \'\') + r; };\nlet shown = -1;\nfunction blockAt(time) { for (let i = BLOCKS.length - 1; i >= 0; i--) if (time >= BLOCKS[i].start) return i; return 0; }\nfunction renderBlock(i) {\n  const b = BLOCKS[i];\n  curEl.innerHTML = b.words.map((w, k) => `<span class="w" data-k="${k}">${w}</span>`).join(\' \');\n  const n = BLOCKS[i + 1];\n  nextEl.innerHTML = n ? `<b>Next · ${mmssI(n.start)} · ${n.on}</b>${n.text}` : \'<b>Last block</b>\';\n  cueEl.innerHTML = `${mmssI(b.start)}–${mmssI(b.end)} <span>· ${b.on}</span>`;\n  blockEl.textContent = `block ${i + 1} / ${BLOCKS.length}`;\n  paceEl.textContent = `${b.words.length} words · ${(b.syllables / (b.end - b.start)).toFixed(1)} syllables/s · ${Math.round(b.words.length / (b.end - b.start) * 60)} wpm`;\n  shown = i;\n}\nfunction render() {\n  const i = blockAt(t);\n  if (i !== shown) renderBlock(i);\n  const b = BLOCKS[i];\n  const span = (b.end - b.start) * TAIL - LEAD;\n  const frac = Math.min(1, Math.max(0, (t - b.start - LEAD) / Math.max(0.1, span)));\n  const total = b.cum[b.cum.length - 1]; let due = 0; while (due < b.words.length && b.cum[due] <= frac * total) due++;\n  const spans = curEl.children;\n  for (let k = 0; k < spans.length; k++) { spans[k].className = \'w\' + (k < due ? \' said\' : \'\') + (k === due ? \' now\' : \'\'); }\n  clockEl.textContent = mmss(t) + \' / \' + mmssI(TOTAL);\n  bar.style.width = (100 * Math.min(1, t / TOTAL)) + \'%\';\n  bbar.style.width = (100 * Math.min(1, Math.max(0, (t - b.start) / (b.end - b.start)))) + \'%\';\n  doneEl.style.display = t >= TOTAL ? \'block\' : \'none\';\n}\nfunction loop(now) {\n  if (!playing) return;\n  if (useVideo && !video.paused && !video.ended) t = video.currentTime;\n  else { if (last != null) t += (now - last) / 1000; }\n  last = now;\n  if (t >= TOTAL) { t = TOTAL; playing = false; if (useVideo) video.pause(); }\n  render();\n  if (playing) raf = requestAnimationFrame(loop);\n}\nfunction play() { if (playing) return; playing = true; last = null; if (useVideo) { video.currentTime = t; video.play().catch(() => {}); } raf = requestAnimationFrame(loop); }\nfunction pause() { playing = false; last = null; if (raf) cancelAnimationFrame(raf); if (useVideo) video.pause(); render(); }\nfunction seek(time) { t = Math.max(0, Math.min(TOTAL, time)); if (useVideo) video.currentTime = t; render(); }\nfunction countdown(n, then) { const c = document.getElementById(\'count\'); c.textContent = n; c.classList.add(\'on\'); if (n <= 1) { setTimeout(() => { c.classList.remove(\'on\'); then(); }, 1000); } else setTimeout(() => countdown(n - 1, then), 1000); }\ndocument.addEventListener(\'keydown\', e => {\n  if (e.code === \'Space\') { e.preventDefault(); if (playing) pause(); else if (t <= 0.01) countdown(3, play); else play(); }\n  else if (e.key === \'r\' || e.key === \'R\') { pause(); seek(0); shown = -1; render(); }\n  else if (e.key === \'ArrowRight\') { const i = blockAt(t); seek(BLOCKS[Math.min(BLOCKS.length - 1, i + 1)].start); }\n  else if (e.key === \'ArrowLeft\') { const i = blockAt(t); const b = BLOCKS[i]; seek(t - b.start > 1.5 ? b.start : BLOCKS[Math.max(0, i - 1)].start); }\n  else if (e.key === \'+\' || e.key === \'=\') { size = Math.min(80, size + 4); document.documentElement.style.setProperty(\'--size\', size + \'px\'); }\n  else if (e.key === \'-\' || e.key === \'_\') { size = Math.max(24, size - 4); document.documentElement.style.setProperty(\'--size\', size + \'px\'); }\n  else if (e.key === \'v\' || e.key === \'V\') { document.getElementById(\'stage\').classList.toggle(\'video\'); }\n  else if (e.key === \'m\' || e.key === \'M\') { document.body.classList.toggle(\'mirror\'); }\n  else if (e.key === \'f\' || e.key === \'F\') { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); }\n});\nvideo.addEventListener(\'loadedmetadata\', () => { useVideo = true; document.getElementById(\'stage\').classList.add(\'video\'); });\nvideo.addEventListener(\'error\', () => { useVideo = false; });\nrenderBlock(0); render();\n</script></body></html>\n'

SPOKEN_SYLLABLES = {"cpsc": 4, "nhtsa": 5, "openfda": 5, "vin": 1, "upc": 3, "sms": 3, "sdk": 3, "api": 3, "multiagentbase": 6, "graphbuilder": 3, "and-join": 2}


def syllables(word: str) -> int:
    """A count good enough to pace a reader: vowel groups, silent e, digits read out."""
    w = word.lower().strip(".,;:!?()'\"")
    if not w:
        return 0
    if w in SPOKEN_SYLLABLES:
        return SPOKEN_SYLLABLES[w]
    letters = re.sub(r"[^a-z]", "", w)
    if not letters:
        return max(1, len(re.sub(r"[^0-9]", "", w)) * 2)
    n = len(re.findall(r"[aeiouy]+", letters))
    if letters.endswith("e") and not letters.endswith(("le", "ee", "ye")) and n > 1:
        n -= 1
    if letters.endswith("ed") and n > 1 and not letters.endswith(("ted", "ded")):
        n -= 1
    return max(1, n)


def word_weights(text: str) -> list[float]:
    """Pacing weight of each word: its syllables plus a breath after punctuation (comma, colon, sentence end)."""
    out: list[float] = []
    for w in text.split():
        wt = float(syllables(w))
        if w.endswith((".", "!", "?")):
            wt += 1.6
        elif w.endswith((":", ";")):
            wt += 1.2
        elif w.endswith(","):
            wt += 0.6
        out.append(wt)
    return out


def prompter() -> str:
    """docs/teleprompter.html: the narration paced to the assembled timeline, with the video muted beside it. Open it in a
    browser (file://), press Space for a 3-2-1 count, and read the highlighted words; the pace is the block's own wpm."""
    tl_path = os.path.join(OUT, "timeline.json")
    if not os.path.isfile(tl_path):
        raise SystemExit("no var/demo/timeline.json; run `assemble` first")
    tl = json.load(open(tl_path, encoding="utf-8"))
    by_id = {s["id"]: s for s in SLIDES}
    blocks: list[dict[str, Any]] = []
    for seg in tl["segments"]:
        if seg["kind"] == "slide":
            s = by_id[seg["id"]]
            on = ("Title card, then live: " + CLIP_TEXT.get(s.get("clip", ""), "")) if s.get("clip") else f"Slide: {slide_label(s)}"
            if s.get("clip") == "sweep":
                on = "Title card, then live: the sweep starts; then the paused run"
            blocks.append({"start": seg["start"], "end": seg["end"], "text": s["notes"], "words": s["notes"].split(), "weights": word_weights(s["notes"]), "syllables": sum(syllables(w) for w in s["notes"].split()), "on": on})
        else:
            blocks[-1]["end"] = seg["end"]
    html = HTML.replace("__BLOCKS__", json.dumps(blocks)).replace("__TOTAL__", str(tl["total_seconds"])).replace("__VIDEO__", "../var/demo/guardian-demo.mp4")
    path = os.path.join(ROOT, "docs", "teleprompter.html")
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(html)
    say(f"prompter: {path} ({len(blocks)} blocks, {mmss(tl['total_seconds'])})")
    return path


# ------------------------------------------------------------------------------------------------ main
def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        say(__doc__)
        return 0
    cmd = argv[0]
    opts = argv[1:]

    def opt(name: str, default: str | None = None) -> str | None:
        if name in opts:
            i = opts.index(name)
            return opts[i + 1] if i + 1 < len(opts) else default
        return default

    base = opt("--base-url", os.environ.get("GUARDIAN_URL") or "")
    token = None if "--no-token" in opts else opt("--token", os.environ.get("GUARDIAN_API_TOKEN") or None)
    site = Site(base, token, "--headed" in opts)
    os.makedirs(OUT, exist_ok=True)
    if cmd in ("slides", "all"):
        render_slides()
    if cmd == "screens":
        screens(site)
    if cmd in ("record", "all"):
        if not base:
            raise SystemExit("--base-url or GUARDIAN_URL is required")
        if "--reset" in opts:
            reset_target(site)
        record(site, "--skip-sweep" in opts)
    if cmd in ("assemble", "all"):
        assemble()
    if cmd in ("prompter", "assemble", "all"):
        prompter()
    if cmd == "mux":
        if not opts:
            raise SystemExit("usage: record_demo.py mux <audio file>")
        mux(opts[0])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
