"""
Pans across the screenshot reel from first to last image with ease-out deceleration.

Usage:
    python 10_screenshot_reel_vid.py

Dependencies:
    pip install opencv-python pillow
"""

import math
import re
import subprocess
import sys
from pathlib import Path

import cv2
from PIL import Image

# --- configurable parameters ---
LAST_IMAGE_INDEX = 108  # 1-based index of last image in sorted list
N_IMAGES = 30         # how many images, counting backward from LAST_IMAGE_INDEX
BORDER_SIDE_PROPORTION = 0.0464       # top/left/right border / content dimension
BORDER_BOTTOM_PROPORTION = 0.1813     # bottom border / content height
SCALE = 0.5
SPACING = 20

VIDEO_WIDTH = 1080
VIDEO_HEIGHT = 1920
FPS = 60
DURATION_SECONDS = None  # auto if None: N_IMAGES * FRAMES_PER_IMAGE / FPS
FRAMES_PER_IMAGE = 20
EASE_EXPONENT = 2.5  # >1 = ease out, 1 = linear
SEED = 42
OUTPUT_DIR = Path(f"reel-frames-{LAST_IMAGE_INDEX - N_IMAGES + 1}-{LAST_IMAGE_INDEX}")
OUTPUT_VIDEO = f"reel-{LAST_IMAGE_INDEX - N_IMAGES + 1}-{LAST_IMAGE_INDEX}.mov"
SCREENSHOTS_DIR = Path(__file__).parent.parent / "strava_data" / "screenshots" / "censored"
# -------------------------------


def ease_out(t, exp):
    return 1 - (1 - t) ** exp


def main():
    all_files = sorted(
        SCREENSHOTS_DIR.glob("*.jpg"),
        key=lambda p: int(re.search(r"-(\d+)", p.stem).group(1)),
    )
    jpg_files = all_files[LAST_IMAGE_INDEX - N_IMAGES : LAST_IMAGE_INDEX]

    if not jpg_files:
        print(f"No .jpg files found in {SCREENSHOTS_DIR}", file=sys.stderr)
        sys.exit(1)

    print(f"Building reel from {len(jpg_files)} images ...")

    raw = []
    for img_path in jpg_files:
        img = cv2.imread(str(img_path))
        if img is None:
            continue

        h, w = img.shape[:2]
        new_w = int(w * SCALE)
        new_h = int(h * SCALE)
        img = cv2.resize(img, (new_w, new_h))
        img_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        pil_img = Image.fromarray(img_rgb).convert("RGBA")

        border_top = int(new_h * BORDER_SIDE_PROPORTION)
        border_bottom = int(new_h * BORDER_BOTTOM_PROPORTION)
        border_left = int(new_w * BORDER_SIDE_PROPORTION)
        border_right = int(new_w * BORDER_SIDE_PROPORTION)

        pw = new_w + border_left + border_right
        ph = new_h + border_top + border_bottom
        bordered = Image.new("RGBA", (pw, ph), (255, 255, 255, 255))
        bordered.paste(pil_img, (border_left, border_top), pil_img)
        raw.append(bordered)

    if not raw:
        print("No valid images loaded", file=sys.stderr)
        sys.exit(1)

    uniform_h = raw[0].height
    uniform_w = int(raw[0].width * (uniform_h / raw[0].height))

    bordered_images = []
    for img in raw:
        scaled_h = uniform_h
        scaled_w = int(img.width * (uniform_h / img.height))
        resized = img.resize((scaled_w, scaled_h), Image.LANCZOS)
        bordered_images.append(resized)

    uniform_w = max(img.width for img in bordered_images)

    total_w = len(bordered_images) * uniform_w + (len(bordered_images) - 1) * SPACING

    if bordered_images:
        trailer = (VIDEO_WIDTH + uniform_w) // 2 + SPACING
        total_w += int(trailer)

    reel = Image.new("RGBA", (total_w, uniform_h), (0, 0, 0, 0))
    x = 0
    for img in bordered_images:
        reel.paste(img, (x, 0), img)
        x += uniform_w + SPACING

    if total_w <= VIDEO_WIDTH:
        print(f"Reel width {total_w} <= viewport {VIDEO_WIDTH}, nothing to pan", file=sys.stderr)
        sys.exit(1)

    scroll_range = total_w - VIDEO_WIDTH

    if DURATION_SECONDS is None:
        duration = math.ceil(N_IMAGES * FRAMES_PER_IMAGE / FPS)
    else:
        duration = DURATION_SECONDS
    total_frames = FPS * duration

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Rendering {total_frames} frames ({duration}s) ...")

    for frame_idx in range(total_frames):
        t = frame_idx / max(total_frames - 1, 1)
        eased = ease_out(t, EASE_EXPONENT)
        offset_x = int(eased * scroll_range)
        crop = reel.crop((offset_x, 0, offset_x + VIDEO_WIDTH, uniform_h))

        frame = Image.new("RGBA", (VIDEO_WIDTH, VIDEO_HEIGHT), (0, 0, 0, 0))
        paste_y = (VIDEO_HEIGHT - uniform_h) // 2
        frame.paste(crop, (0, paste_y), crop)
        frame.save(OUTPUT_DIR / f"frame_{frame_idx:05d}.png")

        if frame_idx % 30 == 0:
            print(f"Frame {frame_idx + 1}/{total_frames}")

    print(f"Done. {total_frames} frames in {OUTPUT_DIR}")

    subprocess.run([
        "ffmpeg", "-y",
        "-framerate", str(FPS),
        "-i", str(OUTPUT_DIR / "frame_%05d.png"),
        "-c:v", "prores_ks",
        "-profile:v", "4444",
        "-pix_fmt", "yuva444p10le",
        OUTPUT_VIDEO,
    ], check=True)
    print(f"Video: {OUTPUT_VIDEO}")


if __name__ == "__main__":
    main()
