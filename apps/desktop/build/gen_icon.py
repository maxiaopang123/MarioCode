"""Generate every MarioCode icon from code (no source artwork needed).

Two variants of the same geometric M (graphite strokes + sage-mint diagonal):
  - dark  (A): graphite rounded tile, near-white M, mint gradient diagonal.
               Used for the APP icon everywhere the OS draws it (taskbar,
               installer, exe, dock, notifications) and the dark-theme logo.
  - light (C): white→mist tile with a hairline border, graphite M, mint
               diagonal. Used for the in-app logo under the light theme.

The geometry matches build/icon-dark.svg / build/icon-light.svg (1024 space):
tile x/y 32..992, rx 224; strokes 124 wide with round caps/joins;
left stem (318,330)->(318,694), left diagonal (318,330)->(512,620),
mint diagonal (512,620)->(706,330), right stem (706,330)->(706,694).
Rendered at 4x and downscaled so edges are anti-aliased while everything
outside the tile stays fully transparent.

Outputs:
  build/icon-source.png, build/icon-source-light.png   1024 masters
  build/icon.png (1024), build/icon.ico, build/icon.icns   app icon (dark)
  src/renderer/brand-logo.png        in-app logo, dark theme
  src/renderer/brand-logo-light.png  in-app logo, light theme
  src/renderer/favicon.png (64)      dark

Run from the repo root:
    python apps/desktop/build/gen_icon.py
"""
from __future__ import annotations

import struct
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw

OUT_DIR = Path(__file__).resolve().parent
RENDERER_DIR = OUT_DIR.parent / "src" / "renderer"
SIZE = 1024
SS = 4  # supersampling factor
BIG = SIZE * SS

TILE = (32, 32, 992, 992)
RADIUS = 224
STROKE = 124
LEFT = [(318, 330), (318, 694)]
LEFT_DIAG = [(318, 330), (512, 620)]
MINT_DIAG = [(512, 620), (706, 330)]
RIGHT = [(706, 330), (706, 694)]

VARIANTS = {
    "dark": {
        "bg_top": (0x2B, 0x3F, 0x39),
        "bg_bottom": (0x15, 0x20, 0x1D),
        "ink": (0xF4, 0xF7, 0xF5),
        # mint gradient along the diagonal: light at the top-right end,
        # deeper at the bottom-left end
        "mint_top": (0xB5, 0xEB, 0xCF),
        "mint_bottom": (0x7F, 0xD1, 0xA8),
        "shine": True,
        "border": None,
    },
    "light": {
        "bg_top": (0xFF, 0xFF, 0xFF),
        "bg_bottom": (0xEA, 0xF1, 0xED),
        "ink": (0x22, 0x33, 0x2E),
        "mint_top": (0x6F, 0xBF, 0x97),
        "mint_bottom": (0x6F, 0xBF, 0x97),
        "shine": False,
        "border": ((0xD5, 0xE0, 0xDA), 6),
    },
}


def _s(v: float) -> int:
    return int(round(v * SS))


def _vertical_gradient(top, bottom, y0: float, y1: float) -> Image.Image:
    """BIG×BIG RGB image: `top` above y0, `bottom` below y1, linear between."""
    strip = Image.new("RGB", (1, BIG))
    px = strip.load()
    a, b = _s(y0), _s(y1)
    for y in range(BIG):
        t = 0.0 if y <= a else 1.0 if y >= b else (y - a) / max(1, b - a)
        px[0, y] = tuple(int(top[i] * (1 - t) + bottom[i] * t) for i in range(3))
    return strip.resize((BIG, BIG), Image.NEAREST)


def _tile_mask() -> Image.Image:
    mask = Image.new("L", (BIG, BIG), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [_s(TILE[0]), _s(TILE[1]), _s(TILE[2]) - 1, _s(TILE[3]) - 1],
        radius=_s(RADIUS), fill=255,
    )
    return mask


def _stroke_mask(*polylines) -> Image.Image:
    """Round-capped, round-joined thick polylines as an L mask."""
    mask = Image.new("L", (BIG, BIG), 0)
    d = ImageDraw.Draw(mask)
    w = _s(STROKE)
    r = w / 2
    for line in polylines:
        pts = [(_s(x), _s(y)) for x, y in line]
        d.line(pts, fill=255, width=w)
        for x, y in pts:
            d.ellipse([x - r, y - r, x + r, y + r], fill=255)
    return mask


def render(variant: str) -> Image.Image:
    v = VARIANTS[variant]
    img = Image.new("RGBA", (BIG, BIG), (0, 0, 0, 0))
    tile = _tile_mask()

    # Tile background.
    img.paste(_vertical_gradient(v["bg_top"], v["bg_bottom"], TILE[1], TILE[3]), (0, 0), tile)

    # Subtle top sheen (dark variant): white 10% → 0 over the top half.
    if v["shine"]:
        sheen_alpha = Image.new("L", (1, BIG))
        px = sheen_alpha.load()
        top, mid = _s(TILE[1]), _s(TILE[1] + (TILE[3] - TILE[1]) / 2)
        for y in range(BIG):
            t = 0.0 if y <= top else 1.0 if y >= mid else (y - top) / (mid - top)
            px[0, y] = int(255 * 0.10 * (1 - t))
        sheen_alpha = sheen_alpha.resize((BIG, BIG), Image.NEAREST)
        sheen_alpha = Image.composite(sheen_alpha, Image.new("L", (BIG, BIG), 0), tile)
        sheen = Image.new("RGBA", (BIG, BIG), (255, 255, 255, 0))
        sheen.putalpha(sheen_alpha)
        img.alpha_composite(sheen)

    # Hairline border (light variant).
    if v["border"]:
        color, width = v["border"]
        ImageDraw.Draw(img).rounded_rectangle(
            [_s(TILE[0]), _s(TILE[1]), _s(TILE[2]) - 1, _s(TILE[3]) - 1],
            radius=_s(RADIUS), outline=color + (255,), width=_s(width),
        )

    ink = Image.new("RGBA", (BIG, BIG), v["ink"] + (255,))
    # 1) left stem + left diagonal
    img.paste(ink, (0, 0), _stroke_mask(LEFT, LEFT_DIAG))
    # 2) mint diagonal (gradient from its top end to its bottom end)
    mint = _vertical_gradient(v["mint_top"], v["mint_bottom"], 330 - STROKE / 2, 620 + STROKE / 2)
    img.paste(mint, (0, 0), _stroke_mask(MINT_DIAG))
    # 3) right stem on top, so it cleanly overlaps the mint stroke's end
    img.paste(ink, (0, 0), _stroke_mask(RIGHT))

    # Keep everything outside the tile fully transparent.
    alpha = Image.composite(img.getchannel("A"), Image.new("L", (BIG, BIG), 0), tile)
    img.putalpha(alpha)
    return img.resize((SIZE, SIZE), Image.LANCZOS)


# ── writers ──────────────────────────────────────────────────────────────────
def write_png(img: Image.Image, path: Path, size: int) -> None:
    img.resize((size, size), Image.LANCZOS).save(path, "PNG", optimize=True)


def _png_bytes(img: Image.Image) -> bytes:
    b = BytesIO()
    img.save(b, format="PNG", optimize=True)
    return b.getvalue()


def write_ico(img: Image.Image, path: Path) -> None:
    """Hand-written multi-size ICO (PIL's writer can collapse sizes)."""
    sizes = [16, 24, 32, 48, 64, 128, 256]
    blobs = [_png_bytes(img.resize((s, s), Image.LANCZOS)) for s in sizes]
    header = struct.pack("<HHH", 0, 1, len(sizes))
    offset = 6 + 16 * len(sizes)
    entries = bytearray()
    for s, blob in zip(sizes, blobs):
        w = 0 if s >= 256 else s
        entries += struct.pack("<BBBBHHII", w, w, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
    with open(path, "wb") as f:
        f.write(header)
        f.write(entries)
        for blob in blobs:
            f.write(blob)


def write_icns(img: Image.Image, path: Path) -> None:
    img.save(path, format="ICNS")


def main() -> None:
    dark = render("dark")
    light = render("light")
    dark.save(OUT_DIR / "icon-source.png", "PNG", optimize=True)
    light.save(OUT_DIR / "icon-source-light.png", "PNG", optimize=True)
    write_png(dark, OUT_DIR / "icon.png", 1024)
    write_ico(dark, OUT_DIR / "icon.ico")
    write_icns(dark, OUT_DIR / "icon.icns")
    write_png(dark, RENDERER_DIR / "brand-logo.png", 512)
    write_png(light, RENDERER_DIR / "brand-logo-light.png", 512)
    write_png(dark, RENDERER_DIR / "favicon.png", 64)
    print("OK: app icon (dark), in-app logos (dark + light), favicon")


if __name__ == "__main__":
    main()
