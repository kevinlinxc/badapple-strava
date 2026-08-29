"""
(6572 - N)/30
calculate the number of frames completed with 1980/15 + (N-1980)/30

"""


N = 5340

n_frames_done = (N - 2010) / 30 + 1980/15
n_frames_left = (6570 - N)/ 30

print(f"Frames done: {n_frames_done}")
print(f"Frames left = {n_frames_left}")