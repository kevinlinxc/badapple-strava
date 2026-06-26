import csv
import json
import re
from pathlib import Path


def main():
    csv_path = Path("strava_data/activities-2026-06-21.csv")
    output_path = Path("strava_data/bad_apple_activities.json")

    activities = []

    with open(csv_path) as f:
        reader = csv.DictReader(f)
        for row in reader:
            name = row["name"]
            if "Bad Apple" not in name:
                continue

            match = re.search(r"\d+", name)
            frame = int(match.group()) if match else None

            activities.append({
                "frame": frame,
                "distance_m": float(row["distance_m"]),
                "time_s": int(row["time_s"]),
                "polyline": row["polyline"],
            })

    with open(output_path, "w") as f:
        json.dump(activities, f, indent=2)

    print(f"Exported {len(activities)} activities to {output_path}")


if __name__ == "__main__":
    main()
