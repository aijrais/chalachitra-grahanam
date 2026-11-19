#!/usr/bin/env python3
"""Publish the ChalaChitra static client from an authenticated Google Cloud Shell."""
import argparse
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
PROJECT = SITE = "chalachitram-42da6"
API = "https://firebasehosting.googleapis.com/v1beta1/"
UPLOAD_HOST = "upload-firebasehosting.googleapis.com"
BASE = "sites/" + SITE
PREVIEW = "pilot"


class ApiError(Exception):
    def __init__(self, code, message):
        self.code = code
        super().__init__(f"Firebase returned HTTP {code}: {message}")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def cloud(*args):
    return subprocess.run(["gcloud", *args], check=True, stdout=subprocess.PIPE, text=True).stdout.strip()


def check_billing(info):
    if info.get("projectId") != PROJECT or info.get("billingEnabled") is not False or info.get("billingAccountName"):
        raise ValueError("Publishing requires verified disabled billing and no linked billing account for " + PROJECT)


class Firebase:
    def __init__(self):
        self.token = cloud("auth", "print-access-token")
        self.opener = build_opener(NoRedirect())

    def call(self, method, path, data=None, binary=False):
        url = path if binary else API + path
        parsed = urlsplit(url)
        allowed_host = UPLOAD_HOST if binary else "firebasehosting.googleapis.com"
        if parsed.scheme != "https" or parsed.netloc != allowed_host:
            raise ValueError("Unexpected Hosting API host.")
        body = data if binary or data is None else json.dumps(data).encode()
        headers = {"Authorization": "Bearer " + self.token, "X-Goog-User-Project": PROJECT}
        if body is not None:
            headers["Content-Type"] = "application/octet-stream" if binary else "application/json"
        req = Request(url, data=body, headers=headers, method=method)
        try:
            with self.opener.open(req, timeout=45) as response:
                payload = response.read()
                return json.loads(payload) if payload.strip() and not binary else {}
        except HTTPError as exc:
            try:
                message = json.loads(exc.read())["error"]["message"]
            except (ValueError, KeyError, TypeError):
                message = exc.reason
            raise ApiError(exc.code, message) from None


def build_payload(root):
    public = root / "public"
    config = json.loads((root / "firebase.json").read_text())["hosting"]
    if config["site"] != SITE or config["public"] != "public":
        raise ValueError("Unexpected site or public directory.")
    headers = [{"glob": rule["source"], "headers": {h["key"]: h["value"] for h in rule["headers"]}}
               for rule in config["headers"]]
    manifest, blobs, contents = {}, {}, {}
    for path in sorted(public.rglob("*")):
        relative = path.relative_to(public)
        if any(part.startswith(".") for part in relative.parts):
            continue
        if path.is_symlink():
            raise ValueError(f"Symlinks cannot be published: {relative}")
        if path.is_file():
            contents["/" + relative.as_posix()] = path.read_bytes()
    # A new deploy installs a separate, complete offline shell before the old
    # cache is retired. This remains true when only CSS or an analyser changes.
    asset_ids = {name: hashlib.sha256(data).hexdigest() for name, data in contents.items()}
    shell_id = hashlib.sha256(json.dumps(asset_ids, sort_keys=True).encode()).hexdigest()[:16]
    if "/sw.js" in contents:
        contents["/sw.js"] = contents["/sw.js"].replace(b"chalachitra-studio-dev-1",
                                                        ("chalachitra-studio-" + shell_id).encode())
    for name, data in contents.items():
        packed = gzip.compress(data, compresslevel=9, mtime=0)
        digest = hashlib.sha256(packed).hexdigest()
        blobs[digest] = packed
        manifest[name] = digest
    if "/index.html" not in manifest:
        raise ValueError("The static client is missing index.html.")
    config = {"headers": headers}
    label = hashlib.sha256(json.dumps([manifest, config], sort_keys=True).encode()).hexdigest()[:32]
    return manifest, blobs, config, label


def channel_info(api, channel):
    path = BASE + "/channels/" + channel
    try:
        return api.call("GET", path)
    except ApiError as err:
        if err.code != 404 or channel == "live":
            raise
    try:
        return api.call("POST", BASE + "/channels?channelId=" + channel, {"ttl": "604800s"})
    except ApiError as err:
        if err.code == 409:
            return api.call("GET", path)
        raise


def known_version(name):
    return isinstance(name, str) and re.fullmatch(re.escape(BASE) + r"/versions/[A-Za-z0-9_-]+", name)


def get_resume(api, state_file, label):
    try:
        state = json.loads(state_file.read_text())
        if state.get("build") != label or not known_version(state.get("version")):
            return None
        version = api.call("GET", state["version"])
        return version if version.get("status") in ("CREATED", "FINALIZED") else None
    except (FileNotFoundError, ValueError, AttributeError):
        return None
    except ApiError as err:
        if err.code != 404:
            raise
        return None


def deploy(api, channel, root, state_file):
    manifest, blobs, config, label = build_payload(root)
    target = channel_info(api, channel)
    existing = target.get("release", {}).get("version", {}).get("name")
    if known_version(existing) and api.call("GET", existing).get("labels", {}).get("cc-build") == label:
        return target["url"]
    version = get_resume(api, state_file, label)
    if not version:
        version = api.call("POST", BASE + "/versions", {"config": config, "labels": {"cc-build": label}})
        if not known_version(version.get("name")):
            raise ValueError("Firebase returned an unexpected version name.")
        temp = state_file.with_suffix(".tmp")
        temp.write_text(json.dumps({"build": label, "version": version["name"]}))
        os.replace(temp, state_file)
    name = version["name"]
    if version["status"] == "CREATED":
        response = api.call("POST", name + ":populateFiles", {"files": manifest})
        missing = response.get("uploadRequiredHashes", [])
        if not isinstance(missing, list) or any(h not in blobs for h in missing):
            raise ValueError("Firebase requested a file outside this build.")
        if missing:
            destination = response.get("uploadUrl", "").rstrip("/")
            expected = "https://" + UPLOAD_HOST + "/upload/" + name + "/files"
            if destination != expected:
                raise ValueError("Firebase returned an unexpected upload destination.")
            for digest in missing:
                api.call("POST", destination + "/" + digest, blobs[digest], binary=True)
        api.call("PATCH", name + "?update_mask=status", {"status": "FINALIZED"})
    path = BASE + "/channels/" + channel
    api.call("POST", path + "/releases?" + urlencode({"versionName": name}), {"message": "ChalaChitra " + label[:8]})
    target = api.call("GET", path)
    if target.get("release", {}).get("version", {}).get("name") != name:
        raise ValueError("The latest channel release could not be verified. Rerun the same command.")
    return target["url"]


def preview_channel(value):
    if value == "live" or not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?", value):
        raise argparse.ArgumentTypeError("Choose a preview channel name of up to 30 lowercase letters, digits or hyphens.")
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["check", "preview", "live"])
    parser.add_argument("--channel", type=preview_channel, help="Preview channel (default: pilot)")
    args = parser.parse_args()
    if args.channel and args.action != "preview":
        parser.error("--channel applies only to preview")
    check_billing(json.loads(cloud("billing", "projects", "describe", PROJECT, "--format=json")))
    api = Firebase()
    site = api.call("GET", f"projects/{PROJECT}/sites/{SITE}")
    if site.get("name", "").split("/")[-1] != SITE:
        raise ValueError("The Hosting site did not match the expected target.")
    print(f"Verified {SITE}. Billing is disabled and unlinked.")
    if args.action == "check":
        return
    channel = "live" if args.action == "live" else (args.channel or PREVIEW)
    directory = ROOT / ".firebase"
    directory.mkdir(exist_ok=True)
    state_file = directory / ("chalachitra-" + channel + ".json")
    with state_file.with_suffix(".lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        url = deploy(api, channel, ROOT, state_file)
    print(f"{channel} release verified: {url}")


if __name__ == "__main__":
    try:
        main()
    except (ApiError, OSError, URLError, ValueError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
