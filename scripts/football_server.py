#!/usr/bin/env python3
"""Private, temporary YouTube match analyser for the owner's Cloud Shell or computer."""
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event, Lock
from time import monotonic
from urllib.parse import urlencode, urlsplit
import argparse
import json
import mimetypes
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
MAX_SECONDS = 3 * 3600
MAX_SIZE = 450 * 1024 * 1024
ID = re.compile(r"[A-Za-z0-9_-]{11}")
REQUEST_ID = re.compile(r"[a-f0-9-]{36}")
PUBLIC = frozenset({"match.html", "match-connect.js", "studio.css", "football.js", "football-report.js",
                    "session.js", "assets/barlow-regular.woff", "assets/barlow-semibold.woff", "assets/icon-192.png"})


active_lock = Lock()
active_processes = set()
stopping = Event()


def end_process(process):
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def run(args, timeout):
    # The decoder and downloader can create children of their own.
    with subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True) as process:
        with active_lock:
            active_processes.add(process)
            if stopping.is_set():
                end_process(process)
        try:
            stdout, _ = process.communicate(timeout=timeout)
        except BaseException:
            end_process(process)
            process.communicate()
            raise
        finally:
            with active_lock:
                active_processes.discard(process)
        if process.returncode:
            raise subprocess.CalledProcessError(process.returncode, args)
        return stdout


def ffmpeg_path():
    executable = shutil.which("ffmpeg")
    if executable:
        return executable
    from imageio_ffmpeg import get_ffmpeg_exe
    return get_ffmpeg_exe()


def analyse_link(video_id, progress):
    if not isinstance(video_id, str) or not ID.fullmatch(video_id):
        raise ValueError("Invalid YouTube video ID.")
    url = "https://www.youtube.com/watch?v=" + video_id
    with TemporaryDirectory(prefix="chalachitra-match-") as directory:
        progress("Reading the YouTube match")
        output = str(Path(directory) / "match.%(ext)s")
        executable = ffmpeg_path()
        bin_dir = Path(directory) / "bin"
        bin_dir.mkdir()
        (bin_dir / "ffmpeg").symlink_to(executable)
        command = [sys.executable, "-m", "yt_dlp", "--ignore-config", "--no-playlist", "--no-cache-dir",
                   "--js-runtimes", "node", "--no-progress", "--no-warnings", "--socket-timeout", "20", "--retries", "1", "--fragment-retries", "1",
                   "--match-filters", "duration > 0 & duration <= 10800 & !is_live",
                   "--max-filesize", "450M", "--write-info-json", "--ffmpeg-location", str(bin_dir), "--merge-output-format", "mkv", "-f",
                   "best[height<=360][acodec!=none]/bestvideo[height<=360]+bestaudio/bestvideo[height<=360]/worst[height<=480]", "-o", output, "--", url]
        try:
            run(command, 900)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
            raise ValueError("YouTube did not supply a playable copy to this analyser. Return to the studio and choose the original video.") from exc
        directory = Path(directory)
        meta_path = directory / "match.info.json"
        files = [p for p in directory.glob("match.*") if p != meta_path and p.suffix not in (".part", ".ytdl", ".json")]
        if len(files) != 1 or not meta_path.is_file() or not 0 < files[0].stat().st_size <= MAX_SIZE:
            raise ValueError("No supported track was available within the three-hour, 450 MiB limit. Choose the original video in the studio.")
        meta = json.loads(meta_path.read_text())
        duration = meta.get("duration")
        if meta.get("id") != video_id or not isinstance(duration, (int, float)) or not 0 < duration <= MAX_SECONDS:
            raise ValueError("The returned video identity or duration could not be verified.")
        progress("Scanning picture and available audio for match moments")
        try:
            data = json.loads(run(["node", str(ROOT / "scripts/match_frames.mjs"), str(files[0]),
                                   str(round(duration * 1000)), executable], 1000))
        except (ImportError, OSError, ValueError, subprocess.SubprocessError) as exc:
            raise ValueError("The analyser could not decode the whole recording. Try the original video in the studio.") from exc
        data.update(videoId=video_id, name=str(meta.get("title") or "YouTube match")[:255])
        return data


class Jobs:
    def __init__(self, analyse=analyse_link):
        self.analyse = analyse
        self.lock = Lock()
        self.pool = ThreadPoolExecutor(max_workers=1)
        self.items = {}

    def start(self, video_id, request):
        if not isinstance(video_id, str) or not ID.fullmatch(video_id) or not isinstance(request, str) or not REQUEST_ID.fullmatch(request):
            raise ValueError("Invalid match request.")
        with self.lock:
            self.items = {k: v for k, v in self.items.items() if monotonic() - v["t"] < 3600}
            for key, entry in self.items.items():
                if entry["request"] == request and entry["video"] == video_id and entry["state"] != "error":
                    return key
            if any(entry["state"] == "working" for entry in self.items.values()):
                raise RuntimeError("Another match is being analysed. Wait until it finishes.")
            key = secrets.token_urlsafe(24)
            self.items[key] = dict(t=monotonic(), request=request, video=video_id, state="working", message="Starting analysis")
            self.pool.submit(self.work, key, video_id)
            return key

    def work(self, key, video_id):
        def update(**fields):
            with self.lock:
                self.items[key].update(t=monotonic(), **fields)
        try:
            data = self.analyse(video_id, lambda msg: update(message=msg))
            update(state="done", result=data, message="Analysis complete")
        except ValueError as exc:
            update(state="error", message=str(exc))
        except Exception:
            update(state="error", message="The analyser could not finish. Check the setup or use the original video.")

    def get(self, key):
        with self.lock:
            item = self.items.get(key)
            if not item or monotonic() - item["t"] >= 3600:
                self.items.pop(key, None)
                return None
            return {k: item[k] for k in ("state", "message", "result") if k in item}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # No match IDs, return URLs or job tokens in access logs.

    def send(self, code, data, mime):
        self.send_response(code)
        self.send_header("Content-Type", mime)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def json(self, code, data):
        self.send(code, json.dumps(data).encode(), "application/json")

    def do_GET(self):
        path = urlsplit(self.path).path
        if path.startswith("/api/jobs/"):
            item = self.server.jobs.get(path.removeprefix("/api/jobs/"))
            return self.json(200 if item else 404, item or {"message": "This job has expired. Start a new scan."})
        asset = path.removeprefix("/") or "match.html"
        if asset not in PUBLIC:
            return self.json(404, {"message": "Unknown resource."})
        self.send(200, (ROOT / "public" / asset).read_bytes(), mimetypes.guess_type(asset)[0] or "application/octet-stream")

    def do_POST(self):
        # Browsers need a same-origin script to set this header. The service
        # offers no CORS permission and publishes no endpoints on Firebase.
        if (self.path != "/api/jobs" or self.headers.get("X-ChalaChitra") != "match" or
                self.headers.get_content_type() != "application/json" or
                self.headers.get("Origin") not in self.server.allowed_origins):
            return self.json(403, {"message": "Start analysis from the private analyser page."})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 1024:
                raise ValueError("Invalid request size.")
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError("Invalid request.")
            key = self.server.jobs.start(body.get("video"), body.get("request"))
            self.json(202, {"job": key})
        except (ValueError, TypeError) as exc:
            self.json(400, {"message": str(exc)})
        except RuntimeError as exc:
            self.json(409, {"message": str(exc)})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--studio", help="Firebase preview URL printed by the publisher")
    args = parser.parse_args()
    if args.studio and not re.fullmatch(r"https://chalachitram-42da6--[a-z0-9-]+\.web\.app/?", args.studio):
        parser.error("Use the verified Firebase preview URL.")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.jobs = Jobs()
    host = os.environ.get("WEB_HOST")
    origin = f"https://{args.port}-{host}" if host else f"http://localhost:{args.port}"
    server.allowed_origins = {origin, f"http://localhost:{args.port}", f"http://127.0.0.1:{args.port}"}
    print(f"Private analyser address: {origin}\nKeep this shell open while analysing. Ctrl-C stops it.", flush=True)
    if args.studio:
        print("Open this football preview: " + args.studio.rstrip("/") + "/#" + urlencode({"analyser": origin}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stopping.set()
        with active_lock:
            for process in active_processes:
                end_process(process)
        server.server_close()
        server.jobs.pool.shutdown(wait=True, cancel_futures=True)


if __name__ == "__main__":
    main()
