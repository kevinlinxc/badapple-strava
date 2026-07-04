"""
Pulls video view counts from YouTube, Instagram, and TikTok after a given date.

Usage:
    python 11_short_videos_stats.py

Required env vars — set in a .env file in the project root:
    This quickstart got me from 0 to 1: https://developers.google.com/youtube/v3/quickstart/python
    YouTube Data API v3 (OAuth 2.0):
        YOUTUBE_CLIENT_SECRETS_FILE=/path/to/client_secret_....json

    Instagram Graph API:
    followed this to get access token: https://finsweet.com/components/instagram-feed/how-to-get-access-token#
    got instagram user id from https://developers.facebook.com/tools/explorer?domain=INSTAGRAM&method=GET&path=me%3Ffields%3Did%2Cname&version=v25.0
        INSTAGRAM_ACCESS_TOKEN + INSTAGRAM_USER_ID

    TikTok Display API (OAuth 2.0):
    Make an app, set it to sandbox, localhost didn't work for calllback uri but ngrok + localhost did
        TIKTOK_CLIENT_KEY + TIKTOK_CLIENT_SECRET
"""

import atexit
import hashlib
import http.server
import json
import os
import random
import string
import time
import urllib.parse
import webbrowser
from datetime import datetime
from pathlib import Path

import google_auth_oauthlib.flow
import googleapiclient.discovery
import googleapiclient.errors
import polars as pl
import requests
from dotenv import load_dotenv

load_dotenv()

# --- config ---
AFTER_DATE = datetime(2026, 4, 30)
OUTPUT_CSV = "short_videos_stats.csv"
# -------------

TIKTOK_TOKEN_FILE = Path(".tiktok_token.json")
TT_REDIRECT_URI = os.getenv("TIKTOK_REDIRECT_URI", "https://gobbler-working-bluebird.ngrok-free.app/callback/")


def _run_oauth_flow(
    *,
    label: str,
    token_file: Path,
    redirect_uri: str,
    auth_url_fn,
    token_exchange_fn,
    refresh_fn,
    extra_save_fields: dict = None,
) -> str:
    """Generic OAuth 2.0 browser-based authorization code flow + token caching."""

    if token_file.exists():
        saved = json.loads(token_file.read_text())
        if saved.get("expires_at", 0) > time.time() + 60:
            return saved["access_token"]

        print(f"[{label}] Token expired, refreshing ...")
        try:
            data = refresh_fn(saved["refresh_token"])
            saved = _save_token(token_file, data, label, extra_save_fields)
            return saved["access_token"]
        except Exception as e:
            print(f"[{label}] Refresh failed: {e}")
            token_file.unlink(missing_ok=True)

    print(f"[{label}] No valid token. Starting OAuth flow ...")

    state = "".join(random.choices(string.ascii_letters + string.digits, k=16))
    code_verifier = "".join(random.choices(string.ascii_letters + string.digits + "-._~", k=64))
    code_challenge = hashlib.sha256(code_verifier.encode()).hexdigest()
    code_captured: str | None = None

    auth_url = auth_url_fn(state, code_challenge)

    parsed = urllib.parse.urlparse(redirect_uri)
    port = parsed.port or 8888

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            nonlocal code_captured
            qs = urllib.parse.urlparse(self.path).query
            params = urllib.parse.parse_qs(qs)
            if "code" in params and params.get("state", [None])[0] == state:
                code_captured = params["code"][0]
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(b"<h1>Authorization complete!</h1><p>You may close this window.</p>")
            elif "error" in params:
                code_captured = "__ERROR__"
                self.send_response(400)
                self.end_headers()

        def log_message(self, format, *args):
            pass

    server = http.server.HTTPServer(("", port), Handler)
    server.timeout = 1
    atexit.register(server.server_close)

    print(f"[{label}] Open this URL in your browser:\n\n{auth_url}\n")
    webbrowser.open(auth_url)

    # Wait up to 120 seconds for browser redirect, then offer manual fallback
    for _ in range(120):
        server.handle_request()
        if code_captured is not None:
            break

    if code_captured is None:
        manual = input(f"\n[{label}] If the redirect didn't work, paste the full redirect URL here: ").strip()
        if manual:
            qs = urllib.parse.urlparse(manual).query
            params = urllib.parse.parse_qs(qs)
            if "code" in params and params.get("state", [None])[0] == state:
                code_captured = params["code"][0]
            elif "error" in params:
                code_captured = "__ERROR__"

    server.server_close()

    if code_captured is None or code_captured == "__ERROR__":
        raise RuntimeError(f"[{label}] Authorization failed or timed out.")

    data = token_exchange_fn(code_captured, code_verifier)
    saved = _save_token(token_file, data, label, extra_save_fields)
    return saved["access_token"]


def _save_token(token_file: Path, data: dict, label: str, extra: dict = None) -> dict:
    now = time.time()
    saved = {
        "access_token": data["access_token"],
        "refresh_token": data["refresh_token"],
        "scope": data.get("scope", ""),
        "expires_at": now + data.get("expires_in", 86400),
    }
    if extra:
        saved.update(extra)
    token_file.write_text(json.dumps(saved, indent=2))
    print(f"[{label}] Token saved to {token_file}")
    return saved


# ── YouTube ───────────────────────────────────────────────────────────────────

YT_SCOPE = "https://www.googleapis.com/auth/youtube.readonly"


def _get_youtube_client(client_secrets_file: str):
    """Build an authorized YouTube API client using the Google client library."""
    os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"
    flow = google_auth_oauthlib.flow.InstalledAppFlow.from_client_secrets_file(
        client_secrets_file, [YT_SCOPE],
    )
    credentials = flow.run_local_server(port=0)
    return googleapiclient.discovery.build("youtube", "v3", credentials=credentials)


def fetch_youtube(client_secrets_file: str) -> list[dict]:
    """Fetch videos from the authenticated YouTube channel after AFTER_DATE."""
    youtube = _get_youtube_client(client_secrets_file)

    channels_response = youtube.channels().list(
        part="contentDetails",
        mine=True,
    ).execute()

    items = channels_response.get("items", [])
    if not items:
        print("[YouTube] No channel found.")
        return []
    uploads_id = items[0]["contentDetails"]["relatedPlaylists"]["uploads"]

    videos = []
    page_token = None
    cutoff = AFTER_DATE.isoformat() + "T00:00:00Z"

    while True:
        playlist_response = youtube.playlistItems().list(
            part="snippet",
            playlistId=uploads_id,
            maxResults=50,
            pageToken=page_token,
        ).execute()

        video_ids = []
        for item in playlist_response.get("items", []):
            published = item["snippet"].get("publishedAt", "")
            if published >= cutoff:
                video_ids.append(item["snippet"]["resourceId"]["videoId"])

        if video_ids:
            stats_response = youtube.videos().list(
                part="statistics,snippet",
                id=",".join(video_ids),
            ).execute()
            for v in stats_response.get("items", []):
                s = v.get("statistics", {})
                snippet = v.get("snippet", {})
                videos.append({
                    "platform": "youtube",
                    "id": v["id"],
                    "title": snippet.get("title", ""),
                    "published_at": snippet.get("publishedAt", ""),
                    "views": int(s.get("viewCount", 0)),
                    "likes": int(s.get("likeCount", 0)),
                    "comments": int(s.get("commentCount", 0)),
                    "url": f"https://youtube.com/watch?v={v['id']}",
                })

        page_token = playlist_response.get("nextPageToken")
        if not page_token:
            break

    print(f"[YouTube] Fetched {len(videos)} videos")
    return videos


# ── TikTok ────────────────────────────────────────────────────────────────────

TT_SCOPE = "user.info.basic,video.list"


def _ensure_tiktok_token(client_key: str, client_secret: str) -> str:
    def auth_url_fn(state, code_challenge):
        params = urllib.parse.urlencode({
            "client_key": client_key,
            "response_type": "code",
            "scope": TT_SCOPE,
            "redirect_uri": TT_REDIRECT_URI,
            "state": state,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
        })
        return f"https://www.tiktok.com/v2/auth/authorize/?{params}"

    def token_exchange_fn(code, code_verifier):
        r = requests.post("https://open.tiktokapis.com/v2/oauth/token/", data={
            "client_key": client_key,
            "client_secret": client_secret,
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": TT_REDIRECT_URI,
            "code_verifier": code_verifier,
        })
        r.raise_for_status()
        data = r.json()
        if "error" in data:
            raise RuntimeError(f"TikTok token exchange failed: {data}")
        return data

    def refresh_fn(refresh_token):
        r = requests.post("https://open.tiktokapis.com/v2/oauth/token/", data={
            "client_key": client_key,
            "client_secret": client_secret,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        })
        r.raise_for_status()
        data = r.json()
        if "error" in data:
            raise RuntimeError(f"TikTok refresh failed: {data}")
        return data

    return _run_oauth_flow(
        label="TikTok",
        token_file=TIKTOK_TOKEN_FILE,
        redirect_uri=TT_REDIRECT_URI,
        auth_url_fn=auth_url_fn,
        token_exchange_fn=token_exchange_fn,
        refresh_fn=refresh_fn,
    )


def fetch_tiktok(access_token: str) -> list[dict]:
    """Fetch TikTok videos after AFTER_DATE using the Display API."""
    cutoff_ts = int(AFTER_DATE.timestamp())
    videos = []
    cursor = 0

    while True:
        r = requests.post(
            "https://open.tiktokapis.com/v2/video/list/",
            params={"fields": "cover_image_url,id,title,video_description,create_time,view_count,like_count,comment_count,share_url"},
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
            },
            json={"max_count": 20, "cursor": cursor},
        )
        if not r.ok:
            print(f"[TikTok] Error: {r.status_code} {r.text[:300]}")
            break

        data = r.json()
        for video in data.get("data", {}).get("videos", []):
            if video.get("create_time", 0) < cutoff_ts:
                continue

            videos.append({
                "platform": "tiktok",
                "id": video["id"],
                "title": (video.get("title") or video.get("video_description") or "")[:100],
                "published_at": datetime.fromtimestamp(video["create_time"]).isoformat(),
                "views": int(video.get("view_count", 0)),
                "likes": int(video.get("like_count", 0)),
                "comments": int(video.get("comment_count", 0)),
                "url": video.get("share_url", ""),
            })

        cursor = data.get("data", {}).get("cursor", 0)
        if not data.get("data", {}).get("has_more"):
            break

    print(f"[TikTok] Fetched {len(videos)} videos")
    return videos


# ── Instagram ─────────────────────────────────────────────────────────────────

def fetch_instagram(access_token: str, user_id: str) -> list[dict]:
    """Fetch Reels from Instagram Business account after AFTER_DATE."""
    cutoff = AFTER_DATE
    videos = []
    after_cursor = None

    while True:
        params = {
            "fields": "id,caption,media_type,permalink,timestamp,like_count,comments_count",
            "access_token": access_token,
            "limit": 100,
        }
        if after_cursor:
            params["after"] = after_cursor

        r = requests.get(
            f"https://graph.instagram.com/v21.0/{user_id}/media",
            params=params,
        )
        r.raise_for_status()
        data = r.json()

        for item in data.get("data", []):
            if item.get("media_type") != "VIDEO":
                continue
            published = datetime.fromisoformat(item["timestamp"].replace("+0000", ""))
            if published < cutoff:
                continue

            media_id = item["id"]
            ir = requests.get(
                f"https://graph.instagram.com/v21.0/{media_id}/insights",
                params={"metric": "views,reach", "access_token": access_token},
            )
            views = 0
            if ir.ok:
                for metric in ir.json().get("data", []):
                    if metric["name"] == "views":
                        views = metric.get("values", [{}])[-1].get("value", 0)

            videos.append({
                "platform": "instagram",
                "id": media_id,
                "title": (item.get("caption") or "")[:100],
                "published_at": item["timestamp"],
                "views": int(views),
                "likes": int(item.get("like_count", 0)),
                "comments": int(item.get("comments_count", 0)),
                "url": item.get("permalink", ""),
            })

        after_cursor = data.get("paging", {}).get("cursors", {}).get("after")
        if not after_cursor:
            break

    print(f"[Instagram] Fetched {len(videos)} reels")
    return videos


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    all_videos = []

    yt_secrets_file = os.getenv("YOUTUBE_CLIENT_SECRETS_FILE")
    ig_token = os.getenv("INSTAGRAM_ACCESS_TOKEN")
    ig_user_id = os.getenv("INSTAGRAM_USER_ID")
    tt_client_key = os.getenv("TIKTOK_CLIENT_KEY")
    tt_client_secret = os.getenv("TIKTOK_CLIENT_SECRET")

    if yt_secrets_file:
        try:
            all_videos.extend(fetch_youtube(yt_secrets_file))
        except Exception as e:
            print(f"[YouTube] Failed: {e}")
    else:
        print("[YouTube] Skipped — set YOUTUBE_CLIENT_SECRETS_FILE")

    if ig_token and ig_user_id:
        try:
            all_videos.extend(fetch_instagram(ig_token, ig_user_id))
        except Exception as e:
            print(f"[Instagram] Failed: {e}")
    else:
        print("[Instagram] Skipped — set INSTAGRAM_ACCESS_TOKEN + INSTAGRAM_USER_ID")

    if tt_client_key and tt_client_secret:
        try:
            token = _ensure_tiktok_token(tt_client_key, tt_client_secret)
            all_videos.extend(fetch_tiktok(token))
        except Exception as e:
            print(f"[TikTok] Failed: {e}")
    else:
        print("[TikTok] Skipped — set TIKTOK_CLIENT_KEY + TIKTOK_CLIENT_SECRET")

    if not all_videos:
        print("No video data collected.")
        return

    df = pl.DataFrame(all_videos)
    df = df.sort("published_at", descending=True)
    print(f"\nTotal: {len(df)} videos")

    print("\nBy platform:")
    print(df.group_by("platform").agg(pl.col("views").sum()).sort("views", descending=True))

    print("\nTop 10 by views:")
    top = df.sort("views", descending=True).head(10)
    for row in top.iter_rows(named=True):
        print(f"  {row['platform']:10s} {row['views']:>8,d}  {row['title'][:60]}")

    df.write_csv(OUTPUT_CSV)
    print(f"\nSaved to {OUTPUT_CSV}")


if __name__ == "__main__":
    main()
