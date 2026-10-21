"""Generate every MarioCode icon from one AI-generated master image.

Source (2026-10-21): build/icon-ai-source.webp - a terracotta pebble-shaped
blob with a cream single-stroke "M" and a light-orange dot, on an OPAQUE BLACK
background (the image tool gave no alpha). This script cuts the blob out of
the black, centres it on a transparent 1024 canvas and writes every size.

Cut-out: luminance threshold -> mask, eroded ~2px so the anti-aliasing fringe
(blob colour blended with black) is dropped, then a light blur for a soft
edge. Everything outside the blob ends up fully transparent.

Outputs:
  build/icon-source.png (1024 master)
  build/icon.png (1024), build/icon.ico, build/icon.icns   app icon
  src/renderer/brand-logo.png (512)   in-app logo, both themes
  src/renderer/favicon.png (64)
  scripts/update-server/www/site/logo.png (128)   download page logo

Run from the repo root:
    python apps/desktop/build/gen_icon.py
"""
from __future__ import annotations

import struct
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageFilter

OUT_DIR = Path(__file__).resolve().parent
APP_DIR = OUT_DIR.parent
RENDERER_DIR = APP_DIR / "src" / "renderer"
SITE_DIR = APP_DIR / "scripts" / "update-server" / "www" / "site"
SOURCE = OUT_DIR / "icon-ai-source.webp"

SIZE = 1024
BLOB_WIDTH = 980  # blob width on the 1024 canvas (leaves a small margin)
BLACK_THRESHOLD = 40  # luminance below this counts as background
ERODE_SIZE = 5  # MinFilter window: drops ~2px of anti-aliasing fringe
EDGE_BLUR = 1.2


def _blob_mask(rgb: Image.Image) -> Image.Image:
    """Soft alpha mask of the blob inside the black background."""
    mask = rgb.convert("L").point(lambda v: 255 if v > BLACK_THRESHOLD else 0)
    mask = mask.filter(ImageFilter.MinFilter(ERODE_SIZE))
    return mask.filter(ImageFilter.GaussianBlur(EDGE_BLUR))


def render() -> Image.Image:
    rgb = Image.open(SOURCE).convert("RGB")
    rgba = rgb.convert("RGBA")
    rgba.putalpha(_blob_mask(rgb))

    # Crop to the blob, scale to BLOB_WIDTH, centre on a transparent canvas.
    box = rgba.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
    if box is None:
        raise SystemExit(f"no blob found in {SOURCE}")
    blob = rgba.crop(box)
    scale = BLOB_WIDTH / blob.width
    blob = blob.resize(
        (BLOB_WIDTH, round(blob.height * scale)), Image.LANCZOS
    )
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    canvas.alpha_composite(
        blob, ((SIZE - blob.width) // 2, (SIZE - blob.height) // 2)
    )
    return canvas


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
    write_png(icon, SITE_DIR / "logo.png", 128)
    print("OK: app icon, in-app logo, favicon, download-page logo")


if __name__ == "__main__":
    main()
