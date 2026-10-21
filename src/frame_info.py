"""
(6572 - N)/30
calculate the number of frames completed with 1980/15 + (N-1980)/30

"""

import csv
import re
from pathlib import Path

N = 4410

n_frames_done = (N - 2010) / 30 + 1980/15
n_frames_left = (6570 - N)/ 30

print(f"Frames done: {n_frames_done}")
print(f"Frames left = {n_frames_left}")


def stats_by_frame(max_frame: int):
    csv_path = Path(__file__).parent.parent / "strava_data" / "activities-2026-08-24.csv"

    days = set()
    total_distance_m = 0.0
    total_time_s = 0

    with open(csv_path) as f:
        reader = csv.DictReader(f)
        for row in reader:
            if "Bad Apple" not in row["name"]:
                continue

            match = re.search(r"\d+", row["name"])
            frame = int(match.group()) if match else None

            if frame is not None and frame <= max_frame:
                days.add(row["date"])
                total_distance_m += float(row["distance_m"])
                total_time_s += int(row["time_s"])

    return len(days), total_distance_m, total_time_s


if __name__ == "__main__":
    FRAME = 3840
    days, distance_m, time_s = stats_by_frame(FRAME)
    print(f"Unique days by frame {FRAME}: {days}")
    print(f"Total distance by frame {FRAME}: {distance_m / 1000:.2f} km")
    print(f"Total time by frame {FRAME}: {time_s / 3600:.2f} h")
