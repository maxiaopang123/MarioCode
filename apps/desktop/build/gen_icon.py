"""Generate every MarioCode icon from code (no source artwork needed).

One design everywhere (2026-10-21): a deep-terracotta irregular round blob with
a soft top sheen, a cream single-stroke "flow M" (two arches, one valley) and a
light-orange dot under the valley. The same image is used for the OS app icon
and the in-app logo under both themes - the dark terracotta reads on light and
dark grounds alike, so there is no separate light variant.

Geometry (1024 space; prototypes/icon-options-9.html option 3 is the visual
reference):
  blob  - five cubic segments, left/right asymmetric, smooth at every join
  M     - one stroke, width 52, round caps/joins:
          (252,724) -> (380,296) -> (512,604) -> (644,296) -> (772,724)
  dot   - centre (512,760) r 38
Rendered at 4x and downscaled so edges are anti-aliased while everything
outside the blob stays fully transparent.

Outputs:
  build/icon-source.png (1024 master)
  build/icon.png (1024), build/icon.ico, build/icon.icns   app icon
  src/renderer/brand-logo.png (512)   in-app logo, both themes
  src/renderer/favicon.png (64)

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

# Blob: start point + cubic segments (c1, c2, end).
BLOB_START = (512, 44)
BLOB_SEGMENTS = [
    ((700, 40), (880, 140), (950, 320)),
    ((1010, 470), (990, 650), (900, 790)),
    ((810, 930), (640, 990), (480, 980)),
    ((300, 968), (130, 880), (70, 700)),
    ((20, 550), (40, 380), (130, 250)),
    ((220, 120), (360, 48), (512, 44)),
]
BLOB_Y0, BLOB_Y1 = 40, 985  # vertical extent used by the gradients

BG_TOP = (0xA9, 0x55, 0x3A)
BG_BOTTOM = (0x6C, 0x30, 0x1E)
SHEEN_ALPHA = 0.16  # white, fading to 0 by 55% of the blob's height

# Flow M: one stroke through these cubic segments.
M_START = (252, 724)
M_SEGMENTS = [
    ((252, 560), (280, 296), (380, 296)),
    ((460, 296), (490, 560), (512, 604)),
    ((534, 560), (564, 296), (644, 296)),
    ((744, 296), (772, 560), (772, 724)),
]
M_STROKE = 52
M_COLOR = (0xFF, 0xFD, 0xF8)

DOT = (512, 760, 38)
DOT_COLOR = (0xF0, 0xAA, 0x8A)


def _s(v: float) -> int:
    return int(round(v * SS))


def _sample(start, segments, n: int = 96):
    """Sample chained cubic beziers into one dense point list."""
    pts = [start]
    p0 = start
    for c1, c2, p3 in segments:
        for i in range(1, n + 1):
            t = i / n
            u = 1 - t
            pts.append((
                u**3 * p0[0] + 3 * u**2 * t * c1[0] + 3 * u * t**2 * c2[0] + t**3 * p3[0],
                u**3 * p0[1] + 3 * u**2 * t * c1[1] + 3 * u * t**2 * c2[1] + t**3 * p3[1],
            ))
        p0 = p3
    return pts


def _vertical_gradient(top, bottom, y0: float, y1: float) -> Image.Image:
    """BIG×BIG RGB image: `top` above y0, `bottom` below y1, linear between."""
    strip = Image.new("RGB", (1, BIG))
    px = strip.load()
    a, b = _s(y0), _s(y1)
    for y in range(BIG):
        t = 0.0 if y <= a else 1.0 if y >= b else (y - a) / max(1, b - a)
        px[0, y] = tuple(int(top[i] * (1 - t) + bottom[i] * t) for i in range(3))
    return strip.resize((BIG, BIG), Image.NEAREST)


def _blob_mask() -> Image.Image:
    mask = Image.new("L", (BIG, BIG), 0)
    pts = [(_s(x), _s(y)) for x, y in _sample(BLOB_START, BLOB_SEGMENTS)]
    ImageDraw.Draw(mask).polygon(pts, fill=255)
    return mask


def _stroke_mask() -> Image.Image:
    """The M as a round-capped, round-joined stroke: a disc at every sample."""
    mask = Image.new("L", (BIG, BIG), 0)
    d = ImageDraw.Draw(mask)
    r = _s(M_STROKE) / 2
    for x, y in _sample(M_START, M_SEGMENTS, n=160):
        cx, cy = _s(x), _s(y)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
    return mask


def _dot_mask() -> Image.Image:
    mask = Image.new("L", (BIG, BIG), 0)
    cx, cy, r = DOT
    ImageDraw.Draw(mask).ellipse(
        [_s(cx - r), _s(cy - r), _s(cx + r), _s(cy + r)], fill=255
    )
    return mask


def render() -> Image.Image:
    img = Image.new("RGBA", (BIG, BIG), (0, 0, 0, 0))
    blob = _blob_mask()

    # Terracotta blob.
    img.paste(_vertical_gradient(BG_TOP, BG_BOTTOM, BLOB_Y0, BLOB_Y1), (0, 0), blob)

    # Top sheen: white SHEEN_ALPHA -> 0 over the top 55% of the blob.
    top = _s(BLOB_Y0)
    end = _s(BLOB_Y0 + (BLOB_Y1 - BLOB_Y0) * 0.55)
    sheen = Image.new("L", (1, BIG))
    px = sheen.load()
    for y in range(BIG):
        t = 0.0 if y <= top else 1.0 if y >= end else (y - top) / (end - top)
        px[0, y] = int(255 * SHEEN_ALPHA * (1 - t))
    sheen = sheen.resize((BIG, BIG), Image.NEAREST)
    sheen = Image.composite(sheen, Image.new("L", (BIG, BIG), 0), blob)
    white = Image.new("RGBA", (BIG, BIG), (255, 255, 255, 0))
    white.putalpha(sheen)
    img.alpha_composite(white)

    # Cream flow-M stroke and the light-orange dot.
    img.paste(Image.new("RGB", (BIG, BIG), M_COLOR), (0, 0), _stroke_mask())
    img.paste(Image.new("RGB", (BIG, BIG), DOT_COLOR), (0, 0), _dot_mask())

    # Keep everything outside the blob fully transparent.
    alpha = Image.composite(img.getchannel("A"), Image.new("L", (BIG, BIG), 0), blob)
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
    icon = render()
    icon.save(OUT_DIR / "icon-source.png", "PNG", optimize=True)
    write_png(icon, OUT_DIR / "icon.png", 1024)
    write_ico(icon, OUT_DIR / "icon.ico")
    write_icns(icon, OUT_DIR / "icon.icns")
    write_png(icon, RENDERER_DIR / "brand-logo.png", 512)
    write_png(icon, RENDERER_DIR / "favicon.png", 64)
    print("OK: app icon, in-app logo, favicon")


if __name__ == "__main__":
    main()
