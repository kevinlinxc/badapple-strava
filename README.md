# badapple-strava

Making Bad Apple using Strava GPS maps

The core technical challenge is to convert the video into a GPX file.

**I did this by using OpenCV to find the points on the contour(s) of each frame, and then doing (x,y) -> UTM, which is like GPS but cartesian, to GPS conversion.**

The resulting GPX files can't actually be imported into Strava well, because their tech sucks and is too restrictive (I filed a support ticket and they did not bend). I imported the files into Gaia GPS instead, and walked watching that while tracking on Strava.

Rough order of reading the files if interested:

0. [`gps.py`](src/gps.py) had some helper functions that I got AI to write and then I tweaked
1. [`1_test_video_fps.py`](src/1_test_video_fps.py) to test what FPS would be good for the video. 2 fps was a good balance between continuity and number of frames to walk.
2. [`2_single_frame_gpx.py`](src/2_single_frame_gpx.py) helps to find the right parameters to place a rectangle at a park near me
3. Attempted to use [`3_bad_apple_to_gpx.py`](src/3_bad_apple_to_gpx.py) to one-shot the bad apple to GPX conversion, but
the contours are not always proper (they don't always outline the correct shape, or enough shapes), so I instead took the results from that, stored it in a 
json file as a first guess for every frame.
4. I then used the streamlit app [`4_contour_editor.py`](src/4_contour_editor.py) to edit the contours one by one, adjusting the opencv
contour detection parameters so that the selected route for each frame was heuristically correct (optimizing appearance, distance, vibes), and saved those back to the json file to cache that work.
5. Using the json and the parameters from step 2, I used [`5_json_to_gpx.py`](src/5_json_to_gpx.py) to convert the json to a gpx file. I imported these into Gaia GPS and walked them while tracking on Strava.
6. I used ['6_strava_scraper.py`](src/6_strava_scraper.py) to scrape the Strava API to get the data for the walks.


P.S. I don't name my files this horridly at work, this is just scrappy personal project code and numbering the files is probably the clearest to a reader.
