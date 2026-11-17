"""One-off test: how many of my recent Last.fm tracks can be found on YouTube?

Run it with Docker from the project folder:
    docker run --rm --env-file .env -v "${PWD}/tools:/tools" python:3.14-alpine python /tools/youtube_coverage.py
"""

import json
import os
import re
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

LASTFM_KEY = os.environ["LASTFM_API_KEY"]
USER = os.environ["LASTFM_USER"]
YOUTUBE_KEY = os.environ["YOUTUBE_API_KEY"]


def get_json(url):
    request = urllib.request.Request(url, headers={"User-Agent": "music-viz-coverage-test"})
    try:
        with urllib.request.urlopen(request, timeout=15) as reply:
            return json.load(reply)
    except urllib.error.HTTPError as error:
        raise SystemExit(f"HTTP {error.code}: {error.read().decode()[:400]}")


def simple(text):
    """Lowercase, no accents, '&' -> 'and', letters and digits only."""
    text = unicodedata.normalize("NFKD", text.lower().replace("&", "and"))
    return "".join(c for c in text if c.isalnum())


def recent_tracks():
    data = get_json("https://ws.audioscrobbler.com/2.0/?" + urllib.parse.urlencode({
        "method": "user.getrecenttracks", "user": USER, "api_key": LASTFM_KEY,
        "format": "json", "limit": 200,
    }))
    seen = []
    for t in data["recenttracks"]["track"]:
        pair = (t["artist"]["#text"], t["name"])
        if pair not in seen:
            seen.append(pair)
    return seen


def matches(artist, title, video):
    """True when the video title or channel names the artist AND contains the track title."""
    text = simple(video["snippet"]["title"] + " " + video["snippet"]["channelTitle"])
    short_title = simple(re.sub(r"\(.*?\)|\[.*?\]", "", title))  # drop "(La Bande Passante 04)"
    # "Prismatik & B3N" or "A1 - Gre": one of the names is enough
    names = [simple(n) for n in re.split(r"&|,| - |feat\.|ft\.| x ", artist, flags=re.I)]
    names = [n for n in names if len(n) >= 3]
    return short_title in text and any(n in text for n in names)


def find_on_youtube(artist, title):
    data = get_json("https://www.googleapis.com/youtube/v3/search?" + urllib.parse.urlencode({
        "part": "snippet", "q": f"{artist} {title}", "type": "video",
        "videoEmbeddable": "true", "maxResults": 5, "key": YOUTUBE_KEY,
    }))
    for video in data.get("items", []):
        if matches(artist, title, video):
            return video
    return None


tracks = recent_tracks()
found = 0
for artist, title in tracks:
    video = find_on_youtube(artist, title)
    if video:
        found += 1
        print(f"OK  {artist} - {title}\n      -> {video['snippet']['title']}  ({video['snippet']['channelTitle']})  https://youtu.be/{video['id']['videoId']}")
    else:
        print(f"--  {artist} - {title}")

print()
print(f"{found} / {len(tracks)} tracks found on YouTube (embeddable, artist and title checked)")
print(f"YouTube quota used: about {len(tracks) * 100} of 10000 units today")
