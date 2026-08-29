import csv
import json
import re
from pathlib import Path


def main():
    csv_path = Path("strava_data/activities-2026-08-24.csv")
    output_path = Path("strava_data/bad_apple_activities.json")

    activities = []
    total_distance_m = 0.0
    total_time_s = 0
    unique_days = set()

    with open(csv_path) as f:
        reader = csv.DictReader(f)
        for row in reader:
            name = row["name"]
            if "Bad Apple" not in name:
                continue

            match = re.search(r"\d+", name)
            frame = int(match.group()) if match else None

            distance_m = float(row["distance_m"])
            time_s = int(row["time_s"])
            date = row["date"]

            total_distance_m += distance_m
            total_time_s += time_s
            unique_days.add(date)

            activities.append({
                "frame": frame,
                "distance_m": distance_m,
                "time_s": time_s,
                "polyline": row["polyline"],
            })

    with open(output_path, "w") as f:
        json.dump(activities, f, indent=2)

    total_distance_km = total_distance_m / 1000
    total_time_h = total_time_s / 3600
    print(f"Exported {len(activities)} activities to {output_path}")
    print(f"Total frames: {len(activities)}")
    print(f"Total distance: {total_distance_km:.2f} km ({total_distance_m:.0f} m)")
    print(f"Total time: {total_time_h:.2f} h ({total_time_s} s)")
    print(f"Unique days: {len(unique_days)}")


if __name__ == "__main__":
    main()
