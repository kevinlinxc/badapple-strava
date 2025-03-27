from gps import x_y_to_gps, export_to_gpx
from map_to_image import get_map_image
import cv2
import numpy as np
import streamlit as st
import tempfile

# make a list of x, y that make a rectangle from 0,0 to 480x360
cap = cv2.VideoCapture("badapple-small.mp4")

# Get total number of frames and framerate
total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
frame_rate = cap.get(cv2.CAP_PROP_FPS)

print(f"Total number of frames: {total_frames}")
print(f"Framerate: {frame_rate} FPS")

# toronto
default_bottom_left_lat_long = "43.644057, -79.418834"
default_top_right_lat_long = "43.670315, -79.386814"


def bad_apple_contour_xy_list(frame_number):

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


frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

# Initialize session state
if 'gps_list' not in st.session_state:
    st.session_state.gps_list = []
if 'img_path' not in st.session_state:
    st.session_state.img_path = "map.png"

def on_form_submit():
    xy_list = bad_apple_contour_xy_list(st.session_state.frame_number)
    gps_list = [x_y_to_gps(x, y, 480, 360, 
                          bottom_left_lat_long=st.session_state.bottom_left_lat_long,
                          top_right_lat_long=st.session_state.top_right_lat_long, 
                          angle_degrees=st.session_state.angle,
                          skew_y_degrees=st.session_state.skew_y,
                          skew_x_degrees=st.session_state.skew_x,
                          x_scale=st.session_state.x_scale,
                          y_scale=st.session_state.y_scale) for x, y in xy_list]
    st.session_state.gps_list = gps_list
    
    st.session_state.img_path = get_map_image(gps_list, 1920, 1080, zoom=st.session_state.zoom)

st.set_page_config(page_title="Bad Apple Strava Generator", layout="wide")
st.write("## Bad Apple Strava Generator")
col1, col2 = st.columns([1, 3])

with col1:
    with st.form("badapple-strava-form"):
        st.number_input("Frame Number", min_value=0, max_value=frame_count - 1, value=235, key="frame_number")
        st.slider("Angle", -180.0, 180.0, 20.0, step=0.1, key="angle")
        st.slider("Skew Y", -10.0, 10.0, -5.1, step=0.1, key="skew_y")
        st.slider("Skew X", -10.0, 10.0, 0.0, step=0.1, key="skew_x")
        st.slider("X Scale", 0.1, 2.0, 1.3, step=0.1, key="x_scale")
        st.slider("Y Scale", 0.1, 2.0, 0.70, step=0.1, key="y_scale")
        st.slider("Map zoom", 1, 20, 15, key="zoom")
        
        bottom_left = st.text_input("Bottom Left Lat, Long", default_bottom_left_lat_long)
        top_right = st.text_input("Top Right Lat, Long", default_top_right_lat_long)
        
        st.session_state.bottom_left_lat_long = tuple(map(float, map(str.strip, bottom_left.split(","))))
        st.session_state.top_right_lat_long = tuple(map(float, map(str.strip, top_right.split(","))))
        
        st.form_submit_button("Generate Map", on_click=on_form_submit)

col2.image(st.session_state.img_path)
if st.session_state.gps_list:
    output_gpx_path = tempfile.gettempdir() + "/track.gpx"
    export_to_gpx(st.session_state.gps_list, output_file=output_gpx_path, 
                 name="Bad Apple Track Frame " + str(st.session_state.frame_number))
    col2.write("Download this GPX and upload it to a Strava route (paid feature, use the free trial to upload all at once.)")
    with open(output_gpx_path, "rb") as gpx_file:
        gpx_data = gpx_file.read()
        col2.download_button("Download GPX", gpx_data, file_name="track.gpx", 
                           mime="application/gpx+xml", on_click="ignore")
