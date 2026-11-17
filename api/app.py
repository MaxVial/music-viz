"""Music-Vidz API: my recent Last.fm tracks, each one matched with a YouTube video."""

import html
import json
import os
import re
import unicodedata

import redis
import requests
from flask import Flask, jsonify

app = Flask(__name__)
db = redis.Redis(host=os.environ["DB_HOST"], decode_responses=True)

# The keys come from .env (through compose.yaml): they never reach the browser.
LASTFM_KEY = os.environ.get("LASTFM_API_KEY", "")
LASTFM_USER = os.environ.get("LASTFM_USER", "")
YOUTUBE_KEY = os.environ.get("YOUTUBE_API_KEY", "")

LASTFM_CACHE_SECONDS = 60


class ApiError(Exception):
    """An outside service failed. The message is meant to be shown on the page."""

    def __init__(self, message, status=502):
        super().__init__(message)
        self.message = message
        self.status = status


@app.errorhandler(ApiError)
def api_error(error):
    return jsonify(error=error.message), error.status


@app.errorhandler(redis.exceptions.ConnectionError)
def redis_down(error):
    return jsonify(error="Le cache Redis ne répond pas. Lance « docker compose up »."), 503


# ---------- Last.fm ----------

def recent_tracks():
    """My last 200 scrobbles, without duplicates. Cached in Redis for 60 seconds."""
    cached = db.get("lastfm:recent")
    if cached:
        print("Last.fm : servi par le cache", flush=True)
        return json.loads(cached), "cache"

    if not LASTFM_KEY or not LASTFM_USER:
        raise ApiError("LASTFM_API_KEY ou LASTFM_USER est vide dans le fichier .env.", 500)

    print("Last.fm : appel réseau", flush=True)
    try:
        reply = requests.get("https://ws.audioscrobbler.com/2.0/", timeout=10, params={
            "method": "user.getrecenttracks", "user": LASTFM_USER, "api_key": LASTFM_KEY,
            "format": "json", "limit": 200,
        })
        data = reply.json()
    except (requests.RequestException, ValueError):
        raise ApiError("Last.fm ne répond pas. Réessaie dans une minute.")
    if "error" in data:
        raise ApiError(f"Last.fm a refusé la demande : {data.get('message', 'erreur inconnue')}")

    tracks, seen = [], set()
    for t in data["recenttracks"]["track"]:
        artist, title = t["artist"]["#text"], t["name"]
        if (artist, title) in seen:  # already listed (the first one is the most recent)
            continue
        seen.add((artist, title))
        tracks.append({
            "artist": artist,
            "title": title,
            # Unix time of the listen; None when the track is playing right now
            "playedAt": int(t["date"]["uts"]) if "date" in t else None,
        })

    db.set("lastfm:recent", json.dumps(tracks), ex=LASTFM_CACHE_SECONDS)
    return tracks, "lastfm"


# ---------- YouTube (same matching logic as tools/youtube_coverage.py) ----------

def simple(text):
    """Lowercase, no accents, '&' -> 'and', letters and digits only."""
    text = unicodedata.normalize("NFKD", text.lower().replace("&", "and"))
    return "".join(c for c in text if c.isalnum())


def matches(artist, title, video):
    """True when the video title or channel names the artist AND contains the track title."""
    snippet = video["snippet"]
    # YouTube writes "&amp;" or "&#39;" in titles: html.unescape turns them back into & and '
    text = simple(html.unescape(snippet["title"]) + " " + html.unescape(snippet["channelTitle"]))
    short_title = simple(re.sub(r"\(.*?\)|\[.*?\]", "", title))  # drop "(La Bande Passante 04)"
    # "Prismatik & B3N" or "A1 - Gre": one of the names is enough
    names = [simple(n) for n in re.split(r"&|,| - |feat\.|ft\.| x ", artist, flags=re.I)]
    names = [n for n in names if len(n) >= 3]
    return short_title in text and any(n in text for n in names)


def find_video(artist, title):
    """{videoId, thumbnail} or None. Cached in Redis forever, "not found" included."""
    key = f"youtube:{artist}|{title}"
    cached = db.get(key)
    if cached is not None:
        return json.loads(cached)  # "null" in Redis -> None: we already know it is not there

    if not YOUTUBE_KEY:
        raise ApiError("YOUTUBE_API_KEY est vide dans le fichier .env.", 500)

    print(f"YouTube : recherche de {artist} - {title} (100 unités)", flush=True)
    try:
        reply = requests.get("https://www.googleapis.com/youtube/v3/search", timeout=10, params={
            "part": "snippet", "q": f"{artist} {title}", "type": "video",
            "videoEmbeddable": "true", "maxResults": 5, "key": YOUTUBE_KEY,
        })
        data = reply.json()
    except (requests.RequestException, ValueError):
        raise ApiError("YouTube ne répond pas. Réessaie dans une minute.")
    if "error" in data:
        reasons = [e.get("reason") for e in data["error"].get("errors", [])]
        if "quotaExceeded" in reasons:
            raise ApiError("Le quota YouTube du jour est épuisé. Il revient vers 9 h (heure de Paris).")
        raise ApiError(f"YouTube a refusé la recherche : {data['error'].get('message', 'erreur inconnue')}")

    video = None
    for item in data.get("items", []):
        thumbnails = item["snippet"]["thumbnails"]
        picture = thumbnails.get("maxres") or thumbnails.get("high")
        if picture and matches(artist, title, item):
            video = {"videoId": item["id"]["videoId"], "thumbnail": picture["url"]}
            break

    db.set(key, json.dumps(video))  # no expiry: a search costs 100 of our 10 000 daily units
    return video


# ---------- Route ----------

@app.get("/tracks")
def tracks():
    played, source = recent_tracks()

    found, warning = [], None
    for track in played:
        try:
            video = find_video(track["artist"], track["title"])
        except ApiError as error:
            warning = error.message  # keep what we already found, stop asking YouTube
            break
        if video:  # only tracks with a cover AND music
            found.append(track | video)

    if warning and not found:
        return jsonify(error=warning), 502
    return jsonify(user=LASTFM_USER, lastfm=source, count=len(found), warning=warning, tracks=found)
