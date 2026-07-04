"""
Streamlit dashboard for pulling video stats from YouTube, Instagram, and TikTok.
"""
import importlib
import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

import polars as pl
import plotly.express as px
import streamlit as st
from dotenv import load_dotenv

load_dotenv()

SHARED_MODULE = "11_short_videos_stats"
sys.path.insert(0, str(Path(__file__).parent))
shared = importlib.import_module(SHARED_MODULE)

PACIFIC = timezone(timedelta(hours=-7))
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

# Load cached CSVs into session state on first run only
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
    df: pl.DataFrame | None = st.session_state.get(key)
    totals[label] = int(df["views"].sum()) if df is not None else None

c1, c2, c3 = st.columns(3)
c1.metric("YouTube", f"{totals['YouTube']:,}" if totals["YouTube"] is not None else "—")
c2.metric("Instagram", f"{totals['Instagram']:,}" if totals["Instagram"] is not None else "—")
c3.metric("TikTok", f"{totals['TikTok']:,}" if totals["TikTok"] is not None else "—")

chart_placeholder = st.empty()

# Build chart data every rerun from session state
parts = []
for label, key in [("YouTube", "yt_df"), ("Instagram", "ig_df"), ("TikTok", "tt_df")]:
    df: pl.DataFrame | None = st.session_state.get(key)
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

if not parts:
    chart_placeholder.info("No data yet. Pull data from at least one platform above.")
else:
    combined = pl.concat(parts).to_pandas()
    combined["day"] = combined["day"].dt.date
    combined = combined.sort_values(["platform", "day"])

    COLORS = {"YouTube": "red", "Instagram": "pink", "TikTok": "black"}

    if chart_type == "Line chart":
        fig = px.line(
            combined, x="day", y="views", color="platform",
            markers=True,
            color_discrete_map=COLORS,
        )
        for _, row in combined.iterrows():
            fig.add_annotation(
                x=row["day"], y=row["views"],
                text=str(int(row["views"])),
                showarrow=False,
                yshift=10,
            )
    elif chart_type == "Side-by-side bar":
        fig = px.bar(
            combined, x="day", y="views", color="platform",
            barmode="group",
            color_discrete_map=COLORS,
        )
        fig.update_traces(texttemplate="%{y}", textposition="outside")
    else:
        fig = px.bar(
            combined, x="day", y="views", color="platform",
            barmode="stack",
            color_discrete_map=COLORS,
        )
        fig.update_traces(texttemplate="%{y}", textposition="inside")

    fig.update_layout(
        title="# of views on video posted each day, per platform",
        xaxis_title="Date (PT)",
        yaxis_title="Views",
        legend_title="Platform",
        hovermode="x unified",
        yaxis_type="log" if log_y else "linear",
    )
    chart_placeholder.plotly_chart(fig, use_container_width=True)