"""One-off test: how many of my recent Last.fm tracks have a cover and a preview on Deezer?

Run it with Docker from the project folder (see the README of tools):
    docker run --rm --env-file .env -v "${PWD}/tools:/tools" python:3.14-alpine python /tools/coverage.py
"""

import json
import os
import time
import unicodedata
import urllib.parse
import urllib.request

API_KEY = os.environ["LASTFM_API_KEY"]
USER = os.environ["LASTFM_USER"]
HOW_MANY = 50
LASTFM_PLACEHOLDER = "2a96cbd8b46e442fc41c2b86b821562f"  # Last.fm's grey star image


def get_json(url):
    request = urllib.request.Request(url, headers={"User-Agent": "music-viz-coverage-test"})
    with urllib.request.urlopen(request, timeout=15) as reply:
        return json.load(reply)


def simple(text):
    """Lowercase, no accents, letters and digits only: 'Beyoncé' -> 'beyonce'."""
    text = unicodedata.normalize("NFKD", text.lower())
    return "".join(c for c in text if c.isalnum())


def recent_tracks():
    url = "https://ws.audioscrobbler.com/2.0/?" + urllib.parse.urlencode({
        "method": "user.getrecenttracks", "user": USER, "api_key": API_KEY,
        "format": "json", "limit": 200,
    })
    data = get_json(url)
    if "error" in data:
        raise SystemExit(f"Last.fm error {data['error']}: {data['message']}")
    unique = {}
    for t in data["recenttracks"]["track"]:
        key = (t["artist"]["#text"], t["name"])
        if key not in unique:
            images = [i["#text"] for i in t["image"] if i["#text"]]
            unique[key] = bool(images) and LASTFM_PLACEHOLDER not in images[-1]
    return list(unique.items())[:HOW_MANY]


def on_deezer(artist, title):
    data = get_json("https://api.deezer.com/search?" + urllib.parse.urlencode({"q": f"{artist} {title}"}))
    for hit in data.get("data", [])[:10]:
        a, b = simple(artist), simple(hit["artist"]["name"])
        same_artist = a in b or b in a
        same_title = simple(hit["title_short"]) in simple(title) or simple(title) in simple(hit["title"])
        if same_artist and same_title and hit.get("preview") and hit["album"].get("cover_xl"):
            return True
    return False


tracks = recent_tracks()
found = 0
lastfm_covers = 0
for (artist, title), has_lastfm_cover in tracks:
    deezer = on_deezer(artist, title)
    found += deezer
    lastfm_covers += has_lastfm_cover
    print(f"{'OK ' if deezer else '-- '} {'cover' if has_lastfm_cover else '     '}  {artist} - {title}")
    time.sleep(0.2)  # Deezer allows 50 requests every 5 seconds

print()
print(f"{len(tracks)} different tracks tested")
print(f"Deezer cover + 30 s preview: {found}")
print(f"Real cover on Last.fm:       {lastfm_covers}")
