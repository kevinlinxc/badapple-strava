# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "python-dotenv",
#     "requests",
# ]
# ///
"""
Print Instagram reel stats for your business/creator account.
Set INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_USER_ID in .env.

Usage:
    uv run src/stats/ig_stats.py
"""
import os
import sys

from dotenv import load_dotenv

load_dotenv()

ACCESS_TOKEN = os.getenv("INSTAGRAM_ACCESS_TOKEN")
USER_ID = os.getenv("INSTAGRAM_USER_ID")

if not ACCESS_TOKEN or not USER_ID:
    print("Set INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_USER_ID in .env", file=sys.stderr)
    sys.exit(1)

import requests

after_cursor = None
idx = 0

while True:
    r = requests.get(
        f"https://graph.instagram.com/v21.0/{USER_ID}/media",
        params={
            "fields": "id,caption,media_type,permalink,timestamp,like_count,comments_count",
            "access_token": ACCESS_TOKEN,
            "limit": 100,
            **( {"after": after_cursor} if after_cursor else {}),
        },
    )
    r.raise_for_status()
    data = r.json()

    for item in data.get("data", []):
        if item.get("media_type") != "VIDEO":
            continue

        idx += 1
        mid = item["id"]

        ir = requests.get(
            f"https://graph.instagram.com/v21.0/{mid}/insights",
            params={"metric": "views", "access_token": ACCESS_TOKEN},
        )
        views = 0
        if ir.ok:
            for metric in ir.json().get("data", []):
                if metric["name"] == "views":
                    views = metric.get("values", [{}])[-1].get("value", 0)

        print(
            f"{idx:3d}. "
            f"{item.get('timestamp', '')[:10]}  "
            f"{int(views):>10,d} views  "
            f"{int(item.get('like_count', 0)):>8,d} likes  "
            f"{(item.get('caption') or '')[:80]}"
        )

    after_cursor = data.get("paging", {}).get("cursors", {}).get("after")
    if not after_cursor:
        break
