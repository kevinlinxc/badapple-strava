# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "python-dotenv",
#     "requests",
# ]
# ///
"""
Print TikTok video stats for your account.
Set TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET in .env.

Usage:
    uv run src/stats/tt_stats.py
"""
import hashlib
import http.server
import json
import os
import random
import string
import time
import urllib.parse
import webbrowser
from pathlib import Path

import requests
from dotenv import load_dotenv

load_dotenv()

CLIENT_KEY = os.getenv("TIKTOK_CLIENT_KEY")
CLIENT_SECRET = os.getenv("TIKTOK_CLIENT_SECRET")
REDIRECT_URI = os.getenv("TIKTOK_REDIRECT_URI")
TOKEN_FILE = Path(".tiktok_token.json")

if not CLIENT_KEY or not CLIENT_SECRET:
    print("Set TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET in .env", file=__import__("sys").stderr)
    raise SystemExit(1)


def get_token():
    if TOKEN_FILE.exists():
        saved = json.loads(TOKEN_FILE.read_text())
        if saved.get("expires_at", 0) > time.time() + 60:
            return saved["access_token"]

        print("Refreshing token ...")
        r = requests.post("https://open.tiktokapis.com/v2/oauth/token/", data={
            "client_key": CLIENT_KEY,
            "client_secret": CLIENT_SECRET,
            "grant_type": "refresh_token",
            "refresh_token": saved["refresh_token"],
        })
        if r.ok:
            data = r.json()
            if "error" not in data:
                saved = save_token(data)
                return saved["access_token"]
        TOKEN_FILE.unlink(missing_ok=True)

    print("Starting OAuth flow ...")

    state = "".join(random.choices(string.ascii_letters + string.digits, k=16))
    code_verifier = "".join(random.choices(string.ascii_letters + string.digits + "-._~", k=64))
    code_challenge = hashlib.sha256(code_verifier.encode()).hexdigest()

    auth_url = "https://www.tiktok.com/v2/auth/authorize/?" + urllib.parse.urlencode({
        "client_key": CLIENT_KEY,
        "response_type": "code",
        "scope": "user.info.basic,video.list",
        "redirect_uri": REDIRECT_URI,
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

    print(f"Open this URL:\n\n{auth_url}\n")
    webbrowser.open(auth_url)

    for _ in range(120):
        server.handle_request()
        if code_captured is not None:
            break

    if code_captured is None:
        manual = input("If the redirect didn't work, paste the full redirect URL: ").strip()
        if manual:
            qs = urllib.parse.urlparse(manual).query
            params = urllib.parse.parse_qs(qs)
            if "code" in params and params.get("state", [None])[0] == state:
                code_captured = params["code"][0]

    server.server_close()

    if not code_captured:
        raise RuntimeError("Authorization failed or timed out")

    r = requests.post("https://open.tiktokapis.com/v2/oauth/token/", data={
        "client_key": CLIENT_KEY,
        "client_secret": CLIENT_SECRET,
        "code": code_captured,
        "grant_type": "authorization_code",
        "redirect_uri": REDIRECT_URI,
        "code_verifier": code_verifier,
    })
    r.raise_for_status()
    data = r.json()
    if "error" in data:
        raise RuntimeError(f"Token exchange failed: {data}")

    saved = save_token(data)
    return saved["access_token"]


def save_token(data):
    now = time.time()
    saved = {
        "access_token": data["access_token"],
        "refresh_token": data["refresh_token"],
        "scope": data.get("scope", ""),
        "expires_at": now + data.get("expires_in", 86400),
    }
    TOKEN_FILE.write_text(json.dumps(saved, indent=2))
    print(f"Token saved to {TOKEN_FILE}")
    return saved


def main():
    token = get_token()
    cursor = 0
    idx = 0

    while True:
        r = requests.post(
            "https://open.tiktokapis.com/v2/video/list/",
            params={"fields": "id,title,video_description,create_time,view_count,like_count,comment_count,share_url"},
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            json={"max_count": 20, "cursor": cursor},
        )
        if not r.ok:
            print(f"Error: {r.status_code} {r.text[:300]}")
            break

        data = r.json()
        for video in data.get("data", {}).get("videos", []):
            idx += 1
            created = time.strftime("%Y-%m-%d", time.localtime(video.get("create_time", 0)))
            print(
                f"{idx:3d}. "
                f"{created}  "
                f"{video.get('view_count', 0):>10,d} views  "
                f"{video.get('like_count', 0):>8,d} likes  "
                f"{(video.get('title') or video.get('video_description') or '')[:80]}"
            )

        cursor = data.get("data", {}).get("cursor", 0)
        if not data.get("data", {}).get("has_more"):
            break


if __name__ == "__main__":
    main()
