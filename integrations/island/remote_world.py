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

  [run]
  command = ["python3", "-I", "/path/to/remote_world.py", "--target", "https://world.example:18794"]
"""
from __future__ import annotations

import argparse
import http.client
import ipaddress
import json
import os
import signal
import ssl
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


class RemoteWorldRelay:
    def __init__(self, target: str, host: str = "127.0.0.1", port: int = 0, timeout: float = 90,
                 log=None, context: ssl.SSLContext | None = None):
        if not is_loopback(host):
            raise ValueError("the relay listens on loopback only")
        self.target = parse_target(target)
        self.timeout = timeout
        self.context = context or ssl.create_default_context()
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
                self.reply(status, payload, content_type)
                relay.note(self.command, path, status, started)

            do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = handle_request
            do_HEAD = do_OPTIONS = do_CONNECT = do_TRACE = handle_request

        self.server = ThreadingHTTPServer((host, port), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def port(self) -> int:
        return self.server.server_port

    def note(self, method: str, path: str, status: int, started: float) -> None:
        # Never the session token or the body: they belong to the agent's run.
        self.log(f"remote-world {status} {method} {path} {round((time.monotonic() - started) * 1000)}ms")

    def forward(self, method: str, target_path: str, headers: dict, body: bytes):
        target = self.target
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

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--target", required=True, help="remote world origin, https://host:port")
    parser.add_argument("--timeout", type=float, default=90, help="seconds per relayed request (images take a while)")
    args = parser.parse_args(argv)
    # Clawblox's delegated-start contract (docs/world-interface.md): WORLD_HOST/PORT/BASE_PATH.
    host = os.environ.get("WORLD_HOST", "127.0.0.1")
    port = os.environ.get("WORLD_PORT", "")
    if not port.isdigit():
        parser.error("WORLD_PORT must be set by Clawblox")
    if os.environ.get("WORLD_BASE_PATH", "/") not in ("", "/"):
        parser.error("a remote world is served at /")
    try:
        relay = RemoteWorldRelay(args.target, host=host, port=int(port), timeout=args.timeout)
    except ValueError as error:
        parser.error(str(error))
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    with relay:
        target = relay.target
        print(f"remote world relay on http://{host}:{relay.port} -> {target.scheme}://{target.netloc}", flush=True)
        stop.wait()
    return 0


if __name__ == "__main__":
    sys.exit(main())
