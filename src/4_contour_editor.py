import streamlit as st
import cv2
import numpy as np
import json
from pathlib import Path
import os

st.set_page_config(page_title="Bad Apple Contour Editor", layout="wide")

# Load contours from JSON
def load_contours(skip_frames=15):
    contours_file = Path(f'contours-{skip_frames}.json')
    if contours_file.exists():
        with open(contours_file) as f:
            return json.load(f)
    return {}

def save_contours(contours, skip_frames=15):

    temp_file = f'contours-{skip_frames}.json.tmp'
    try:
        with open(temp_file, 'w') as f:
            json.dump(contours, f)
        os.replace(temp_file, f'contours-{skip_frames}.json')
    except Exception as e:
        if os.path.exists(temp_file):
            os.remove(temp_file)
        raise e

def find_contours_with_params(frame, mode, method, invert=False):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    _, thresh = cv2.threshold(gray, 127, 255, cv2.THRESH_BINARY)
    if invert:
        thresh = cv2.bitwise_not(thresh)
    contours, _ = cv2.findContours(thresh, mode, method)
    if not contours:
        return []
    # Return all contours instead of just the largest one
    return [[(point[0][0], 360 - point[0][1]) for point in contour] for contour in contours]

def render_points(xy_lists, selected_indices=None):
    if not xy_lists:
        return np.full((360, 480, 3), (255, 255, 255), dtype=np.uint8)
        
    img = np.full((360, 480, 3), (255, 255, 255), dtype=np.uint8)
    if selected_indices is None:
        selected_indices = range(len(xy_lists))
    for idx in selected_indices:
        print(f"{xy_lists[idx]}")
        for x, y in xy_lists[idx]:
            cv2.circle(img, (int(x), int(360-y)), 1, (0, 0, 0), -1)
    return img

# App
st.title("Bad Apple Contour Editor")

skip_frames = 15
frame_idx = st.number_input("Frame Index", min_value=0, step=1)
actual_frame = frame_idx * skip_frames
st.write(f"Frame number: {actual_frame}")

# Load video and contours
cap = cv2.VideoCapture("badapple-small.mp4")
contours = load_contours(skip_frames)

# Set up columns
col1, col2, col3 = st.columns(3)

with col1:
    st.header("Original Frame & Current Contour")
    cap.set(cv2.CAP_PROP_POS_FRAMES, actual_frame)
    ret, frame = cap.read()
    if ret:
        st.image(frame,  caption="Original Frame")
    
    if str(actual_frame) in contours:
        current_points = contours[str(actual_frame)]
        current_img = render_points([current_points])
        st.image(current_img, caption="Current Contour")
    else:
        st.write("No contour data for this frame")

with col2:
    st.header("New Contour")
    if ret:
        # Contour parameters
        st.subheader("Contour Parameters")
        invert = st.checkbox("Invert Image")
        
        modes = {
            "RETR_EXTERNAL": cv2.RETR_EXTERNAL,
            "RETR_LIST": cv2.RETR_LIST,
            "RETR_TREE": cv2.RETR_TREE
        }
        methods = {
            "CHAIN_APPROX_NONE": cv2.CHAIN_APPROX_NONE,
            "CHAIN_APPROX_SIMPLE": cv2.CHAIN_APPROX_SIMPLE
        }
        
        mode = st.selectbox("Contour Mode", list(modes.keys()))
        method = st.selectbox("Contour Method", list(methods.keys()))
        
        # Generate new contours
        all_contours = find_contours_with_params(frame, modes[mode], methods[method], invert)
        # sort contours by length
        all_contours.sort(key=len, reverse=True) # keep 10 longest contours
        all_contours = all_contours[:10]
        
        # Contour selection
        st.subheader("Select Contours")
        selected_indices = []
        for i, contour in enumerate(all_contours):
            if st.checkbox(f"Contour {i} ({len(contour)} points)", key=f"contour_{i}", value=i==0):
                selected_indices.append(i)
        
        # Preview selected contours
with col3:
        if selected_indices:
            new_img = render_points(all_contours, selected_indices)
            st.image(new_img, caption="Selected Contours")
            
            if st.button("Save Selected Contours"):
                # Combine selected contours into one list
                combined_points = []
                for idx in selected_indices:
                    intified = [(int(x), int(y)) for x, y in all_contours[idx]]
                    combined_points.extend(intified)
                contours[str(actual_frame)] = combined_points
                save_contours(contours, skip_frames)
                st.success("Contours saved!")
                st.rerun()
        else:
            st.write("Select at least one contour to preview and save")

cap.release()