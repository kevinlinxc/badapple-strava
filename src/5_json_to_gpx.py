# take in json file and gps parameters and output gpx files
import os
from dotenv import load_dotenv
from pathlib import Path
import shutil
import json

from gps import x_y_to_gps, export_to_gpx

load_dotenv()


output_path = Path("final-gpx")
shutil.rmtree(output_path, ignore_errors=True)
os.makedirs(output_path, exist_ok=True)



bottom_left_lat_long = [float(x) for x in os.environ["BOTTOM_LEFT_LAT_LONG"].split(",")]
top_right_lat_long = [float(x) for x in os.environ["TOP_RIGHT_LAT_LONG"].split(",")]

# Default parameters from app.py
angle = 0.0
skew_y = 0.0
skew_x = 0.0
x_scale = 1.0
y_scale = 0.9

# Load contours from JSON
def load_contours(skip_frames=15):
    contours_file = Path(f'contours-{skip_frames}.json')

    with open(contours_file) as f:
        return json.load(f)


contours = load_contours(skip_frames=15)
for key, xy_list in contours.items():
    print(f"Processing frame {key} with {len(xy_list)} points")
    # Convert to GPS coordinates
    gps_list = [x_y_to_gps(x, y, 480, 360,
                           bottom_left_lat_long=bottom_left_lat_long,
                           top_right_lat_long=top_right_lat_long,
                           angle_degrees=angle,
                           skew_y_degrees=skew_y,
                           skew_x_degrees=skew_x,
                           x_scale=x_scale,
                           y_scale=y_scale) for x, y in xy_list]

    # Export to GPX
    output_file = output_path / f"{key}.gpx"
    export_to_gpx(gps_list, output_file=output_file, name=key, description=f"Bad apple frame {key}")
    print(f"Exported {key} to {output_file}")