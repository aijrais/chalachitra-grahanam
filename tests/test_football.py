from http.client import HTTPResponse
from io import BytesIO
from pathlib import Path
from threading import Event
import json
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import football_server as fs
import hosting

VIDEO = "Ab1Cd2Ef3_4"
REQUEST = "12345678-1234-4321-a123-123456789abc"
ORIGIN = "http://localhost:8080"


class Socket:
    def __init__(self, data):
        self.input = BytesIO(data)
        self.output = BytesIO()

    def makefile(self, *args):
        return self.input

    def sendall(self, chunk):
        self.output.write(chunk)


def http(jobs, method, path, payload=None, origin=ORIGIN):
    body = json.dumps(payload).encode() if payload is not None else b""
    headers = f"{method} {path} HTTP/1.1\r\nHost: localhost:8080\r\nContent-Type: application/json\r\n"
    headers += f"X-ChalaChitra: match\r\nOrigin: {origin}\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n"
    sock = Socket(headers.encode() + body)
    server = type("Server", (), {"jobs": jobs, "allowed_origins": {ORIGIN}})()
    fs.Handler(sock, ("127.0.0.1", 12345), server)
    response = HTTPResponse(Socket(sock.output.getvalue()))
    response.begin()
    return response.status, response.read()


class FootballTests(unittest.TestCase):
    def test_preview_channel_cannot_target_live(self):
        self.assertEqual(hosting.preview_channel("football"), "football")
        for bad in ("live", "../../live", "football/live", "--x"):
            with self.assertRaises(hosting.argparse.ArgumentTypeError):
                hosting.preview_channel(bad)

    def test_same_origin_job_idempotency_retry_and_private_routes(self):
        gate = Event()
        attempts = []

        def analyse(video, progress):
            attempts.append(video)
            progress("Sampling")
            gate.wait(2)
            if len(attempts) == 1:
                raise ValueError("Video unavailable")
            return {"videoId": video}

        jobs = fs.Jobs(analyse)
        self.addCleanup(jobs.pool.shutdown)
        req = {"video": VIDEO, "request": REQUEST}
        self.assertEqual(http(jobs, "POST", "/api/jobs", req, "https://elsewhere.test")[0], 403)
        self.assertEqual(http(jobs, "POST", "/api/jobs", {**req, "video": "http://localhost/"})[0], 400)
        self.assertEqual(http(jobs, "GET", "/scripts/football_server.py")[0], 404)
        for asset in ("match.html", "match-connect.js", "football-report.js", "football.js", "session.js", "studio.css"):
            self.assertEqual(http(jobs, "GET", "/" + asset)[0], 200)
        status, body = http(jobs, "POST", "/api/jobs", req)
        self.assertEqual(status, 202)
        key = json.loads(body)["job"]
        self.assertEqual(jobs.start(VIDEO, REQUEST), key)
        self.assertEqual(http(jobs, "POST", "/api/jobs", {**req, "video": "Z9-y8X7w6V5"})[0], 409)
        gate.set()
        for attempt in range(2):
            for _ in range(100):
                state = json.loads(http(jobs, "GET", "/api/jobs/" + key)[1])
                if state["state"] != "working":
                    break
                time.sleep(.01)
            if not attempt:
                self.assertEqual(state["state"], "error")
                new_key = jobs.start(VIDEO, REQUEST)
                self.assertNotEqual(new_key, key)
                key = new_key
            else:
                self.assertEqual(state["result"]["videoId"], VIDEO)
        self.assertEqual(len(attempts), 2)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("node"), "Requires FFmpeg and Node")
    def test_48_minute_encoded_match_goes_from_id_to_timestamped_report(self):
        original_run = fs.run
        with tempfile.TemporaryDirectory() as scratch:
            fixture = Path(scratch) / "match.mp4"
            # Distributed passages in a full-length, low-frame-rate training fixture.
            graph = ("color=c=green:s=96x54:r=1:d=2929[bg];testsrc2=s=96x54:r=1:d=2929[play];"
                     "[bg][play]overlay=enable='between(t,60,65)+between(t,1400,1406)+between(t,2914,2919)'")
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", graph, "-an", "-threads", "1",
                            "-c:v", "mpeg4", str(fixture)], check=True, timeout=45)
            temp_path = None

            def fetch_or_decode(args, timeout):
                nonlocal temp_path
                if "yt_dlp" not in args:
                    return original_run(args, timeout)
                self.assertEqual(args[-1], "https://www.youtube.com/watch?v=" + VIDEO)
                temp_path = Path(args[args.index("-o") + 1]).parent
                shutil.copyfile(fixture, temp_path / "match.mp4")
                (temp_path / "match.info.json").write_text(json.dumps({"id": VIDEO, "duration": 2929, "title": "Evening game"}))
                return b""

            with patch.object(fs, "run", fetch_or_decode):
                data = fs.analyse_link(VIDEO, lambda msg: None)
            self.assertEqual(data["durationMs"], 2929000)
            self.assertEqual(data["samples"], 2929)
            self.assertFalse(data["audioScanned"])
            self.assertEqual(data["videoId"], VIDEO)
            self.assertLessEqual(data["moments"][0]["startMs"], 66000)
            self.assertGreaterEqual(data["moments"][-1]["startMs"], 2914000)
            self.assertFalse(temp_path.exists())
