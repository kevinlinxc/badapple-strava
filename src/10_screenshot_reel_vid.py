"""
Pans across the screenshot reel from first to last image with ease-out deceleration.

Usage:
    python 10_screenshot_reel_vid.py <frame_number>

The given frame number is looked up in bad_apple_activities.json. The script then
counts back N_IMAGES entries through the JSON to determine which frame numbers to
include. This handles the variable frame spacing (every 15 before ~2000, every 30 after).

Dependencies:
    pip install opencv-python pillow
"""

import json
import math
import re
import subprocess
import sys
from pathlib import Path

import cv2
from PIL import Image

# --- configurable parameters ---
N_IMAGES = 20
BORDER_SIDE_PROPORTION = 0.0464
BORDER_BOTTOM_PROPORTION = 0.1813
SCALE = 0.5
SPACING = 20

VIDEO_WIDTH = 1080
VIDEO_HEIGHT = 1920
FPS = 60
DURATION_SECONDS = None
FRAMES_PER_IMAGE = 20
EASE_EXPONENT = 2.5
SEED = 42
SCREENSHOTS_DIR = Path(__file__).parent.parent / "strava_data" / "screenshots" / "censored"
ACTIVITIES_JSON = Path(__file__).parent.parent / "polyline_renderer" / "public" / "bad_apple_activities.json"
# -------------------------------


def ease_out(t, exp):
    return 1 - (1 - t) ** exp


def main():
    if len(sys.argv) < 2:
        print("Usage: python 10_screenshot_reel_vid.py <frame_number>", file=sys.stderr)
        sys.exit(1)

    target_frame = int(sys.argv[1])

    with open(ACTIVITIES_JSON) as f:
        activities = json.load(f)

    try:
        target_index = next(i for i, entry in enumerate(activities) if entry["frame"] == target_frame)
    except StopIteration:
        print(f"Frame {target_frame} not found in {ACTIVITIES_JSON}", file=sys.stderr)
        sys.exit(1)

    start_index = max(0, target_index - N_IMAGES)
    selected_frames = [activities[i]["frame"] for i in range(start_index, target_index)]

    first_frame = selected_frames[0]
    last_frame = selected_frames[-1]

    OUTPUT_DIR = Path(f"reel-frames-{first_frame}-{last_frame}")
    OUTPUT_VIDEO = f"reel-{first_frame}-{last_frame}.mov"

    jpg_files = [SCREENSHOTS_DIR / f"strava-screenshot-{f}-censored.jpg" for f in selected_frames]
    missing = [f for f, p in zip(selected_frames, jpg_files) if not p.exists()]
    if missing:
        print(f"Warning: no censored screenshot for frames {missing}, run 8_censor_strava_screenshots.py first", file=sys.stderr)
    jpg_files = [p for p in jpg_files if p.exists()]

    if not jpg_files:
        print(f"No matching .jpg files found in {SCREENSHOTS_DIR} for frames {selected_frames}", file=sys.stderr)
        sys.exit(1)

    print(f"Building reel from {len(jpg_files)} images (frames {selected_frames[0]}..{selected_frames[-1]}) ...")

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
