"""
Quick GUI to check the step counts in polyline_renderer's final mode against the screenshots.

Shows each screenshot next to the number currently in the STEPS array of FinalMode.tsx.
Type the right number if it's wrong. Every change is written straight back into FinalMode.tsx.

Usage:
    python 15_check_steps.py

Keys:
    Enter / Down    save and go to the next frame
    Up              previous frame
    Tab             jump to the next outlier (steps per metre far from the usual)
"""

import base64
import io
import json
import re
import statistics
import tkinter as tk
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).parent.parent
SCREENSHOTS = ROOT / "strava_data" / "screenshots" / "uncensored" / "uncensored-removed"
ACTIVITIES = ROOT / "strava_data" / "bad_apple_activities.json"
FINAL_MODE = ROOT / "polyline_renderer" / "app" / "components" / "FinalMode.tsx"

STEPS_PATTERN = re.compile(r"(const STEPS = \[\n)(.*?)(\];)", re.DOTALL)
PER_LINE = 18

# Only the header and stats are needed, not the map
CROP_HEIGHT = 620
DISPLAY_WIDTH = 720

# Steps per metre further than this from the median is flagged
OUTLIER_TOLERANCE = 0.3


def read_steps() -> list[int]:
    match = STEPS_PATTERN.search(FINAL_MODE.read_text())
    return [int(n) for n in re.findall(r"\d+", match.group(2))]


def write_steps(steps: list[int]):
    lines = "".join(
        "  " + ", ".join(map(str, steps[i:i + PER_LINE])) + ",\n"
        for i in range(0, len(steps), PER_LINE)
    )
    text = FINAL_MODE.read_text()
    FINAL_MODE.write_text(STEPS_PATTERN.sub(lambda m: m.group(1) + lines + m.group(3), text))


class Checker:
    def __init__(self):
        self.activities = json.loads(ACTIVITIES.read_text())
        self.steps = read_steps()
        if len(self.steps) != len(self.activities):
            raise SystemExit(f"STEPS has {len(self.steps)} entries but there are {len(self.activities)} activities")
        self.index = 0

        self.root = tk.Tk()
        self.root.title("Check steps")
        self.title = tk.Label(self.root, font=("Helvetica", 20, "bold"))
        self.title.pack(pady=(10, 0))
        self.info = tk.Label(self.root, font=("Helvetica", 15))
        self.info.pack()
        self.entry = tk.Entry(self.root, font=("Helvetica", 40), justify="center", width=8)
        self.entry.pack(pady=8)
        self.image_label = tk.Label(self.root)
        self.image_label.pack(padx=10, pady=(0, 10))

        self.root.bind("<Return>", lambda e: self.move(1))
        self.root.bind("<Down>", lambda e: self.move(1))
        self.root.bind("<Up>", lambda e: self.move(-1))
        self.root.bind("<Tab>", self.next_outlier)
        self.show()
        self.root.mainloop()

    def ratio(self, i: int) -> float:
        return self.steps[i] / self.activities[i]["distance_m"]

    def is_outlier(self, i: int) -> bool:
        median = statistics.median(self.ratio(k) for k in range(len(self.steps)))
        return abs(self.ratio(i) - median) > OUTLIER_TOLERANCE

    def save(self):
        text = self.entry.get().replace(",", "").strip()
        if text.isdigit() and int(text) != self.steps[self.index]:
            self.steps[self.index] = int(text)
            write_steps(self.steps)

    def move(self, by: int):
        self.save()
        self.index = max(0, min(len(self.steps) - 1, self.index + by))
        self.show()

    def next_outlier(self, event=None):
        self.save()
        for i in range(self.index + 1, len(self.steps)):
            if self.is_outlier(i):
                self.index = i
                break
        self.show()
        return "break"

    def show(self):
        activity = self.activities[self.index]
        frame = activity["frame"]
        outlier = self.is_outlier(self.index)
        self.title.config(text=f"Frame {frame}   ({self.index + 1}/{len(self.steps)})")
        self.info.config(
            text=f"{activity['distance_m']:.1f} m   {self.ratio(self.index):.2f} steps/m" + ("   OUTLIER" if outlier else ""),
            fg="red" if outlier else "gray",
        )
        self.entry.delete(0, tk.END)
        self.entry.insert(0, str(self.steps[self.index]))
        self.entry.focus_set()
        self.entry.select_range(0, tk.END)

        path = SCREENSHOTS / f"badapple-strava-{frame:04d}.jpg"
        if path.exists():
            image = Image.open(path).convert("RGB")
            image = image.crop((0, 0, image.width, min(image.height, CROP_HEIGHT)))
            image = image.resize((DISPLAY_WIDTH, round(image.height * DISPLAY_WIDTH / image.width)), Image.LANCZOS)
            # PIL's ImageTk doesn't work with uv's Python, so hand Tk a PNG instead
            png = io.BytesIO()
            image.save(png, format="PNG", compress_level=1)
            self.photo = tk.PhotoImage(data=base64.b64encode(png.getvalue()))
            self.image_label.config(image=self.photo, text="")
        else:
            self.image_label.config(image="", text=f"No screenshot: {path.name}")


if __name__ == "__main__":
    Checker()
