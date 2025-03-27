import cv2

# Open the input video
cap = cv2.VideoCapture("badapple-small.mp4")

# Get original video properties
original_fps = cap.get(cv2.CAP_PROP_FPS)
frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
print(f"Video properties: {width}x{height}")

print(f"Original FPS: {original_fps}, Frame Count: {frame_count}")
# Desired FPS
desired_fps = 3

# Calculate the frame interval to achieve the desired FPS
frame_interval = int(original_fps / desired_fps)

# Initialize the video writer
output_file = f"badapple-small-{desired_fps}fps.mov"
writer = cv2.VideoWriter(output_file, cv2.VideoWriter_fourcc(*"mp4v"), desired_fps, (width, height))

# Process the video
frame_idx = 0
output_frame_count = 0

while True:
    ret, frame = cap.read()
    # if frame_idx > 16*original_fps:
    #     break
    if not ret:
        break
    # Write every nth frame based on the interval
    if frame_idx % frame_interval == 0:
        writer.write(frame)
        output_frame_count += 1

    frame_idx += 1

# Release resources
cap.release()
writer.release()
print(f"Expected number of frames: {frame_count // frame_interval}")
print(f"Output video saved as {output_file} with {output_frame_count} frames at {desired_fps} FPS.")
