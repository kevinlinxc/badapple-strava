"""
Generates a video with random screenshots accumulating on a canvas.

Usage:
    python 9_screenshot_montage.py

Dependencies:
    pip install opencv-python
"""

import random
import re
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

# --- configurable parameters ---
VIDEO_WIDTH = 1080
VIDEO_HEIGHT = 1920
FPS = 30
DURATION_SECONDS = 15
N_IMAGES = 96
BORDER_TOP = 15
BORDER_RIGHT = 15
BORDER_BOTTOM = 45
BORDER_LEFT = 15
START_SCALE = 0.25 # 50 before
END_SCALE = 0.25
FRAMES_PER_IMAGE = 5
ROTATION_MAX_DEG = 30
OUTPUT_FILE = f"montage-first-{N_IMAGES}.mp4"
SCREENSHOTS_DIR = Path(__file__).parent.parent / "strava_data" / "screenshots" / "censored"
# -------------------------------


def main():
    jpg_files = sorted(
        SCREENSHOTS_DIR.glob("*.jpg"),
        key=lambda p: int(re.search(r"-(\d+)", p.stem).group(1)),
    )[:N_IMAGES]
    print(f"Using {len(jpg_files)} images from {SCREENSHOTS_DIR}")

    if not jpg_files:
        print(f"No .jpg files found in {SCREENSHOTS_DIR}", file=sys.stderr)
        sys.exit(1)

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(OUTPUT_FILE, fourcc, FPS, (VIDEO_WIDTH, VIDEO_HEIGHT))

    canvas = np.zeros((VIDEO_HEIGHT, VIDEO_WIDTH, 3), dtype=np.uint8)
    total_frames = FPS * DURATION_SECONDS

    for frame_idx in range(total_frames):
        if frame_idx % FRAMES_PER_IMAGE == 0:
            t = frame_idx / max(total_frames - 1, 1)
            scale = START_SCALE + (END_SCALE - START_SCALE) * t
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

                x1 = max(0, cx - rw // 2)
                y1 = max(0, cy - rh // 2)
                x2 = min(VIDEO_WIDTH, x1 + rw)
                y2 = min(VIDEO_HEIGHT, y1 + rh)

                src_x1 = x1 - (cx - rw // 2)
                src_y1 = y1 - (cy - rh // 2)
                paste_w = x2 - x1
                paste_h = y2 - y1

                if paste_w > 0 and paste_h > 0:
                    crop = rotated.crop((src_x1, src_y1, src_x1 + paste_w, src_y1 + paste_h))
                    crop_np = np.array(crop)
                    mask = crop_np[:, :, 3] > 0
                    canvas[y1:y2, x1:x2][mask] = crop_np[:, :, :3][mask][:, ::-1]

        out.write(canvas)

        if frame_idx % 30 == 0:
            print(f"Frame {frame_idx + 1}/{total_frames}")

    out.release()
    print(f"Done. Output: {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
