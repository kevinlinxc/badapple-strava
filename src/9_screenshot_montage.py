"""
Generates PNG frames with random screenshots accumulating on a transparent canvas.

Usage:
    python 9_screenshot_montage.py <frame_number>

The given frame number is looked up in bad_apple_activities.json. The script then
counts back N_IMAGES entries through the JSON (not including the target frame) to
determine which frame numbers to include.

Dependencies:
    pip install opencv-python pillow
"""

import json
import math
import random
import re
import subprocess
import sys
from pathlib import Path

import cv2
from PIL import Image

# --- configurable parameters ---
VIDEO_WIDTH = 1080
VIDEO_HEIGHT = 1920
FPS = 30
DURATION_SECONDS = None
N_IMAGES = 114
BORDER_TOP = 15
BORDER_RIGHT = 15
BORDER_BOTTOM = 45
BORDER_LEFT = 15
START_SCALE = 0.3
END_SCALE = 0.25
FRAMES_PER_IMAGE = 5
ROTATION_MAX_DEG = 30
FREEZE_SECONDS = 2
SEED = 42
ORDERED = True
SCREENSHOTS_DIR = Path(__file__).parent.parent / "strava_data" / "screenshots" / "censored"
ACTIVITIES_JSON = Path(__file__).parent.parent / "polyline_renderer" / "public" / "bad_apple_activities.json"
# -------------------------------


def main():
    random.seed(SEED)

    if len(sys.argv) < 2:
        print("Usage: python 9_screenshot_montage.py <frame_number>", file=sys.stderr)
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

    first_frame = selected_frames[0] if selected_frames else target_frame
    last_frame = selected_frames[-1] if selected_frames else target_frame

    OUTPUT_DIR = Path(f"montage-frames-{first_frame}-{last_frame}")
    OUTPUT_VIDEO = f"montage-{first_frame}-{last_frame}.mov"

    jpg_files = [SCREENSHOTS_DIR / f"strava-screenshot-{f}-censored.jpg" for f in selected_frames]
    jpg_files = [p for p in jpg_files if p.exists()]

    if not jpg_files:
        print(f"No matching .jpg files found in {SCREENSHOTS_DIR} for frames {selected_frames}", file=sys.stderr)
        sys.exit(1)

    print(f"Using {len(jpg_files)} images (frames {selected_frames[0]}..{selected_frames[-1]}) from {SCREENSHOTS_DIR}")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    canvas = Image.new("RGBA", (VIDEO_WIDTH, VIDEO_HEIGHT), (0, 0, 0, 0))

    if DURATION_SECONDS is None:
        duration = math.ceil(N_IMAGES * FRAMES_PER_IMAGE / FPS)
    else:
        duration = DURATION_SECONDS
    total_frames = FPS * duration
    image_idx = 0

    for frame_idx in range(total_frames):
        if frame_idx % FRAMES_PER_IMAGE == 0:
            t = frame_idx / max(total_frames - 1, 1)
            scale = START_SCALE + (END_SCALE - START_SCALE) * t
            if ORDERED:
                img_path = jpg_files[image_idx % len(jpg_files)]
                image_idx += 1
            else:
                img_path = random.choice(jpg_files)
            img = cv2.imread(str(img_path))
            if img is not None:
                h, w = img.shape[:2]
                new_w = int(w * scale)
                new_h = int(h * scale)
                img = cv2.resize(img, (new_w, new_h))

                img_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
                pil_img = Image.fromarray(img_rgb).convert("RGBA")

                pw = new_w + BORDER_LEFT + BORDER_RIGHT
                ph = new_h + BORDER_TOP + BORDER_BOTTOM
                canvas_layer = Image.new("RGBA", (pw, ph), (255, 255, 255, 255))
                canvas_layer.paste(pil_img, (BORDER_LEFT, BORDER_TOP), pil_img)

                angle = random.uniform(-ROTATION_MAX_DEG, ROTATION_MAX_DEG)
                rotated = canvas_layer.rotate(angle, expand=True, resample=Image.BICUBIC)

                rw, rh = rotated.size
                cx = random.randint(0, VIDEO_WIDTH)
                cy = random.randint(0, VIDEO_HEIGHT)

                paste_x = cx - rw // 2
                paste_y = cy - rh // 2
                canvas.paste(rotated, (paste_x, paste_y), rotated)

        canvas.save(OUTPUT_DIR / f"frame_{frame_idx:05d}.png")

        if frame_idx % 30 == 0:
            print(f"Frame {frame_idx + 1}/{total_frames}")

    print(f"Done. {total_frames} frames in {OUTPUT_DIR}")

    freeze_frames = FPS * FREEZE_SECONDS
    for i in range(freeze_frames):
        canvas.save(OUTPUT_DIR / f"frame_{total_frames + i:05d}.png")
    print(f"Added {freeze_frames} freeze frames")

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
