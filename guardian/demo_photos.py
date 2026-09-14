"""Placeholder label photos for the seeded demo/case-study items (the ask: "each of the various items has an
associated photo already provided"). Guardian has no real product photography to ship, so each item gets a small,
clearly-marked-as-a-placeholder SVG "label" generated from its own name/brand/category using the design system's
five brand hexes (design/README.md) - not a real photo, but enough that every item in Inventory shows something
under Receipt instead of the empty thumbnail placeholder.

Generated once per item id under demo/photos/<item_id>.svg (checked into the repo like demo/household.json) and
then attached to the store like any uploaded photo would be. `guardian seed` calls `attach_all` after loading the
household and the case studies.
"""
from __future__ import annotations

import os
from typing import Any

from .service import Guardian

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PHOTOS_DIR = os.path.join(ROOT, "demo", "photos")

# design/README.md section "Palette": the five brand hexes. Category bands cycle through the four non-ink ones.
INK = "#000F08"
PAPER = "#F7F4F3"
CATEGORY_COLOR: dict[str, str] = {
    "Juvenile": "#960200", "Toys": "#960200",
    "Vehicle": "#2274A5", "Electronics": "#2274A5",
    "Kitchen": "#FCBA04", "Appliance": "#FCBA04", "Home": "#FCBA04", "Tools": "#FCBA04",
    "Food": "#4A5551", "Other": "#4A5551",
}


def _wrap(text: str, width: int = 22) -> list[str]:
    words, lines, cur = text.split(), [], ""
    for w in words:
        cand = f"{cur} {w}".strip()
        if len(cand) > width and cur:
            lines.append(cur)
            cur = w
        else:
            cur = cand
    if cur:
        lines.append(cur)
    return lines[:3]


def render_svg(name: str, brand: str, category: str, model_number: str | None) -> bytes:
    band = CATEGORY_COLOR.get(category, "#4A5551")
    band_text = "#FFFFFF" if band != PAPER else INK
    lines = _wrap(name, 22)
    name_svg = "\n".join(f'<text x="30" y="{190 + i * 30}" font-family="Georgia, serif" font-size="22" fill="{INK}">{_esc(line)}</text>' for i, line in enumerate(lines))
    model_line = f'<text x="30" y="{190 + len(lines) * 30 + 26}" font-family="Consolas, monospace" font-size="14" fill="#4A5551">{_esc(model_number)}</text>' if model_number else ""
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">
  <rect width="480" height="360" fill="{PAPER}"/>
  <rect width="480" height="64" fill="{band}"/>
  <text x="30" y="41" font-family="Arial, sans-serif" font-size="15" font-weight="700" letter-spacing="2" fill="{band_text}">{_esc(category.upper())}</text>
  <rect x="0.5" y="0.5" width="479" height="359" fill="none" stroke="{INK}" stroke-opacity="0.15"/>
  <text x="30" y="130" font-family="Georgia, serif" font-size="30" font-weight="700" fill="{INK}">{_esc(brand or "Unbranded")}</text>
  {name_svg}
  {model_line}
  <text x="30" y="330" font-family="Arial, sans-serif" font-size="11" fill="#4A5551">Guardian demo label photo &#183; not the real product</text>
</svg>""".encode("utf-8")


def _esc(s: str | None) -> str:
    if not s:
        return ""
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def photo_path(item_id: str) -> str:
    return os.path.join(PHOTOS_DIR, f"{item_id}.svg")


def ensure_generated(item: dict[str, Any]) -> str:
    """Write demo/photos/<id>.svg if it does not exist yet; return the path either way."""
    p = photo_path(item["id"])
    if not os.path.exists(p):
        os.makedirs(PHOTOS_DIR, exist_ok=True)
        with open(p, "wb") as f:
            f.write(render_svg(item.get("name") or "", item.get("brand") or "", item.get("category") or "Other", item.get("model_number")))
    return p


def attach_all(g: Guardian) -> int:
    """Generate (if needed) and attach a placeholder label photo to every item in the store that doesn't already
    have one. Returns how many were attached."""
    n = 0
    for it in g.store.items(include_disposed=True):
        if it.photo_filename:
            continue
        path = ensure_generated(it.model_dump())
        with open(path, "rb") as f:
            g.save_item_photo(it.id, f.read(), f"{it.id}.svg", "image/svg+xml")
        n += 1
    return n
