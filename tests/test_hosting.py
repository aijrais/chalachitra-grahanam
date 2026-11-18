import gzip
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("hosting", ROOT / "scripts" / "hosting.py")
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)


class FakeHosting:
    def __init__(self):
        self.version = None
        self.target = None
        self.calls = []
        self.interrupt = False
        self.bad_host = False

    def call(self, method, path, data=None, binary=False):
        self.calls.append((method, path))
        name = h.BASE + "/versions/test"
        if binary:
            if self.interrupt:
                self.interrupt = False
                raise h.ApiError(503, "retry")
            return {}
        if path == h.BASE + "/channels/pilot" and method == "GET":
            if self.target is None:
                raise h.ApiError(404, "absent")
            return self.target
        if "?channelId=" in path:
            self.target = {"url": "https://example.invalid"}
            return self.target
        if path == h.BASE + "/versions":
            self.version = {"name": name, "status": "CREATED", "labels": data["labels"]}
            return self.version
        if path == name:
            return self.version
        if path.endswith(":populateFiles"):
            host = "other.invalid" if self.bad_host else h.UPLOAD_HOST
            return {"uploadUrl": "https://" + host + "/upload/" + name + "/files",
                    "uploadRequiredHashes": list(data["files"].values())[:1]}
        if path.endswith("?update_mask=status"):
            self.version["status"] = "FINALIZED"
            return self.version
        if "/releases?" in path:
            self.target["release"] = {"version": self.version.copy()}
            return self.target["release"]
        raise AssertionError((method, path))


class HostingTests(unittest.TestCase):
    def test_confirm_cost_boundary(self):
        base = {"projectId": h.PROJECT, "billingEnabled": False}
        h.check_billing(base)
        for changed in [{"billingEnabled": True}, {"billingAccountName": "billingAccounts/closed"},
                        {"billingEnabled": None}, {"projectId": "another"}]:
            with self.assertRaises(ValueError):
                h.check_billing(dict(base, **changed))

    def test_release_resumes_and_identical_run_is_read_only(self):
        api = FakeHosting()
        with tempfile.TemporaryDirectory() as td:
            state = Path(td) / "state.json"
            api.interrupt = True
            with self.assertRaises(h.ApiError):
                h.deploy(api, "pilot", ROOT, state)
            self.assertEqual(h.deploy(api, "pilot", ROOT, state), "https://example.invalid")
            self.assertEqual(api.calls.count(("POST", h.BASE + "/versions")), 1)
            api.calls.clear()
            h.deploy(api, "pilot", ROOT, state)
            self.assertTrue(all(method == "GET" for method, _ in api.calls))
            self.assertNotIn("token", json.loads(state.read_text()))

    def test_offline_cache_changes_with_the_served_client(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            public = root / "public"
            public.mkdir()
            (root / "firebase.json").write_bytes((ROOT / "firebase.json").read_bytes())
            (public / "sw.js").write_bytes((ROOT / "public/sw.js").read_bytes())
            (public / "index.html").write_text("first version")
            pages, blobs, _, _ = h.build_payload(root)
            first = gzip.decompress(blobs[pages["/sw.js"]])
            (public / "index.html").write_text("second version")
            pages, blobs, _, _ = h.build_payload(root)
            second = gzip.decompress(blobs[pages["/sw.js"]])
            self.assertNotEqual(first, second)
            self.assertNotIn(b"chalachitra-studio-dev-1", second)

    def test_untrusted_upload_destination_is_refused(self):
        api = FakeHosting()
        api.bad_host = True
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaisesRegex(ValueError, "upload destination"):
                h.deploy(api, "pilot", ROOT, Path(td) / "s.json")
            self.assertFalse(any("other.invalid" in path for _, path in api.calls))
