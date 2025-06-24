# in one shot, convert bad apple contours to gpx files
from gps import x_y_to_gps, export_to_gpx
from archived.map_to_image import get_map_image
import cv2
import os
import numpy as np
from dotenv import load_dotenv
import shutil
import json

load_dotenv()
skip_frames = 15
out_dir = f"gpx-{skip_frames}"
points_dir = f"points-{skip_frames}"

# delete old files
shutil.rmtree(out_dir, ignore_errors=True)
shutil.rmtree(points_dir, ignore_errors=True)

os.makedirs(out_dir, exist_ok=True)
os.makedirs(points_dir, exist_ok=True)

# park coordinates from app.py
bottom_left_lat_long = [float(x) for x in os.environ["BOTTOM_LEFT_LAT_LONG"].split(",")]
top_right_lat_long = [float(x) for x in os.environ["TOP_RIGHT_LAT_LONG"].split(",")]

# Default parameters from app.py
angle = 0.0
skew_y = 0.0
skew_x = 0.0
x_scale = 1.0
y_scale = 0.9

cap = cv2.VideoCapture("badapple-small.mp4")
total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))


def find_contours_with_params(thresh, mode, method):
    contours, _ = cv2.findContours(thresh, mode, method)
    if not contours:
        return []
    largest_contour = max(contours, key=cv2.contourArea)
    return [(point[0][0], 360 - point[0][1]) for point in largest_contour]

def bad_apple_contour_xy_list(frame_number):
    cap.set(cv2.CAP_PROP_POS_FRAMES, frame_number)
    ret, frame = cap.read()

    # Convert frame to grayscale
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

    # Apply threshold to get binary image
    _, thresh = cv2.threshold(gray, 127, 255, cv2.THRESH_BINARY)

    # Try different contour parameters
    contour_params = [
        (cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE),
        (cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE),
        (cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE),
        (cv2.RETR_TREE, cv2.CHAIN_APPROX_NONE)
    ]

    # Get all possible contour lists
    contour_lists = [
        find_contours_with_params(thresh, mode, method)
        for mode, method in contour_params
    ]
    inverted = cv2.bitwise_not(thresh)
    contour_lists.extend([
        find_contours_with_params(inverted, mode, method)
        for mode, method in contour_params
    ])

    # Choose the list with the most points
    best_contour_list = max(contour_lists, key=len, default=[])
    print(f"Frame {frame_number}: Found {len(best_contour_list)} points")
    
    return best_contour_list

def render_points(xy_list):
    # Create a white background image
    img = np.full((360, 480, 3), (255, 255, 255), dtype=np.uint8)
    # Draw black points
    for x, y in xy_list:
        cv2.circle(img, (int(x), int(360-y)), 1, (0, 0, 0), -1)
    return img

# Store all contours in a dictionary
all_contours = {}

# Process frames in increments of skip_frames
for frame in range(0, total_frames, skip_frames):
    xy_list = bad_apple_contour_xy_list(frame)
    # convert numpy int to int    
    # Render and save visualization
    img = render_points(xy_list)
    cv2.imwrite(f"{points_dir}/{frame}.png", img)
    
    gps_list = [x_y_to_gps(x, y, 480, 360,
                          bottom_left_lat_long=bottom_left_lat_long,
                          top_right_lat_long=top_right_lat_long,
                          angle_degrees=angle,
                          skew_y_degrees=skew_y,
                          skew_x_degrees=skew_x,
                          x_scale=x_scale,
                          y_scale=y_scale) for x, y in xy_list]
    
    output_path = f"{out_dir}/{frame}.gpx"
    export_to_gpx(gps_list, output_file=output_path, 
                 name=f"Bad Apple Track Frame {frame}")
    print(f"Exported frame {frame} to {output_path} and rendered visualization")
    xy_list = [(int(x), int(y)) for x, y in xy_list]
    all_contours[str(frame)] = xy_list

# Save all contours to a single JSON file after the loop
with open(f'contours-{skip_frames}.json', 'w') as f:
    json.dump(all_contours, f)

cap.release()

