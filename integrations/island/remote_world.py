#!/usr/bin/env python3
"""A world that is already running elsewhere, seen by Clawblox as a local world.

Clawblox starts a world from its ``world.toml``; a world may delegate startup to a
``[run] command`` that serves the Clawblox world protocol on ``WORLD_HOST:WORLD_PORT``.
This script is such a command. It serves nothing itself: it relays the agent routes to a
remote world server (for example a GraphysX world service behind the instance's HTTPS
proxy), so the runner, the episode, the agent sandbox and the per-agent capability proxy
work exactly as with a local world.

Only the agent surface of the protocol is relayed, with an exact route list (no other path,
method, redirect or cookie), and only ``X-Session`` and ``Content-Type`` are forwarded.
The relay listens on loopback only; the agent never reaches it directly (its sandbox
reaches its own capability proxy, which reaches this relay). A non-loopback target requires
TLS with a verified certificate. Recording, resume and spectating belong to the remote
world, which records itself.

Two optional guards for a shared world (docs/ISLAND.md, "Se joindre à un monde déjà en marche"):

- ``--access-token-file``: a private file (mode 0600, owned by the runner account, not a
  symlink) whose value is sent as ``X-Island-Access`` on every relayed request, so the
  instance proxy admits only this runner to the agent routes. The agent never sees it: this
  process runs outside the sandbox and the header is never echoed back.
- ``--expect-world``: the world id the remote server must report on ``/healthz``. The relay
  refuses to start on another world, and answers its own ``/healthz`` with 503 when the
  remote world changes during the run (the runner's watchdog then fails the run).

``--probe`` checks the remote world once (``/healthz``, the expected world, ``/api.md``
through the access gate) and prints one JSON line; it serves nothing and joins nothing.

  [run]
  command = ["python3", "-I", "/path/to/remote_world.py", "--target", "https://world.example:18794",
             "--expect-world", "living-island", "--access-token-file", "/home/eko/.config/agentx/world.token"]
"""
from __future__ import annotations

import argparse
import atexit
import http.client
import ipaddress
import json
import os
import re
import signal
import ssl
import stat
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

MAX_BODY = 64 * 1024
MAX_RESPONSE = 8 * 1024 * 1024
# (method, path) -> whether a query string is allowed. The paths of the Clawblox world
# protocol an agent and the runner use; /healthz and /api.md also serve Clawblox's checks.
ROUTES = {
    ("GET", "/api.md"): False,
    ("GET", "/healthz"): False,
    ("POST", "/join"): True,
    ("POST", "/leave"): False,
    ("GET", "/observe"): False,
    ("GET", "/observe/image"): True,
    ("POST", "/input"): False,
    ("POST", "/chat"): False,
    ("GET", "/chat/messages"): True,
}
LOOPBACK_NAMES = ("localhost",)
ACCESS_HEADER = "X-Island-Access"
ACCESS_TOKEN = re.compile(r"^[A-Za-z0-9._~-]{32,512}$")
WORLD_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
# World services from before the world selector (GraphysX-Web#94) answer /healthz without a
# world id; they could only run Mesa.
LEGACY_WORLD = "mesa-island"


def is_loopback(host: str | None) -> bool:
    if not host:
        return False
    if host in LOOPBACK_NAMES:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def parse_target(value: str):
    target = urlsplit(value)
    if (target.scheme not in ("http", "https") or not target.hostname or target.username
            or target.password or target.query or target.fragment or target.path not in ("", "/")):
        raise ValueError("target must be an http(s) origin, for example https://world.example:18794")
    if target.scheme == "http" and not is_loopback(target.hostname):
        raise ValueError("a non-loopback target requires https")
    return target


def read_access_token(path: str) -> str:
    """The runner's world access token: a private regular file of this account, never a symlink."""
    try:
        info = os.lstat(path)
    except OSError as error:
        raise ValueError(f"access token file unreadable: {error.strerror}") from None
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("access token file must be a regular file (no symlink)")
    if info.st_mode & 0o077:
        raise ValueError("access token file must not be readable by group or others (chmod 600)")
    if hasattr(os, "getuid") and info.st_uid != os.getuid():
        raise ValueError("access token file must belong to the runner account")
    with open(path, "rb") as stream:
        value = stream.read(1024).decode("ascii", errors="replace").strip()
    if not ACCESS_TOKEN.match(value):
        raise ValueError("access token file must hold one token of 32 to 512 URL-safe characters")
    return value


def world_of(health) -> str | None:
    """The world id a /healthz answer names (legacy servers name none and run Mesa)."""
    if not isinstance(health, dict) or health.get("ok") is not True:
        return None
    world = health.get("world", LEGACY_WORLD)
    return world if isinstance(world, str) and WORLD_ID.match(world) else None


class Upstream:
    """One remote world origin: exact requests, verified TLS, the runner's access header."""

    def __init__(self, target: str, timeout: float = 90, context: ssl.SSLContext | None = None,
                 access_token: str | None = None):
        self.target = parse_target(target)
        self.timeout = timeout
        self.instance_id = None
        self.context = context or ssl.create_default_context()
        if access_token is not None and not ACCESS_TOKEN.match(access_token):
            raise ValueError("invalid access token")
        self.access_token = access_token

    def forward(self, method: str, target_path: str, headers: dict, body: bytes = b""):
        target = self.target
        # The access header is the runner's own; a caller never chooses it.
        headers = {key: value for key, value in headers.items() if key.lower() != ACCESS_HEADER.lower()}
        if self.instance_id:
            headers["X-World-Instance"] = self.instance_id
        if self.access_token:
            headers[ACCESS_HEADER] = self.access_token
        if target.scheme == "https":
            conn = http.client.HTTPSConnection(target.hostname, target.port or 443, timeout=self.timeout, context=self.context)
        else:
            conn = http.client.HTTPConnection(target.hostname, target.port or 80, timeout=self.timeout)
        try:
            conn.request(method, target_path, body=body or None, headers=headers)
            response = conn.getresponse()
            # Never pass a redirect or a cookie on to a model-controlled client.
            if 300 <= response.status < 400:
                return 502, "application/json", json.dumps({"error": "The remote world answered with a redirect"}).encode()
            payload = response.read(MAX_RESPONSE + 1)
            if len(payload) > MAX_RESPONSE:
                return 502, "application/json", json.dumps({"error": "The remote world answer is too large"}).encode()
            return response.status, response.getheader("Content-Type", "application/octet-stream"), payload
        except (OSError, http.client.HTTPException) as error:
            reason = "refusing TLS (certificate or protocol)" if isinstance(error, ssl.SSLError) else "unreachable"
            return 502, "application/json", json.dumps({"error": f"The remote world is {reason}"}).encode()
        finally:
            conn.close()

    def check(self, expect_world: str | None = None) -> dict:
        """One read of the remote world: reachable, the expected world, agent routes admitted."""
        problems = []
        status, _type, payload = self.forward("GET", "/healthz", {"Connection": "close", "Accept": "application/json"})
        try:
            health = json.loads(payload) if status == 200 else None
        except ValueError:
            health = None
        world = world_of(health)
        if status != 200:
            problems.append(f"/healthz answered {status}")
        elif world is None:
            problems.append("/healthz named no usable world")
        elif expect_world and world != expect_world:
            problems.append(f"the remote world runs {world}, not {expect_world}")
        api_status, _type, _payload = self.forward("GET", "/api.md", {"Connection": "close", "Accept": "*/*"})
        if api_status != 200:
            problems.append(f"/api.md answered {api_status} (access gate or world)")
        tick = health.get("tick") if isinstance(health, dict) and isinstance(health.get("tick"), int) else None
        return {"ok": not problems, "target": f"{self.target.scheme}://{self.target.netloc}", "world": world,
                "expected": expect_world, "tick": tick,
                "instanceId": health.get("instanceId") if isinstance(health, dict) else None,
                "recordingId": health.get("recordingId") if isinstance(health, dict) else None, "accessHeader": bool(self.access_token), "problems": problems}


class RemoteWorldRelay:
    def __init__(self, target: str, host: str = "127.0.0.1", port: int = 0, timeout: float = 90,
                 log=None, context: ssl.SSLContext | None = None, access_token: str | None = None,
                 expect_world: str | None = None, expect_instance: str | None = None):
        if not is_loopback(host):
            raise ValueError("the relay listens on loopback only")
        if expect_world is not None and not WORLD_ID.match(expect_world):
            raise ValueError("expected world needs a world id, for example living-island")
        self.upstream = Upstream(target, timeout=timeout, context=context, access_token=access_token)
        self.target = self.upstream.target
        self.sessions = set()
        self.sessions_lock = threading.Lock()
        self.upstream.instance_id = expect_instance
        if not expect_instance:
            # Bind once at startup, even when the next island has the same world type.
            self.upstream.instance_id = self.upstream.check(expect_world).get("instanceId")
        self.timeout = timeout
        self.expect_world = expect_world
        self.log = log or (lambda line: print(line, flush=True))
        relay = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args):
                pass

            def reply(self, status: int, body: bytes, content_type: str = "application/json"):
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Connection", "close")
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(body)
                self.close_connection = True

            def refuse(self, status: int, message: str):
                self.reply(status, json.dumps({"error": message}).encode())

            def handle_request(self):
                started = time.monotonic()
                path, _, query = self.path.partition("?")
                allowed = ROUTES.get((self.command, path))
                # Exact raw targets only: no normalization, absolute URLs, CONNECT or stray queries.
                if allowed is None or (query and not allowed) or "#" in self.path:
                    status = 404
                    self.refuse(status, "Not a relayed world route")
                    return relay.note(self.command, path, status, started)
                if self.headers.get("Transfer-Encoding") or self.headers.get("Upgrade"):
                    self.refuse(400, "Unsupported request framing")
                    return relay.note(self.command, path, 400, started)
                body = b""
                lengths = self.headers.get_all("Content-Length", [])
                if self.command == "POST":
                    if len(lengths) > 1 or (lengths and not lengths[0].isdigit()):
                        self.refuse(400, "Bad Content-Length")
                        return relay.note(self.command, path, 400, started)
                    length = int(lengths[0]) if lengths else 0
                    if length > MAX_BODY:
                        self.refuse(413, "Body too large")
                        return relay.note(self.command, path, 413, started)
                    self.connection.settimeout(30)
                    body = self.rfile.read(length)
                    if len(body) != length:
                        self.refuse(400, "Truncated body")
                        return relay.note(self.command, path, 400, started)
                headers = {"Connection": "close", "Accept": self.headers.get("Accept", "*/*")}
                sessions = self.headers.get_all("X-Session", [])
                if len(sessions) > 1 or any(c in "".join(sessions) for c in "\r\n"):
                    self.refuse(400, "One X-Session header at most")
                    return relay.note(self.command, path, 400, started)
                if sessions:
                    headers["X-Session"] = sessions[0]
                if self.command == "POST":
                    headers["Content-Type"] = self.headers.get("Content-Type", "application/json")
                    headers["Content-Length"] = str(len(body))
                status, content_type, payload = relay.forward(self.command, self.path, headers, body)
                if status == 200 and path == "/join":
                    try:
                        joined = json.loads(payload).get("session")
                        if isinstance(joined, str) and joined:
                            with relay.sessions_lock: relay.sessions.add(joined)
                    except (ValueError, AttributeError):
                        pass
                if status == 200 and path == "/leave" and sessions:
                    with relay.sessions_lock: relay.sessions.discard(sessions[0])
                if path == "/healthz" and relay.expect_world and status == 200:
                    try:
                        world = world_of(json.loads(payload))
                    except ValueError:
                        world = None
                    if world != relay.expect_world:
                        # The shared world was switched to another island: not this run's world.
                        status, content_type = 503, "application/json"
                        payload = json.dumps({"error": f"The remote world is {world or 'unknown'}, not {relay.expect_world}"}).encode()
                self.reply(status, payload, content_type)
                relay.note(self.command, path, status, started)

            do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = handle_request
            do_HEAD = do_OPTIONS = do_CONNECT = do_TRACE = handle_request

        self.server = ThreadingHTTPServer((host, port), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        atexit.register(self.release_sessions)

    @property
    def port(self) -> int:
        return self.server.server_port

    def note(self, method: str, path: str, status: int, started: float) -> None:
        # Never the session token, the access token or the body: they belong to the run.
        self.log(f"remote-world {status} {method} {path} {round((time.monotonic() - started) * 1000)}ms")

    def forward(self, method: str, target_path: str, headers: dict, body: bytes):
        return self.upstream.forward(method, target_path, headers, body)

    def __enter__(self):
        self.thread.start()
        return self

    def release_sessions(self):
        # Only this relay's joined capabilities; never reset a shared cohort world.
        with self.sessions_lock:
            sessions, self.sessions = self.sessions, set()
        for session in sessions:
            self.upstream.forward("POST", "/leave", {"X-Session": session}, b"{}")

    def __exit__(self, *_args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.release_sessions()
        atexit.unregister(self.release_sessions)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--target", required=True, help="remote world origin, https://host:port")
    parser.add_argument("--timeout", type=float, default=90, help="seconds per relayed request (images take a while)")
    parser.add_argument("--expect-world", help="world id the remote /healthz must report, for example living-island")
    parser.add_argument("--access-token-file", help="private file whose token is sent as X-Island-Access")
    parser.add_argument("--probe", action="store_true", help="check the remote world once, print JSON, serve nothing")
    args = parser.parse_args(argv)
    if args.expect_world is not None and not WORLD_ID.match(args.expect_world):
        parser.error("--expect-world needs a world id")
    try:
        token = read_access_token(args.access_token_file) if args.access_token_file else None
        upstream = Upstream(args.target, timeout=min(args.timeout, 20) if args.probe else args.timeout, access_token=token)
    except ValueError as error:
        if args.probe:
            print(json.dumps({"ok": False, "problems": [str(error)]}), flush=True)
            return 1
        parser.error(str(error))
    if args.probe:
        result = upstream.check(args.expect_world)
        print(json.dumps(result), flush=True)
        return 0 if result["ok"] else 1
    # Clawblox's delegated-start contract (docs/world-interface.md): WORLD_HOST/PORT/BASE_PATH.
    host = os.environ.get("WORLD_HOST", "127.0.0.1")
    port = os.environ.get("WORLD_PORT", "")
    if not port.isdigit():
        parser.error("WORLD_PORT must be set by Clawblox")
    if os.environ.get("WORLD_BASE_PATH", "/") not in ("", "/"):
        parser.error("a remote world is served at /")
    if args.expect_world:
        # Never serve another island under this world's name: Clawblox then sees the world
        # process exit before it is healthy, and the run fails before the agent starts.
        found = upstream.check(args.expect_world)
        if not found["ok"]:
            print("remote world refused: " + "; ".join(found["problems"]), file=sys.stderr, flush=True)
            return 3
    try:
        relay = RemoteWorldRelay(args.target, host=host, port=int(port), timeout=args.timeout,
                                 access_token=token, expect_world=args.expect_world,
                                 expect_instance=os.environ.get("AGENTX_ISLAND_EXPECT_INSTANCE"))
    except ValueError as error:
        parser.error(str(error))
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    with relay:
        target = relay.target
        guard = f", world {args.expect_world}" if args.expect_world else ""
        access = ", access header" if token else ""
        print(f"remote world relay on http://{host}:{relay.port} -> {target.scheme}://{target.netloc}{guard}{access}", flush=True)
        stop.wait()
    return 0


if __name__ == "__main__":
    sys.exit(main())
