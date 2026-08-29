# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "google-auth-oauthlib",
#     "google-api-python-client",
#     "python-dotenv",
# ]
# ///
"""
Print YouTube video stats for the authenticated channel.
Set YOUTUBE_CLIENT_SECRETS_FILE to the path of your client_secret_*.json.

Usage:
    YOUTUBE_CLIENT_SECRETS_FILE=/path/to/client_secret.json uv run yt_stats.py
"""

import os
import sys

from dotenv import load_dotenv
import google_auth_oauthlib.flow
import googleapiclient.discovery

load_dotenv()

os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"


SECRETS_FILE = os.getenv("YOUTUBE_CLIENT_SECRETS_FILE")
if not SECRETS_FILE or not os.path.exists(SECRETS_FILE):
    print(
        "Set YOUTUBE_CLIENT_SECRETS_FILE to the path of your client_secret_*.json",
        file=sys.stderr,
    )
    sys.exit(1)

SCOPES = ["https://www.googleapis.com/auth/youtube.readonly"]

flow = google_auth_oauthlib.flow.InstalledAppFlow.from_client_secrets_file(
    SECRETS_FILE, SCOPES
)
credentials = flow.run_local_server(port=0)
youtube = googleapiclient.discovery.build("youtube", "v3", credentials=credentials)

# Get uploads playlist
channel = youtube.channels().list(part="contentDetails", mine=True).execute()
uploads_id = channel["items"][0]["contentDetails"]["relatedPlaylists"]["uploads"]

# Fetch videos
page_token = None
while True:
    playlist = (
        youtube.playlistItems()
        .list(
            part="snippet",
            playlistId=uploads_id,
            maxResults=50,
            pageToken=page_token,
        )
        .execute()
    )

    video_ids = [
        item["snippet"]["resourceId"]["videoId"] for item in playlist.get("items", [])
    ]

    if video_ids:
        stats = (
            youtube.videos()
            .list(
                part="statistics,snippet",
                id=",".join(video_ids),
            )
            .execute()
        )

        for v in stats.get("items", []):
            s = v.get("statistics", {})
            sn = v.get("snippet", {})
            print(
                f"{sn.get('publishedAt', '')[:10]}  "
                f"{s.get('viewCount', '0'):>10s} views  "
                f"{s.get('likeCount', '0'):>8s} likes  "
                f"{sn.get('title', '')[:80]}"
            )

    page_token = playlist.get("nextPageToken")
    if not page_token:
        break
