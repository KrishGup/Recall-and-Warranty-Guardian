"""Render the PWA icons in web/public from the favicon geometry (web/public/favicon.svg).

The mark is three circles and a ring on a 48-unit grid, so PIL draws it directly; no SVG rasterizer is needed.
Run after a change to the mark: `python scripts/build_pwa_icons.py`.
"""
from __future__ import annotations

import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "web", "public")

INK = "#000F08"
PAPER = "#F7F4F3"
ACCENT = "#FCBA04"
SS = 4  # supersampling factor for smooth edges


def _mark(size: int) -> Image.Image:
    """The round mark on a transparent square, `size` px wide."""
    s = size * SS
    u = s / 48  # one favicon unit

    def circle(draw: ImageDraw.ImageDraw, cx: float, cy: float, r: float, fill: str) -> None:
        draw.ellipse([cx * u - r * u, cy * u - r * u, cx * u + r * u, cy * u + r * u], fill=fill)

    layer = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    circle(d, 24, 24, 24, INK)
    circle(d, 12, 34, 4, ACCENT)
    circle(d, 38, 16, 24, PAPER)

    clip = Image.new("L", (s, s), 0)
    ImageDraw.Draw(clip).ellipse([0, 0, s, s], fill=255)
    layer.putalpha(clip)

    ring = ImageDraw.Draw(layer)
    w = 1.5 * u
    r = 23.25 * u
    ring.ellipse([24 * u - r, 24 * u - r, 24 * u + r, 24 * u + r], outline=PAPER, width=round(w))
    return layer.resize((size, size), Image.LANCZOS)


def _on_ink(size: int, scale: float) -> Image.Image:
    """The mark centred on a solid ink square; `scale` is the mark's share of the width (0.8 keeps the maskable safe zone)."""
    canvas = Image.new("RGBA", (size, size), INK)
    mark = _mark(round(size * scale))
    off = (size - mark.width) // 2
    canvas.alpha_composite(mark, (off, off))
    return canvas


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    for n in (64, 192, 512):
        _mark(n).save(os.path.join(OUT, f"pwa-{n}x{n}.png"))
    _on_ink(512, 0.8).save(os.path.join(OUT, "maskable-icon-512x512.png"))
    _on_ink(180, 0.82).convert("RGB").save(os.path.join(OUT, "apple-touch-icon-180x180.png"))
    print("wrote icons to", OUT)


if __name__ == "__main__":
    main()
