"""
Stacks screenshots in Polaroid frames, overlaying them one at a time.
Each image holds for HOLD_FRAMES (at FPS).

Usage:
    python 12_image_stack.py <folder>
    python 12_image_stack.py <folder> --out <video.mov>
    python 12_image_stack.py <folder> --frames-only
"""

import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

FPS = 60
HOLD_FRAMES = 3

POLAROID_SIDE = 50
POLAROID_TOP = 50
POLAROID_BOTTOM = 180
POLAROID_COLOR = (255, 255, 255, 255)


def polaroid_frame(pil_img: Image.Image) -> np.ndarray:
    pw = pil_img.width + POLAROID_SIDE * 2
    ph = pil_img.height + POLAROID_TOP + POLAROID_BOTTOM
    frame = Image.new("RGBA", (pw, ph), POLAROID_COLOR)
    frame.paste(pil_img, (POLAROID_SIDE, POLAROID_TOP))
    return np.array(frame)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    folder = Path(sys.argv[1])
    out_path = folder / "stack.mov"
    frames_only = False
    for i, arg in enumerate(sys.argv):
        if arg == "--out" and i + 1 < len(sys.argv):
            out_path = Path(sys.argv[i + 1])
        if arg == "--frames-only":
            frames_only = True

    jpgs = sorted(
        folder.glob("*.jpg"),
        key=lambda p: [int(c) if c.isdigit() else c.lower()
                       for c in re.split(r'(\d+)', p.name)],
    )
    if not jpgs:
        print(f"No *.jpg files found in '{folder}'")
        sys.exit(1)

    print(f"Found {len(jpgs)} images")
    frames = []
    names = []

    for jpg in jpgs:
        img = Image.open(jpg).convert("RGBA")
        polaroid = polaroid_frame(img)
        frames.append(polaroid)
        names.append(jpg.stem)
        print(f"  {jpg.name} -> {polaroid.shape[1]}x{polaroid.shape[0]}")

    canvas_w = max(f.shape[1] for f in frames)
    canvas_h = max(f.shape[0] for f in frames)

    if frames_only:
        frames_dir = folder / "stack_frames"
        if frames_dir.exists():
            shutil.rmtree(frames_dir)
        frames_dir.mkdir(parents=True, exist_ok=True)

        canvas = np.zeros((canvas_h, canvas_w, 4), dtype=np.uint8)

        print(f"Writing {len(frames)} PNG frames to {frames_dir}...", flush=True)
        for i, (polaroid, name) in enumerate(zip(frames, names)):
            ph, pw = polaroid.shape[:2]
            x = (canvas_w - pw) // 2
            y = (canvas_h - ph) // 2
            canvas[y:y + ph, x:x + pw] = polaroid

            Image.fromarray(canvas, "RGBA").save(
                frames_dir / f"{name}-polaroid.png"
            )

            print(f"\r  {i+1}/{len(frames)} {name}", end="", flush=True)

        print()
        print(f"Saved: {frames_dir}/  ({len(frames)} frames)")
        return

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        canvas = np.zeros((canvas_h, canvas_w, 4), dtype=np.uint8)

        frame_idx = 0
        print(f"Writing {len(frames) * HOLD_FRAMES} PNG frames...", flush=True)
        for i, polaroid in enumerate(frames):
            ph, pw = polaroid.shape[:2]
            x = (canvas_w - pw) // 2
            y = (canvas_h - ph) // 2
            canvas[y:y + ph, x:x + pw] = polaroid

            for _ in range(HOLD_FRAMES):
                Image.fromarray(canvas, "RGBA").save(
                    tmp / f"frame_{frame_idx:06d}.png"
                )
                frame_idx += 1

            print(f"\r  polaroid {i+1}/{len(frames)} -> {frame_idx} frames written", end="", flush=True)

        print()
        total_frames = frame_idx

        ext = out_path.suffix.lower()
        if ext == ".webm":
            cmd = [
                "ffmpeg", "-y",
                "-framerate", str(FPS),
                "-i", str(tmp / "frame_%06d.png"),
                "-c:v", "libvpx-vp9",
                "-pix_fmt", "yuva420p",
                str(out_path),
            ]
        else:
            cmd = [
                "ffmpeg", "-y",
                "-framerate", str(FPS),
                "-i", str(tmp / "frame_%06d.png"),
                "-c:v", "prores_ks",
                "-profile:v", "4444",
                "-pix_fmt", "yuva444p10le",
                str(out_path),
            ]
        print(f"Encoding {total_frames} frames...", flush=True)
        subprocess.run(cmd, check=True)

    print(f"Saved: {out_path}  ({total_frames} frames, {total_frames / FPS:.1f}s)")


if __name__ == "__main__":
    main()
