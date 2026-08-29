# streamlit app to generate a GPX file from a single frame of a video
# used this for my Toronto trip
# streamlit run src/single_frame_gpx.py
from gps import x_y_to_gps, export_to_gpx
from archived.map_to_image import get_map_image, TILE_OPTIONS
import json
import streamlit as st
import tempfile
from dotenv import load_dotenv
import os
load_dotenv()

CONTOURS_PATH = "contours-15.json"
FRAME_STEP = 15

with open(CONTOURS_PATH) as f:
    contours_data = json.load(f)

frame_keys = sorted(int(k) for k in contours_data.keys())
max_frame = frame_keys[-1]

default_bottom_left_lat_long = os.environ["BOTTOM_LEFT_LAT_LONG"]
default_top_right_lat_long = os.environ["TOP_RIGHT_LAT_LONG"]

def bad_apple_contour_xy_list(frame_number):
    key = str(round(frame_number / FRAME_STEP) * FRAME_STEP)
    raw_points = contours_data.get(key, [])
    return [(int(x), int(y)) for x, y in raw_points]

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
    
    st.session_state.img_path = get_map_image(gps_list, 1920, 1080, zoom=st.session_state.zoom, tiles=st.session_state.tile)

st.set_page_config(page_title="Bad Apple Strava Generator", layout="wide")
st.write("## Bad Apple Strava Generator")
col1, col2 = st.columns([1, 3])

with col1:
    with st.form("badapple-strava-form"):
        st.number_input("Frame Number", min_value=0, max_value=max_frame, value=235, key="frame_number")
        st.slider("Angle", -180.0, 180.0, 0.0, step=0.1, key="angle")
        st.slider("Skew Y", -10.0, 10.0, 0.0, step=0.1, key="skew_y")
        st.slider("Skew X", -10.0, 10.0, 0.0, step=0.1, key="skew_x")
        st.slider("X Scale", 0.1, 2.0, 1.0, step=0.1, key="x_scale")
        st.slider("Y Scale", 0.1, 2.0, 0.9, step=0.1, key="y_scale")
        st.slider("Map zoom", 1, 20, 20, key="zoom")
        st.selectbox("Map tiles", list(TILE_OPTIONS.keys()), key="tile")
        
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
