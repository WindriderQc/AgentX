"""remote_world.py: a running remote world relayed as a local Clawblox world. No network beyond loopback."""
import http.client
import json
import os
import signal
import subprocess
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

KIT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(KIT))
from remote_world import ACCESS_HEADER, MAX_BODY, RemoteWorldRelay, Upstream, parse_target, read_access_token  # noqa: E402

PNG = b"\x89PNG\r\n\x1a\n" + bytes(range(256)) * 4


class FakeWorld:
    """A loopback world server that records what reaches it."""

    def __init__(self):
        self.calls = []
        calls = self.calls
        # world_id: /healthz answers {ok, tick, world} like a GraphysX world service (None: legacy
        # shape). access: the token an instance proxy would demand on the agent routes.
        self.world_id = None
        self.access = None
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def answer(self, status, body, content_type="application/json", extra=()):
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                for name, value in extra:
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(body)

            def handle_any(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                calls.append({"method": self.command, "path": self.path, "headers": dict(self.headers), "body": body})
                path = self.path.partition("?")[0]
                if fake.access is not None and path != "/healthz" and self.headers.get(ACCESS_HEADER) != fake.access:
                    return self.answer(403, b"Island access token required", "text/plain")
                if path == "/healthz" and (fake.world_id is not None or fake.access is not None):
                    extra = {"world": fake.world_id} if fake.world_id else {}
                    return self.answer(200, json.dumps({"ok": True, "tick": 7, **extra}).encode())
                if path == "/observe/image":
                    return self.answer(200, PNG, "image/png")
                if path == "/redirect-me" or self.headers.get("X-Session") == "redirect":
                    return self.answer(302, b"", extra=[("Location", "https://elsewhere.invalid/")])
                if path == "/join":
                    return self.answer(200, json.dumps({"session": "s-1", "agent_id": "a-1"}).encode(),
                                       extra=[("Set-Cookie", "world=private")])
                if path == "/api.md":
                    return self.answer(200, b"# Mesa World\n", "text/markdown; charset=utf-8")
                return self.answer(200, json.dumps({"tick": 7, "path": self.path}).encode())

            do_GET = do_POST = do_PUT = handle_any

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        # The TLS test sends a handshake to this plain server; its complaint is expected noise.
        self.server.handle_error = lambda *_: None
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server.server_port}"


def request(port, method, path, body=b"", headers=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        conn.request(method, path, body=body or None, headers=headers or {})
        response = conn.getresponse()
        return response.status, dict(response.getheaders()), response.read()
    finally:
        conn.close()


class RemoteWorldTests(unittest.TestCase):
    def setUp(self):
        self.world = FakeWorld().__enter__()
        self.lines = []
        self.relay = RemoteWorldRelay(self.world.url, log=self.lines.append).__enter__()

    def tearDown(self):
        self.relay.__exit__(None, None, None)
        self.world.__exit__(None, None, None)

    def test_relays_the_agent_surface_with_only_session_and_content_type(self):
        status, headers, body = request(self.relay.port, "POST", "/join?name=Eko",
                                        headers={"X-Session": "old-session", "Cookie": "c=1", "Authorization": "Bearer secret"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["session"], "s-1")
        self.assertNotIn("Set-Cookie", headers, "a cookie never reaches the agent")
        seen = self.world.calls[-1]
        self.assertEqual((seen["method"], seen["path"]), ("POST", "/join?name=Eko"))
        self.assertEqual(seen["headers"].get("X-Session"), "old-session")
        self.assertNotIn("Cookie", seen["headers"])
        self.assertNotIn("Authorization", seen["headers"])
        status, _, body = request(self.relay.port, "POST", "/input", json.dumps({"type": "Jump", "data": {}}).encode(),
                                  {"X-Session": "s-1", "Content-Type": "application/json"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(self.world.calls[-1]["body"]), {"type": "Jump", "data": {}})
        self.assertEqual(self.world.calls[-1]["headers"]["Content-Type"], "application/json")
        status, headers, body = request(self.relay.port, "GET", "/observe/image?width=320&height=180", headers={"X-Session": "s-1"})
        self.assertEqual((status, headers["Content-Type"], body), (200, "image/png", PNG), "images pass through byte for byte")
        self.assertEqual(request(self.relay.port, "GET", "/api.md")[2], b"# Mesa World\n")
        for method, path in [("GET", "/observe"), ("GET", "/healthz"), ("POST", "/chat"), ("GET", "/chat/messages?limit=5"), ("POST", "/leave")]:
            self.assertEqual(request(self.relay.port, method, path, headers={"X-Session": "s-1"})[0], 200, path)

    def test_refuses_everything_else_without_reaching_the_world(self):
        # http.server itself rewrites a leading "//" to "/", so "//observe" is the real route.
        before = len(self.world.calls)
        for method, path in [("GET", "/snapshot"), ("GET", "/spectate"), ("PUT", "/input"), ("GET", "/join"),
                             ("GET", "/observe?x=1"), ("GET", "/api.md?x"), ("DELETE", "/observe"),
                             ("GET", "/observe/"), ("GET", "/Observe"), ("GET", "/redirect-me")]:
            self.assertEqual(request(self.relay.port, method, path)[0], 404, f"{method} {path}")
        conn = http.client.HTTPConnection("127.0.0.1", self.relay.port, timeout=10)
        conn.putrequest("GET", "http://127.0.0.1:1/observe", skip_host=True)
        conn.putheader("Host", "x")
        conn.endheaders()
        self.assertEqual(conn.getresponse().status, 404, "an absolute target is not a route")
        conn.close()
        self.assertEqual(len(self.world.calls), before)

    def test_bounds_bodies_headers_redirects_and_logs(self):
        self.assertEqual(request(self.relay.port, "POST", "/chat", b"x" * (MAX_BODY + 1))[0], 413)
        conn = http.client.HTTPConnection("127.0.0.1", self.relay.port, timeout=10)
        conn.putrequest("GET", "/observe")
        conn.putheader("X-Session", "a")
        conn.putheader("X-Session", "b")
        conn.endheaders()
        self.assertEqual(conn.getresponse().status, 400, "one X-Session at most")
        conn.close()
        status, _, body = request(self.relay.port, "GET", "/observe", headers={"X-Session": "redirect"})
        self.assertEqual(status, 502)
        self.assertIn("redirect", json.loads(body)["error"])
        self.assertTrue(any(line.startswith("remote-world 200 POST /") or line.startswith("remote-world 413 POST /chat") for line in self.lines))
        self.assertFalse(any("redirect" in line or "s-1" in line for line in self.lines), "no session token in the log")

    def test_unreachable_and_tls_failures_are_502(self):
        down = FakeWorld()
        port = down.server.server_port
        down.server.server_close()
        with RemoteWorldRelay(f"http://127.0.0.1:{port}", log=lambda _: None) as relay:
            status, _, body = request(relay.port, "GET", "/observe")
            self.assertEqual((status, json.loads(body)["error"]), (502, "The remote world is unreachable"))
        # A plain HTTP server behind an https:// target fails the TLS handshake.
        with RemoteWorldRelay(f"https://127.0.0.1:{self.world.server.server_port}", log=lambda _: None) as relay:
            status, _, body = request(relay.port, "GET", "/observe")
            self.assertEqual(status, 502)
            self.assertIn("TLS", json.loads(body)["error"])


class TargetAndListenerTests(unittest.TestCase):
    def test_targets(self):
        self.assertEqual(parse_target("https://agentx.example:18794").port, 18794)
        self.assertEqual(parse_target("http://127.0.0.1:18120/").hostname, "127.0.0.1")
        for bad in ["http://192.168.2.99:18794", "ftp://x", "https://user:pw@x", "https://x/path", "https://x?q=1", "https://"]:
            with self.assertRaises(ValueError, msg=bad):
                parse_target(bad)

    def test_listens_on_loopback_only(self):
        with self.assertRaises(ValueError):
            RemoteWorldRelay("http://127.0.0.1:1", host="0.0.0.0")


class CommandTests(unittest.TestCase):
    def test_runs_as_a_clawblox_delegated_world(self):
        with FakeWorld() as world:
            probe = ThreadingHTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler)
            port = probe.server_port
            probe.server_close()
            env = {**os.environ, "WORLD_HOST": "127.0.0.1", "WORLD_PORT": str(port), "WORLD_BASE_PATH": "/",
                   "WORLD_RECORD": "1", "WORLD_RECORD_DIR": "/nonexistent"}
            proc = subprocess.Popen([sys.executable, "-I", str(KIT / "remote_world.py"), "--target", world.url],
                                    env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                line = proc.stdout.readline()
                self.assertIn(f"remote world relay on http://127.0.0.1:{port} -> http://127.0.0.1:", line)
                deadline = time.monotonic() + 5
                while True:
                    try:
                        status, _, body = request(port, "GET", "/api.md")
                        break
                    except OSError:
                        if time.monotonic() > deadline:
                            raise
                        time.sleep(0.05)
                self.assertEqual((status, body), (200, b"# Mesa World\n"))
                proc.send_signal(signal.SIGTERM)
                self.assertEqual(proc.wait(timeout=5), 0)
            finally:
                if proc.poll() is None:
                    proc.kill()
                proc.stdout.close()
                proc.stderr.close()

    def test_refuses_a_base_path_or_a_missing_port(self):
        for env in [{"WORLD_PORT": ""}, {"WORLD_PORT": "18080", "WORLD_BASE_PATH": "/x"}]:
            result = subprocess.run([sys.executable, "-I", str(KIT / "remote_world.py"), "--target", "http://127.0.0.1:1"],
                                    env={**os.environ, **env}, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 2, env)


TOKEN = "t" * 40


class AccessAndWorldGuardTests(unittest.TestCase):
    def setUp(self):
        self.world = FakeWorld().__enter__()
        self.world.world_id = "living-island"
        self.world.access = TOKEN
        self.lines = []

    def tearDown(self):
        self.world.__exit__(None, None, None)

    def test_access_header_reaches_the_world_but_never_the_agent_or_the_log(self):
        with RemoteWorldRelay(self.world.url, log=self.lines.append, access_token=TOKEN) as relay:
            status, headers, body = request(relay.port, "POST", "/join?name=Eko", headers={ACCESS_HEADER: "forged-by-agent"})
            self.assertEqual(status, 200)
            self.assertEqual(self.world.calls[-1]["headers"].get(ACCESS_HEADER), TOKEN, "the runner's token replaces any caller value")
            self.assertNotIn(TOKEN, json.dumps(headers) + body.decode())
            for method, path in [("GET", "/observe"), ("POST", "/input"), ("GET", "/api.md"), ("GET", "/observe/image")]:
                request(relay.port, method, path, headers={"X-Session": "s-1"})
                self.assertEqual(self.world.calls[-1]["headers"].get(ACCESS_HEADER), TOKEN, path)
        self.assertFalse(any(TOKEN in line for line in self.lines), "the access token is never logged")

    def test_without_the_token_the_gate_refuses(self):
        with RemoteWorldRelay(self.world.url, log=lambda _: None) as relay:
            self.assertEqual(request(relay.port, "POST", "/join?name=Eko")[0], 403)

    def test_healthz_turns_503_when_the_shared_world_changes(self):
        with RemoteWorldRelay(self.world.url, log=lambda _: None, access_token=TOKEN, expect_world="living-island") as relay:
            self.assertEqual(request(relay.port, "GET", "/healthz")[0], 200)
            self.world.world_id = "mesa-island"  # an operator switched the island under the run
            status, _, body = request(relay.port, "GET", "/healthz")
            self.assertEqual(status, 503)
            self.assertIn("mesa-island, not living-island", json.loads(body)["error"])

    def test_legacy_healthz_counts_as_mesa(self):
        self.world.world_id = None
        upstream = Upstream(self.world.url, access_token=TOKEN)
        self.assertTrue(upstream.check("mesa-island")["ok"])
        self.assertEqual(upstream.check("living-island")["problems"], ["the remote world runs mesa-island, not living-island"])

    def test_check_reports_world_gate_and_reachability(self):
        good = Upstream(self.world.url, access_token=TOKEN).check("living-island")
        self.assertEqual((good["ok"], good["world"], good["tick"], good["accessHeader"]), (True, "living-island", 7, True))
        self.assertNotIn(TOKEN, json.dumps(good))
        gated = Upstream(self.world.url).check("living-island")
        self.assertFalse(gated["ok"])
        self.assertIn("/api.md answered 403 (access gate or world)", gated["problems"])
        self.assertFalse(any(call["path"].startswith("/join") for call in self.world.calls), "a check never joins")
        down = FakeWorld()
        port = down.server.server_port
        down.server.server_close()
        gone = Upstream(f"http://127.0.0.1:{port}", access_token=TOKEN).check("living-island")
        self.assertEqual(gone["problems"][0], "/healthz answered 502")


class AccessTokenFileTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.dir = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil
        shutil.rmtree(self.dir, ignore_errors=True)

    def write(self, name, text, mode=0o600):
        path = self.dir / name
        path.write_text(text)
        path.chmod(mode)
        return path

    def test_reads_a_private_token(self):
        self.assertEqual(read_access_token(str(self.write("ok", TOKEN + "\n"))), TOKEN)

    def test_refuses_shared_symlinked_missing_or_malformed_files(self):
        shared = self.write("shared", TOKEN, 0o644)
        link = self.dir / "link"
        link.symlink_to(self.write("target", TOKEN))
        for path, why in [(shared, "group or others"), (link, "regular file"), (self.dir / "absent", "unreadable"),
                          (self.write("short", "abc"), "32 to 512"), (self.write("spaces", "a b" * 20), "32 to 512")]:
            with self.assertRaises(ValueError, msg=str(path)) as caught:
                read_access_token(str(path))
            self.assertIn(why, str(caught.exception))


class GuardedCommandTests(unittest.TestCase):
    def free_port(self):
        probe = ThreadingHTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler)
        port = probe.server_port
        probe.server_close()
        return port

    def test_probe_prints_one_json_line_and_serves_nothing(self):
        import tempfile
        with FakeWorld() as world, tempfile.TemporaryDirectory() as tmp:
            world.world_id, world.access = "living-island", TOKEN
            token = Path(tmp) / "world.token"
            token.write_text(TOKEN)
            token.chmod(0o600)
            env = {key: value for key, value in os.environ.items() if not key.startswith("WORLD_")}
            base = [sys.executable, "-I", str(KIT / "remote_world.py"), "--target", world.url, "--probe"]
            ok = subprocess.run(base + ["--expect-world", "living-island", "--access-token-file", str(token)],
                                env=env, capture_output=True, text=True, timeout=20)
            self.assertEqual(ok.returncode, 0, ok.stdout + ok.stderr)
            self.assertTrue(json.loads(ok.stdout)["ok"])
            self.assertNotIn(TOKEN, ok.stdout + ok.stderr)
            wrong = subprocess.run(base + ["--expect-world", "mesa-island", "--access-token-file", str(token)],
                                   env=env, capture_output=True, text=True, timeout=20)
            self.assertEqual(wrong.returncode, 1)
            self.assertIn("runs living-island, not mesa-island", json.loads(wrong.stdout)["problems"][0])
            token.chmod(0o640)
            shared = subprocess.run(base + ["--access-token-file", str(token)], env=env, capture_output=True, text=True, timeout=20)
            self.assertEqual(shared.returncode, 1)
            self.assertFalse(json.loads(shared.stdout)["ok"])
            self.assertFalse(any(call["path"].startswith("/join") for call in world.calls))

    def test_start_refuses_another_world_before_listening(self):
        with FakeWorld() as world:
            world.world_id = "mesa-island"
            port = self.free_port()
            env = {**os.environ, "WORLD_HOST": "127.0.0.1", "WORLD_PORT": str(port), "WORLD_BASE_PATH": "/"}
            result = subprocess.run([sys.executable, "-I", str(KIT / "remote_world.py"), "--target", world.url,
                                     "--expect-world", "living-island"], env=env, capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 3)
            self.assertIn("runs mesa-island, not living-island", result.stderr)
            with self.assertRaises(OSError):
                request(port, "GET", "/api.md")

    def test_start_refuses_an_unreachable_world(self):
        down = self.free_port()
        port = self.free_port()
        env = {**os.environ, "WORLD_HOST": "127.0.0.1", "WORLD_PORT": str(port), "WORLD_BASE_PATH": "/"}
        result = subprocess.run([sys.executable, "-I", str(KIT / "remote_world.py"), "--target", f"http://127.0.0.1:{down}",
                                 "--expect-world", "living-island"], env=env, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 3)
        self.assertIn("/healthz answered 502", result.stderr)

if __name__ == "__main__":
    unittest.main()
