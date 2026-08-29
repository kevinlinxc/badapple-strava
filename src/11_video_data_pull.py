# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "streamlit",
#     "polars",
#     "plotly",
#     "python-dotenv",
#     "google-auth-oauthlib",
#     "google-api-python-client",
#     "requests",
# ]
# ///
"""
Streamlit dashboard for pulling video stats from YouTube, Instagram, and TikTok.
Self-contained — no external module imports needed.
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
from datetime import datetime, timezone, timedelta
from pathlib import Path

import google_auth_oauthlib.flow
import googleapiclient.discovery
import polars as pl
import plotly.express as px
import requests
import streamlit as st
from dotenv import load_dotenv

load_dotenv()

AFTER_DATE = datetime(2026, 4, 30)
TIKTOK_TOKEN_FILE = Path(".tiktok_token.json")
TT_REDIRECT_URI = os.getenv("TIKTOK_REDIRECT_URI")

st.set_page_config(page_title="Video Stats", layout="wide")
st.title("Video Stats Dashboard")

after_date_input = st.sidebar.date_input(
    "After date", value=AFTER_DATE.date(),
    help="Only show videos after this date",
)
AFTER_DATE = datetime.combine(after_date_input, datetime.min.time())

for key in ("yt_df", "ig_df", "tt_df"):
    if key not in st.session_state:
        st.session_state[key] = None

if "csvs_loaded" not in st.session_state:
    st.session_state.csvs_loaded = True
    for csv_path, key in [
        ("youtube_stats.csv", "yt_df"),
        ("instagram_stats.csv", "ig_df"),
        ("tiktok_stats.csv", "tt_df"),
    ]:
        if Path(csv_path).exists():
            try:
                st.session_state[key] = pl.read_csv(csv_path)
            except Exception:
                pass


# ── TikTok OAuth helpers ───────────────────────

def _save_token(token_file, data, label):
    now = time.time()
    saved = {
        "access_token": data["access_token"],
        "refresh_token": data["refresh_token"],
        "scope": data.get("scope", ""),
        "expires_at": now + data.get("expires_in", 86400),
    }
    token_file.write_text(json.dumps(saved, indent=2))
    return saved


def _ensure_tiktok_token(client_key, client_secret):
    token_file = TIKTOK_TOKEN_FILE

    if token_file.exists():
        saved = json.loads(token_file.read_text())
        if saved.get("expires_at", 0) > time.time() + 60:
            return saved["access_token"]

        r = requests.post("https://open.tiktokapis.com/v2/oauth/token/", data={
            "client_key": client_key,
            "client_secret": client_secret,
            "grant_type": "refresh_token",
            "refresh_token": saved["refresh_token"],
        })
        if r.ok:
            data = r.json()
            if "error" not in data:
                saved = _save_token(token_file, data, "TikTok")
                return saved["access_token"]
        token_file.unlink(missing_ok=True)

    state = "".join(random.choices(string.ascii_letters + string.digits, k=16))
    code_verifier = "".join(random.choices(string.ascii_letters + string.digits + "-._~", k=64))
    code_challenge = hashlib.sha256(code_verifier.encode()).hexdigest()

    auth_url = "https://www.tiktok.com/v2/auth/authorize/?" + urllib.parse.urlencode({
        "client_key": client_key,
        "response_type": "code",
        "scope": "user.info.basic,video.list",
        "redirect_uri": TT_REDIRECT_URI,
        "state": state,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    })

    code_captured = None

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
                self.wfile.write(b"Done! You may close this window.")

        def log_message(self, format, *args):
            pass

    server = http.server.HTTPServer(("", 8888), Handler)
    server.timeout = 1
    atexit.register(server.server_close)

    st.info(f"Open this URL in your browser:\n\n{auth_url}")
    webbrowser.open(auth_url)

    for _ in range(120):
        server.handle_request()
        if code_captured is not None:
            break

    server.server_close()

    if not code_captured:
        raise RuntimeError("TikTok authorization failed or timed out")

    r = requests.post("https://open.tiktokapis.com/v2/oauth/token/", data={
        "client_key": client_key,
        "client_secret": client_secret,
        "code": code_captured,
        "grant_type": "authorization_code",
        "redirect_uri": TT_REDIRECT_URI,
        "code_verifier": code_verifier,
    })
    r.raise_for_status()
    data = r.json()
    if "error" in data:
        raise RuntimeError(f"TikTok token exchange failed: {data}")

    saved = _save_token(token_file, data, "TikTok")
    return saved["access_token"]


# ── YouTube ────────────────────────────────────

def _get_youtube_client(client_secrets_file):
    os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"
    flow = google_auth_oauthlib.flow.InstalledAppFlow.from_client_secrets_file(
        client_secrets_file, ["https://www.googleapis.com/auth/youtube.readonly"],
    )
    credentials = flow.run_local_server(port=0)
    return googleapiclient.discovery.build("youtube", "v3", credentials=credentials)


def fetch_youtube(client_secrets_file):
    youtube = _get_youtube_client(client_secrets_file)
    channel = youtube.channels().list(part="contentDetails", mine=True).execute()
    items = channel.get("items", [])
    if not items:
        return []
    uploads_id = items[0]["contentDetails"]["relatedPlaylists"]["uploads"]

    videos = []
    page_token = None
    cutoff = AFTER_DATE.isoformat() + "T00:00:00Z"

    while True:
        playlist = youtube.playlistItems().list(
            part="snippet", playlistId=uploads_id, maxResults=50, pageToken=page_token,
        ).execute()

        video_ids = [
            item["snippet"]["resourceId"]["videoId"]
            for item in playlist.get("items", [])
            if item["snippet"].get("publishedAt", "") >= cutoff
        ]

        if video_ids:
            stats = youtube.videos().list(
                part="statistics,snippet", id=",".join(video_ids),
            ).execute()
            for v in stats.get("items", []):
                s = v.get("statistics", {})
                sn = v.get("snippet", {})
                videos.append({
                    "platform": "youtube", "id": v["id"],
                    "title": sn.get("title", ""),
                    "published_at": sn.get("publishedAt", ""),
                    "views": int(s.get("viewCount", 0)),
                    "likes": int(s.get("likeCount", 0)),
                    "comments": int(s.get("commentCount", 0)),
                    "url": f"https://youtube.com/watch?v={v['id']}",
                })

        page_token = playlist.get("nextPageToken")
        if not page_token:
            break

    return videos


# ── Instagram ──────────────────────────────────

def fetch_instagram(access_token, user_id):
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

            mid = item["id"]
            ir = requests.get(
                f"https://graph.instagram.com/v21.0/{mid}/insights",
                params={"metric": "views,reach", "access_token": access_token},
            )
            views = 0
            if ir.ok:
                for metric in ir.json().get("data", []):
                    if metric["name"] == "views":
                        views = metric.get("values", [{}])[-1].get("value", 0)

            videos.append({
                "platform": "instagram", "id": mid,
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

    return videos


# ── TikTok ─────────────────────────────────────

def fetch_tiktok(access_token):
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
            break

        data = r.json()
        for video in data.get("data", {}).get("videos", []):
            if video.get("create_time", 0) < cutoff_ts:
                continue

            videos.append({
                "platform": "tiktok", "id": video["id"],
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

    return videos


# ── UI ─────────────────────────────────────────

def _show_table(df, csv_name):
    st.success(f"Pulled {len(df)} videos → {csv_name}")
    st.dataframe(df.to_pandas(), use_container_width=True, hide_index=True)


with st.expander("YouTube", expanded=True):
    yt_secrets = os.getenv("YOUTUBE_CLIENT_SECRETS_FILE")
    yt_ready = bool(yt_secrets and Path(yt_secrets).exists())

    if not yt_ready:
        if not yt_secrets:
            st.error("YOUTUBE_CLIENT_SECRETS_FILE not set in .env")
        else:
            st.error(f"File not found: {yt_secrets}")

    if st.button("Pull YouTube", key="yt_pull", disabled=not yt_ready):
        with st.spinner("Pulling YouTube data..."):
            try:
                videos = fetch_youtube(yt_secrets)
                if videos:
                    st.session_state.yt_df = pl.DataFrame(videos).sort("published_at", descending=True)
                    st.session_state.yt_df.write_csv("youtube_stats.csv")
                else:
                    st.info("No videos found.")
            except Exception as e:
                st.error(f"YouTube failed: {e}")

    if st.session_state.yt_df is not None:
        _show_table(st.session_state.yt_df, "youtube_stats.csv")

with st.expander("Instagram", expanded=True):
    ig_token = os.getenv("INSTAGRAM_ACCESS_TOKEN")
    ig_user = os.getenv("INSTAGRAM_USER_ID")
    ig_ready = bool(ig_token and ig_user)

    if not ig_ready:
        if not ig_token:
            st.error("INSTAGRAM_ACCESS_TOKEN not set in .env")
        if not ig_user:
            st.error("INSTAGRAM_USER_ID not set in .env")

    if st.button("Pull Instagram", key="ig_pull", disabled=not ig_ready):
        with st.spinner("Pulling Instagram data..."):
            try:
                videos = fetch_instagram(ig_token, ig_user)
                if videos:
                    st.session_state.ig_df = pl.DataFrame(videos).sort("published_at", descending=True)
                    st.session_state.ig_df.write_csv("instagram_stats.csv")
                else:
                    st.info("No reels found.")
            except Exception as e:
                st.error(f"Instagram failed: {e}")

    if st.session_state.ig_df is not None:
        _show_table(st.session_state.ig_df, "instagram_stats.csv")

with st.expander("TikTok", expanded=True):
    tt_key = os.getenv("TIKTOK_CLIENT_KEY")
    tt_secret = os.getenv("TIKTOK_CLIENT_SECRET")
    tt_ready = bool(tt_key and tt_secret)

    if not tt_ready:
        if not tt_key:
            st.error("TIKTOK_CLIENT_KEY not set in .env")
        if not tt_secret:
            st.error("TIKTOK_CLIENT_SECRET not set in .env")

    if st.button("Pull TikTok", key="tt_pull", disabled=not tt_ready):
        with st.spinner("Pulling TikTok data..."):
            try:
                token = _ensure_tiktok_token(tt_key, tt_secret)
                videos = fetch_tiktok(token)
                if videos:
                    st.session_state.tt_df = pl.DataFrame(videos).sort("published_at", descending=True)
                    st.session_state.tt_df.write_csv("tiktok_stats.csv")
                else:
                    st.info("No videos found.")
            except Exception as e:
                st.error(f"TikTok failed: {e}")

    if st.session_state.tt_df is not None:
        _show_table(st.session_state.tt_df, "tiktok_stats.csv")

# ── Chart ──────────────────────────────────────

st.divider()

chart_type = st.radio(
    "Chart type",
    ["Stacked bar (vertical)", "Side-by-side bar", "Line chart"],
    horizontal=True,
)
log_y = st.checkbox("Log Y-axis scale")

totals = {}
for label, key in [("YouTube", "yt_df"), ("Instagram", "ig_df"), ("TikTok", "tt_df")]:
    df = st.session_state.get(key)
    totals[label] = int(df["views"].sum()) if df is not None else None

c1, c2, c3 = st.columns(3)
c1.metric("YouTube", f"{totals['YouTube']:,}" if totals["YouTube"] is not None else "—")
c2.metric("Instagram", f"{totals['Instagram']:,}" if totals["Instagram"] is not None else "—")
c3.metric("TikTok", f"{totals['TikTok']:,}" if totals["TikTok"] is not None else "—")

chart_placeholder = st.empty()

parts = []
vid_parts = []
for label, key in [("YouTube", "yt_df"), ("Instagram", "ig_df"), ("TikTok", "tt_df")]:
    df = st.session_state.get(key)
    if df is not None and len(df) > 0:
        df = df.with_columns(
            pl.col("published_at")
            .str.strptime(pl.Datetime, strict=False)
            .dt.convert_time_zone("US/Pacific")
            .dt.truncate("1d")
            .alias("day")
        )
        daily = df.group_by("day").agg(pl.col("views").sum()).with_columns(pl.lit(label).alias("platform"))
        parts.append(daily)
        vid_parts.append(
            df.select(["title", "views", "day"]).with_columns(pl.lit(label).alias("platform"))
        )

if not parts:
    chart_placeholder.info("No data yet. Pull data from at least one platform above.")
else:
    combined = pl.concat(parts).to_pandas()
    combined["day"] = combined["day"].dt.date
    combined = combined.sort_values(["platform", "day"])

    if log_y:
        combined = combined[combined["views"] > 0]

    COLORS = {"YouTube": "red", "Instagram": "orange", "TikTok": "black"}

    if chart_type == "Line chart":
        fig = px.line(
            combined, x="day", y="views", color="platform",
            markers=True, color_discrete_map=COLORS,
        )
    elif chart_type == "Side-by-side bar":
        fig = px.bar(
            combined, x="day", y="views", color="platform",
            barmode="group", color_discrete_map=COLORS,
        )
        fig.update_traces(texttemplate="%{y}", textposition="outside")
    else:
        fig = px.bar(
            combined, x="day", y="views", color="platform",
            barmode="stack", color_discrete_map=COLORS,
        )
        fig.update_traces(texttemplate="%{y}", textposition="inside")

    fig.update_layout(
        title="# of views on video posted each day, per platform",
        xaxis_title="Date (PT)", yaxis_title="Views",
        legend_title="Platform", hovermode="x unified",
        yaxis_type="log" if log_y else "linear",
    )
    chart_placeholder.plotly_chart(fig, use_container_width=True)

    cum = combined.sort_values(["platform", "day"]).copy()
    cum["cum_views"] = cum.groupby("platform")["views"].cumsum()
    fig_cum = px.line(
        cum, x="day", y="cum_views", color="platform",
        markers=True, color_discrete_map=COLORS,
    )
    fig_cum.update_layout(
        title="Cumulative views per platform",
        xaxis_title="Date (PT)", yaxis_title="Cumulative views",
        legend_title="Platform", hovermode="x unified",
        yaxis_type="log" if log_y else "linear",
    )
    st.plotly_chart(fig_cum, use_container_width=True)

    combined_videos = pl.concat(vid_parts).to_pandas()
    combined_videos["day"] = combined_videos["day"].dt.date
    combined_videos["short_title"] = (
        combined_videos["title"].astype(str).str.split("#").str[0].str.strip()
    )

    fig_videos = px.scatter(
        combined_videos, x="day", y="views", color="platform",
        color_discrete_map=COLORS, hover_data={"title": True, "day": False},
    )
    top = combined_videos.nlargest(6, "views")
    for i, (_, row) in enumerate(top.iterrows()):
        fig_videos.add_annotation(
            x=row["day"], y=row["views"], text=row["short_title"],
            showarrow=True, arrowhead=2, ax=0, ay=-25 - (i % 3) * 18,
            font=dict(size=10),
        )
    fig_videos.update_layout(
        title="Individual videos by views, per platform",
        xaxis_title="Date (PT)", yaxis_title="Views",
        legend_title="Platform",
        yaxis_type="log" if log_y else "linear",
    )
    st.plotly_chart(fig_videos, use_container_width=True)
