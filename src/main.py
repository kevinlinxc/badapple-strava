from gps import x_y_to_gps, export_to_gpx
from map_to_image import get_map_image
import cv2
import numpy as np

# make a list of x, y that make a rectangle from 0,0 to 480x360

def rectangle_xy_list():
    xy_list = []

    # start at 0,0, go to 480,0
    for x in range(0, 480, 5):
        xy_list.append((x, 0))

    # go to 480,360
    for y in range(0, 360, 5):
        xy_list.append((480, y))

    # go to 0,360
    for x in range(480, -1, -5):
        xy_list.append((x, 360))

    # go to 0,0
    for y in range(360, -1, -5):
        xy_list.append((0, y))
    return xy_list

def bad_apple_contour_xy_list(frame_number):
    cap = cv2.VideoCapture("badapple-small.mp4")
    cap.set(cv2.CAP_PROP_POS_FRAMES, frame_number)
    ret, frame = cap.read()
    xy_list = []

    # Convert frame to grayscale
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

    # Apply threshold to get binary image
    _, thresh = cv2.threshold(gray, 127, 255, cv2.THRESH_BINARY)

    # Find contours
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)

    # Use the largest contour
    if contours:
        largest_contour = max(contours, key=cv2.contourArea)

        # Extract points from the contour
        for point in largest_contour:
            x, y = point[0]
            xy_list.append((x, 360 - y))

    return xy_list


xy_list = bad_apple_contour_xy_list(235)
# xy_list = rectangle_xy_list()

gps_list = [x_y_to_gps(x, y, 480, 360, angle_degrees=20, skew_y_degrees=-5.1, x_scale=1.3, y_scale=0.70) for x, y in xy_list]

img = get_map_image(gps_list, 1920, 1080)
img.show()

print(gps_list)


# Export the GPS track to a GPX file
export_to_gpx(gps_list, output_file="track.gpx", name="Bad Apple Track")

