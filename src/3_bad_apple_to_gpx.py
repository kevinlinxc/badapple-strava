# first pass: pick a contour for each bad apple frame and save them to contours-15.json
# fix the bad ones in 4_contour_editor.py, then make gpx files with 5_json_to_gpx.py
# WARNING: rerunning this overwrites contours-15.json, including any manual edits
from archived.map_to_image import get_map_image
import cv2
import os
import numpy as np
import shutil
import json

skip_frames = 15
points_dir = f"points-{skip_frames}"
frames_dir = f"frames-{skip_frames}"

# delete old files
shutil.rmtree(points_dir, ignore_errors=True)
shutil.rmtree(frames_dir, ignore_errors=True)

os.makedirs(points_dir, exist_ok=True)
os.makedirs(frames_dir, exist_ok=True)

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
    
    return best_contour_list, frame

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
    xy_list, frame_img = bad_apple_contour_xy_list(frame)
    # convert numpy int to int
    frame_img = cv2.cvtColor(frame_img, cv2.COLOR_BGR2RGB)
    # Render and save visualization
    cv2.imwrite(f"{frames_dir}/{frame}.png", frame_img)
    img = render_points(xy_list)
    cv2.imwrite(f"{points_dir}/{frame}.png", img)
    print(f"Rendered frame {frame}")
    xy_list = [(int(x), int(y)) for x, y in xy_list]
    all_contours[str(frame)] = xy_list

# Save all contours to a single JSON file after the loop
with open(f'contours-{skip_frames}.json', 'w') as f:
    json.dump(all_contours, f)

cap.release()

