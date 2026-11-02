"""world-prepare.py against a loopback fake of the GraphysX world service. No UGFrank, no model."""
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "prepare_world.py"
TOKEN = "o" * 64
REQUEST = "00000000-0000-4000-8000-0000000000a7"
SOURCE = "00000000-0000-4000-8000-0000000000b8"
DIGEST = "c" * 64


class FakeService:
    """/healthz and the operator selector POST /world, like GraphysX-Web world-service/server.mjs."""

    def __init__(self, world="mesa-island", selector=True):
        self.world, self.selector, self.calls, self.refuse = world, selector, [], None
        self.instance_id = REQUEST
        self.drift = False
        self.can_fork = False
        self.forked_from = None
        service = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def send(self, status, body):
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                service.calls.append(("GET", self.path, self.headers.get("X-Operator-Token")))
                if self.path == "/healthz":
                    return self.send(200, {"ok": True, "tick": 5, **({"world": service.world, "instanceId": service.instance_id, "recordingId": service.instance_id} if service.selector else {}),
                                           **({"forkedFrom": service.forked_from} if service.can_fork else {})})
                return self.send(404, {"error": "no route"})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                service.calls.append(("POST", self.path, self.headers.get("X-Operator-Token"), body))
                if self.path != "/world" or not service.selector:
                    return self.send(404, {"error": "no route"})
                if self.headers.get("X-Operator-Token") != TOKEN:
                    return self.send(403, {"error": "Operator token required"})
                if service.refuse:
                    return self.send(409, {"error": service.refuse})
                previous, service.world = service.world, body["world"]
                service.forked_from = None
                if "from" in body:
                    if body["sha256"] != DIGEST:
                        return self.send(409, {"error": "Fork source does not match sha256"})
                    service.forked_from = {"instanceId": SOURCE, "tick": 81234, "sha256": body["sha256"]}
                return self.send(200, {"world": service.world, "previous": previous, "tick": 0,
                                       "recordDir": f"/data/recordings/20261030T040000Z-1-{service.world}",
                                       "instanceId": "00000000-0000-4000-8000-000000000000" if service.drift else service.instance_id,
                                       "recordingId": service.instance_id,
                                       **({"forkedFrom": service.forked_from} if service.can_fork else {})})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server.server_port}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class WorldPrepareTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env_file = Path(self.tmp.name) / "graphysx-world.env"
        self.env_file.write_text(f"# operator\nWORLD_OPERATOR_TOKEN={TOKEN}\n")
        self.service = FakeService()

    def tearDown(self):
        self.service.close()
        self.tmp.cleanup()

    def run_hook(self, *argv, url=None, mode="fresh", profiles=None, **extra):
        profile = {"url": url or self.service.url, "world": "living-island", "tokenFile": str(self.env_file),
                   "dataHost": "/native/world-data", "mode": mode, **extra}
        mappings = profiles if profiles is not None else {"graphysx-living": profile, "graphysx-mesa": {**profile, "world": "mesa-island"}}
        profile_file = Path(self.tmp.name) / "profiles.json"
        profile_file.write_text(json.dumps(mappings))
        env = {**os.environ, "AGENTX_ISLAND_WORLD_PROFILES": str(profile_file)}
        result = subprocess.run([sys.executable, "-I", str(SCRIPT), *argv], env=env, capture_output=True, text=True, timeout=30)
        self.assertNotIn(TOKEN, result.stdout + result.stderr, "the operator token never leaves the hook")
        lines = result.stdout.strip().splitlines()
        self.assertEqual(len(lines), 1, result.stdout + result.stderr)
        return result.returncode, json.loads(lines[0])

    def test_a_world_it_does_not_own_is_not_managed(self):
        code, out = self.run_hook("check", "mesa-island")
        self.assertEqual((code, out["ok"], out["managed"]), (0, True, False))
        code, out = self.run_hook("prepare", "mesa-island", REQUEST)
        self.assertEqual((code, out["managed"]), (0, False))
        self.assertEqual(self.service.calls, [], "the world service is not touched")

    def test_persistent_reuse_never_switches_or_resets_the_world(self):
        self.service.world = "living-island"
        self.service.selector = True
        code, out = self.run_hook("prepare", "graphysx-living", REQUEST, mode="reuse")
        self.assertEqual(code, 0, out)
        self.assertEqual(out["instanceId"], self.service.instance_id)
        self.assertEqual(out["recordDir"], "/native/world-data/recordings/instances/" + REQUEST)
        self.assertTrue(all(c[0] == "GET" for c in self.service.calls))
        self.service.world = "mesa-island"
        code, out = self.run_hook("prepare", "graphysx-living", REQUEST, mode="reuse")
        self.assertEqual(code, 1)
        self.assertIn("nothing changed", out["message"])
        self.assertTrue(all(c[0] == "GET" for c in self.service.calls))

    def test_profiles_keep_worlds_on_distinct_services(self):
        other = FakeService("living-island")
        try:
            profile = {"url": other.url, "world": "living-island", "tokenFile": str(self.env_file),
                       "dataHost": "/living-data", "mode": "reuse"}
            code, out = self.run_hook("prepare", "graphysx-living", REQUEST, profiles={"graphysx-living": profile})
            self.assertEqual(code, 0, out)
            self.assertEqual(self.service.calls, [], "Mesa must never be touched")
            self.assertEqual(out["recordDir"], "/living-data/recordings/instances/" + REQUEST)
        finally:
            other.close()

    def test_invalid_profile_fails_before_network_access(self):
        for profile in [{}, {"url": "http://127.0.0.1/x"}, "bad"]:
            code, out = self.run_hook("prepare", "graphysx-living", REQUEST, profiles={"graphysx-living": profile})
            self.assertEqual(code, 1)
            self.assertIn("invalid", out["message"])
        self.assertEqual(self.service.calls, [])

    def test_check_is_read_only(self):
        code, out = self.run_hook("check", "graphysx-living")
        self.assertEqual((code, out["ok"], out["world"]), (0, True, "living-island"))
        self.assertTrue(all(call[0] == "GET" for call in self.service.calls))

    def test_prepare_starts_the_chosen_island_fresh_and_names_its_recording(self):
        code, out = self.run_hook("prepare", "graphysx-living", REQUEST)
        self.assertEqual((code, out["ok"], out["world"]), (0, True, "living-island"), out)
        self.assertEqual(out["instanceId"], self.service.instance_id)
        self.assertEqual(out["recordingId"], self.service.instance_id)
        self.assertEqual(out["recordDir"], "/native/world-data/recordings/20261030T040000Z-1-living-island")
        post = next(call for call in self.service.calls if call[0] == "POST")
        self.assertEqual(post[1:], ("/world", TOKEN, {"world": "living-island", "force": True, "runId": REQUEST}))
        self.assertEqual(self.service.world, "living-island")
        # The same world again is a fresh island too (a new recording each run).
        code, out = self.run_hook("prepare", "graphysx-living", REQUEST)
        self.assertEqual(out["message"], "fresh living-island (was living-island)")

    def test_same_type_identity_drift_during_preparation_refuses(self):
        self.service.drift = True
        code, out = self.run_hook("prepare", "graphysx-living", REQUEST)
        self.assertEqual(code, 1)
        self.assertIn("instance changed", out["message"])

    def test_refusals_are_honest(self):
        self.service.refuse = "synthetic refusal"
        code, out = self.run_hook("prepare", "graphysx-living", REQUEST)
        self.assertEqual((code, out["ok"]), (1, False))
        self.assertIn("refused (409): synthetic refusal", out["message"])
        self.env_file.write_text("WORLD_OPERATOR_TOKEN=short\n")
        code, out = self.run_hook("check", "graphysx-living")
        self.assertIn("operator token is unreadable", out["message"])
        self.env_file.write_text(f"WORLD_OPERATOR_TOKEN={'x' * 64}\n")
        self.service.refuse = None
        code, out = self.run_hook("prepare", "graphysx-living", REQUEST)
        self.assertIn("refused (403)", out["message"])
        down = FakeService()
        url = down.url
        down.close()
        code, out = self.run_hook("check", "graphysx-living", url=url)
        self.assertEqual((code, out["ok"]), (1, False))
        self.assertIn("does not answer", out["message"])
        for argv in [("prepare", "graphysx-living"), ("prepare", "graphysx-living", "x"), ("select", "graphysx-living"), ()]:
            code, out = self.run_hook(*argv)
            self.assertEqual(code, 1, argv)

    def test_fork_starts_each_run_from_the_pinned_saved_island(self):
        self.service.can_fork = True
        code, out = self.run_hook("check", "graphysx-living", mode="fork", **{"from": "living-before.json", "sha256": DIGEST})
        self.assertEqual((code, out["ok"]), (0, True), out)
        self.assertTrue(all(call[0] == "GET" for call in self.service.calls), "check never writes")
        code, out = self.run_hook("prepare", "graphysx-living", REQUEST, mode="fork", **{"from": "living-before.json", "sha256": DIGEST})
        self.assertEqual((code, out["ok"], out["world"]), (0, True, "living-island"), out)
        post = next(call for call in self.service.calls if call[0] == "POST")
        self.assertEqual(post[1:], ("/world", TOKEN, {"world": "living-island", "force": True, "runId": REQUEST,
                                                      "from": "living-before.json", "sha256": DIGEST}))
        self.assertEqual(out["instanceId"], self.service.instance_id)
        self.assertEqual(out["forkedFrom"], {"instanceId": SOURCE, "tick": 81234, "sha256": DIGEST})
        self.assertIn("fork living-island from living-before.json", out["message"])

    def test_fork_refuses_a_wrong_pin_and_a_service_that_cannot_fork(self):
        self.service.can_fork = True
        code, out = self.run_hook("prepare", "graphysx-living", REQUEST, mode="fork", **{"from": "living-before.json", "sha256": "d" * 64})
        self.assertEqual((code, out["ok"]), (1, False))
        self.assertIn("does not match sha256", out["message"])
        # A service from before forking would silently start a fresh island: never call it.
        self.service.can_fork = False
        self.service.calls.clear()
        for action in (("check", "graphysx-living"), ("prepare", "graphysx-living", REQUEST)):
            code, out = self.run_hook(*action, mode="fork", **{"from": "living-before.json", "sha256": DIGEST})
            self.assertEqual(code, 1)
            self.assertIn("cannot fork", out["message"])
        self.assertFalse(any(call[0] == "POST" for call in self.service.calls))

    def test_fork_profile_needs_a_plain_file_and_a_digest(self):
        for extra in ({}, {"from": "../x.json", "sha256": DIGEST}, {"from": "x.json"}, {"from": "x.json", "sha256": "ABC"}, {"from": "/srv/x.json", "sha256": DIGEST}):
            code, out = self.run_hook("prepare", "graphysx-living", REQUEST, mode="fork", **extra)
            self.assertEqual(code, 1, extra)
            self.assertIn("invalid world profile", out["message"])
        self.assertEqual(self.service.calls, [])

    def test_a_service_without_selector_keeps_mesa_and_refuses_the_living_island(self):
        self.service.selector = False
        code, out = self.run_hook("check", "graphysx-living")
        self.assertEqual(code, 1)
        self.assertIn("no world selector", out["message"])
        code, out = self.run_hook("prepare", "graphysx-mesa", REQUEST)
        self.assertEqual((code, out["ok"], out["recordDir"]), (0, True, None))
        self.assertFalse(any(call[0] == "POST" for call in self.service.calls))


if __name__ == "__main__":
    unittest.main()
