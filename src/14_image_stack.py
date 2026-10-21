"""
Plays the uncensored screenshots back in sync with Bad Apple, for the final video.
Each screenshot is held until the next one is due, so 15 frame jumps hold for
half a second and 30 frame jumps hold for a full second.

The canvas is the biggest width x biggest height of all the screenshots. Every
screenshot is centered on it, and whatever it doesn't cover is transparent.

iPhone screenshots are Display P3, so they are converted to sRGB and the video
is tagged Rec.709. Without that the orange comes out desaturated.

Usage:
    python 14_image_stack.py [folder]
    python 14_image_stack.py [folder] --out <video.mov>

<folder> defaults to strava_data/screenshots/uncensored/uncensored-removed and
must hold badapple-strava-<frame>.jpg files (see 13_rename_uncensored_screenshots.py).
"""

import io
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageCms

DEFAULT_FOLDER = (
    Path(__file__).parent.parent / "strava_data" / "screenshots" / "uncensored" / "uncensored-removed"
)

# Bad Apple's frame rate, so a jump of N frames holds for exactly N video frames
FPS = 30

NAME_PATTERN = re.compile(r"^badapple-strava-(\d+)\.jpg$")

SRGB_PROFILE = ImageCms.createProfile("sRGB")


def load_srgb(path: Path) -> Image.Image:
    """Open a screenshot as RGBA, converted from its embedded color profile to sRGB."""
    img = Image.open(path)
    icc_profile = img.info.get("icc_profile")
    img = img.convert("RGB")
    if icc_profile:
        source = ImageCms.ImageCmsProfile(io.BytesIO(icc_profile))
        img = ImageCms.profileToProfile(img, source, SRGB_PROFILE, outputMode="RGB")
    return img.convert("RGBA")


def main():
    args = sys.argv[1:]
    out_path = None
    if "--out" in args:
        i = args.index("--out")
        if i + 1 >= len(args):
            print("Error: --out requires a path")
            sys.exit(1)
        out_path = Path(args[i + 1])
        del args[i:i + 2]

    folder = Path(args[0]) if args else DEFAULT_FOLDER
    if not folder.is_dir():
        print(f"Error: '{folder}' is not a directory")
        sys.exit(1)
    if out_path is None:
        out_path = folder / "stack.mov"

    # (bad apple frame, path), in playback order
    shots = sorted(
        (int(m.group(1)), p)
        for p in folder.glob("*.jpg")
        if (m := NAME_PATTERN.match(p.name))
    )
    if not shots:
        print(f"No badapple-strava-<frame>.jpg files found in '{folder}'")
        sys.exit(1)

    sizes = []
    for _, path in shots:
        with Image.open(path) as img:
            sizes.append(img.size)
    canvas_w = max(w for w, _ in sizes)
    canvas_h = max(h for _, h in sizes)

    # Hold each screenshot until the next one is due. The last one has no next,
    # so it reuses the jump that led into it.
    frame_numbers = [frame for frame, _ in shots]
    holds = [b - a for a, b in zip(frame_numbers, frame_numbers[1:])]
    holds.append(holds[-1] if holds else FPS)
    total_frames = sum(holds)

    print(f"Found {len(shots)} screenshots, canvas {canvas_w}x{canvas_h}")
    print(f"Encoding {total_frames} frames ({total_frames / FPS:.1f}s at {FPS} fps)...", flush=True)

    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "rawvideo",
        "-pix_fmt", "rgba",
        "-s", f"{canvas_w}x{canvas_h}",
        "-framerate", str(FPS),
        "-i", "-",
        # ffmpeg defaults to an untagged BT.601 conversion, which players misread
        "-vf", "scale=out_color_matrix=bt709:out_range=tv,"
               "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709",
        "-c:v", "prores_ks",
        "-profile:v", "4444",
        "-pix_fmt", "yuva444p10le",
        str(out_path),
    ]
    ffmpeg = subprocess.Popen(cmd, stdin=subprocess.PIPE)

    for i, ((frame, path), hold) in enumerate(zip(shots, holds)):
        img = load_srgb(path)
        x = (canvas_w - img.width) // 2
        y = (canvas_h - img.height) // 2
        canvas = np.zeros((canvas_h, canvas_w, 4), dtype=np.uint8)
        canvas[y:y + img.height, x:x + img.width] = np.array(img)

        data = canvas.tobytes()
        for _ in range(hold):
            ffmpeg.stdin.write(data)

        print(f"\r  {i+1}/{len(shots)} frame {frame} held {hold / FPS:.1f}s", end="", flush=True)

    print()
    ffmpeg.stdin.close()
    if ffmpeg.wait() != 0:
        print("Error: ffmpeg failed")
        sys.exit(1)

    print(f"Saved: {out_path}  ({total_frames} frames, {total_frames / FPS:.1f}s)")

    # Chrome can't decode ProRes, so polyline_renderer's final mode reads this H.264 copy.
    # It has no alpha, so the uncovered canvas is filled with Strava's dark background.
    browser_path = out_path.with_suffix(".mp4")
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", f"color=c=0x141414:s={canvas_w}x{canvas_h}:r={FPS}",
        "-i", str(out_path),
        "-filter_complex",
        "[0][1]overlay=shortest=1:format=auto,scale=-2:1200:flags=lanczos,format=yuv420p",
        "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-g", str(FPS),
        "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
        "-movflags", "+faststart", "-an",
        str(browser_path),
    ], check=True)
    print(f"Saved: {browser_path}")


if __name__ == "__main__":
    main()
