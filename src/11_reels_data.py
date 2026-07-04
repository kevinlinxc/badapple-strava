"""
Streamlit dashboard for pulling video stats from YouTube, Instagram, and TikTok.
"""
import importlib
import os
import sys
from datetime import datetime
from pathlib import Path

import polars as pl
import streamlit as st
from dotenv import load_dotenv

load_dotenv()

SHARED_MODULE = "11_short_videos_stats"
sys.path.insert(0, str(Path(__file__).parent))
shared = importlib.import_module(SHARED_MODULE)

st.set_page_config(page_title="Video Stats", layout="wide")
st.title("Video Stats Dashboard")

AFTER_DATE = st.sidebar.date_input(
    "After date", value=datetime(2026, 4, 30),
    help="Only show videos after this date",
)
shared.AFTER_DATE = datetime.combine(AFTER_DATE, datetime.min.time())

for key in ("yt_df", "ig_df", "tt_df"):
    if key not in st.session_state:
        st.session_state[key] = None


def _show_table(df, csv_name):
    st.success(f"Pulled {len(df)} videos → {csv_name}")
    st.dataframe(df.to_pandas(), use_container_width=True, hide_index=True)


# ── YouTube ────────────────────────────────────

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
                videos = shared.fetch_youtube(yt_secrets)
                if videos:
                    st.session_state.yt_df = pl.DataFrame(videos).sort("published_at", descending=True)
                    st.session_state.yt_df.write_csv("youtube_stats.csv")
                else:
                    st.info("No videos found.")
            except Exception as e:
                st.error(f"YouTube failed: {e}")

    if st.session_state.yt_df is not None:
        _show_table(st.session_state.yt_df, "youtube_stats.csv")

# ── Instagram ──────────────────────────────────

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
                videos = shared.fetch_instagram(ig_token, ig_user)
                if videos:
                    st.session_state.ig_df = pl.DataFrame(videos).sort("published_at", descending=True)
                    st.session_state.ig_df.write_csv("instagram_stats.csv")
                else:
                    st.info("No reels found.")
            except Exception as e:
                st.error(f"Instagram failed: {e}")

    if st.session_state.ig_df is not None:
        _show_table(st.session_state.ig_df, "instagram_stats.csv")

# ── TikTok ─────────────────────────────────────

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
                token = shared._ensure_tiktok_token(tt_key, tt_secret)
                videos = shared.fetch_tiktok(token)
                if videos:
                    st.session_state.tt_df = pl.DataFrame(videos).sort("published_at", descending=True)
                    st.session_state.tt_df.write_csv("tiktok_stats.csv")
                else:
                    st.info("No videos found.")
            except Exception as e:
                st.error(f"TikTok failed: {e}")

    if st.session_state.tt_df is not None:
        _show_table(st.session_state.tt_df, "tiktok_stats.csv")
