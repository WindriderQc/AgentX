#!/usr/bin/env python3
"""The coding worker's only way out of its sandbox: one model route.

The worker runs with no network. The runner listens on a Unix socket placed in
the worker's home and forwards chat completions to Core, and nothing else.
Inside the sandbox, `inside` exposes that socket on loopback for the harness,
which needs an HTTP address.
"""

from __future__ import annotations

from http.server import BaseHTTPRequestHandler
import http.client
import json
import os
import socket
import socketserver
import subprocess
import sys
import threading
import uuid
import time
from urllib.parse import urlsplit


ALLOWED = ("POST", "/v1/chat/completions")
MAX_REQUEST_BYTES = 64 * 1024 * 1024
UPSTREAM_TIMEOUT_SECONDS = 3600


def with_budget_guidance(body: bytes, guidance: str | None) -> bytes:
    """Add ephemeral runner context; preserve the harness history and model options."""
    if not isinstance(guidance, str) or not guidance or len(guidance) > 2000:
        return body
    try:
        value = json.loads(body)
        if not isinstance(value, dict) or not isinstance(value.get("messages"), list):
            return body
        if not all(isinstance(message, dict) for message in value["messages"]):
            return body
        value["messages"].append({"role": "system", "content": guidance})
        return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
    except (ValueError, UnicodeDecodeError, RecursionError):
        return body


class ModelOnly(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"  # The reply ends when the connection closes, which also carries a stream.
    model_url = ""
    observer = staticmethod(lambda _event: None)
    runner_headers = {}
    drain_on_disconnect = False
    budget_guidance = staticmethod(lambda: None)

    def refuse(self) -> None:
        body = b'{"error":{"message":"The coding worker can reach the model route only.","type":"invalid_request_error"}}'
        self.send_response(403)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length") or -1)
        if (self.command, self.path.split("?")[0]) != ALLOWED or not 0 <= length <= MAX_REQUEST_BYTES:
            self.refuse()
            return
        body = self.rfile.read(length)
        body = with_budget_guidance(body, self.budget_guidance())
        if len(body) > MAX_REQUEST_BYTES:
            self.refuse()
            return
        target = urlsplit(f"{self.model_url}/chat/completions")
        connection_type = http.client.HTTPSConnection if target.scheme == "https" else http.client.HTTPConnection
        connection = connection_type(target.hostname, target.port, timeout=UPSTREAM_TIMEOUT_SECONDS)
        self.observer("model_request")
        try:
            connection.connect()
            if not self.server.track(connection.sock):
                return
            upstream_socket = connection.sock
            if not self.server.dispatch(connection, target.path + (f"?{target.query}" if target.query else ""), body,
                               {"Content-Type": "application/json", "x-service-caller": "coding-run",
                                **self.runner_headers, "x-agentx-coding-call": str(uuid.uuid4())}):
                return
            with connection.getresponse() as upstream:
                disconnected = False
                try:
                    self.send_response(upstream.status)
                    self.send_header("Content-Type", upstream.headers.get("Content-Type", "application/json"))
                    self.end_headers()
                except OSError:
                    if not self.drain_on_disconnect:
                        raise
                    disconnected = True
                while chunk := upstream.read1(65536):
                    if not disconnected:
                        try:
                            self.wfile.write(chunk)
                            self.wfile.flush()
                        except OSError:
                            if not self.drain_on_disconnect:
                                raise
                            disconnected = True
        except (OSError, http.client.HTTPException):
            pass  # Stopping the worker closes its in-flight Core request too.
        finally:
            if 'upstream_socket' in locals():
                self.server.untrack(upstream_socket)
            connection.close()

    do_GET = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = refuse

    def address_string(self) -> str:
        return "worker"

    def log_message(self, *_args) -> None:
        pass


class UnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def __init__(self, *args, **kwargs):
        self.upstreams, self.guard, self.closing = set(), threading.Lock(), False
        super().__init__(*args, **kwargs)

    def track(self, upstream):
        with self.guard:
            if self.closing:
                upstream.close()
                return False
            self.upstreams.add(upstream)
            return True

    def untrack(self, upstream):
        with self.guard:
            self.upstreams.discard(upstream)

    def begin_drain(self):
        with self.guard:
            self.closing = True

    def dispatch(self, connection, path, body, headers):
        # Serialize the actual send with admission closure. A connected socket
        # alone is not permission to forward after the worker stop fence.
        with self.guard:
            if self.closing:
                return False
            connection.sock.settimeout(10)
            try:
                connection.request("POST", path, body=body, headers=headers)
            finally:
                if connection.sock:
                    connection.sock.settimeout(UPSTREAM_TIMEOUT_SECONDS)
            return True

    def drain(self, seconds, heartbeat=None):
        # Close admission first; keep only already tracked native requests until
        # EOF or the caller's remaining hard budget. EOF is not a success receipt.
        self.begin_drain()
        deadline = time.monotonic() + max(0, seconds)
        while time.monotonic() < deadline:
            with self.guard:
                if not self.upstreams:
                    return True
            if heartbeat:
                heartbeat()
            time.sleep(min(0.25, max(0, deadline - time.monotonic())))
        with self.guard:
            return not self.upstreams

    def shutdown(self):
        with self.guard:
            self.closing = True
            for upstream in self.upstreams:
                try:
                    upstream.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                upstream.close()
        super().shutdown()


def serve(socket_path: str, model_url: str, observer=None, runner_headers=None, drain_on_disconnect=False,
          budget_guidance=None) -> UnixServer:
    """Start the runner-side relay; the caller shuts it down."""
    if os.path.exists(socket_path):
        os.unlink(socket_path)
    handler = type("Handler", (ModelOnly,), {"model_url": model_url.rstrip("/"),
                    "observer": staticmethod(observer or (lambda _event: None)), "runner_headers": runner_headers or {},
                    "drain_on_disconnect": drain_on_disconnect,
                    "budget_guidance": staticmethod(budget_guidance or (lambda: None))})
    server = UnixServer(socket_path, handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def pump(source: socket.socket, target: socket.socket) -> None:
    try:
        while data := source.recv(65536):
            target.sendall(data)
    except OSError:
        pass
    finally:
        for end in (source, target):
            try:
                end.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def inside(socket_path: str, port: int, command: list[str]) -> int:
    """Inside the sandbox: loopback port -> the runner's socket, then run the harness."""
    listener = socket.create_server(("127.0.0.1", port))

    def accept() -> None:
        while True:
            client, _ = listener.accept()
            relay = socket.socket(socket.AF_UNIX)
            relay.connect(socket_path)
            threading.Thread(target=pump, args=(client, relay), daemon=True).start()
            threading.Thread(target=pump, args=(relay, client), daemon=True).start()

    threading.Thread(target=accept, daemon=True).start()
    return subprocess.run(command).returncode


if __name__ == "__main__":
    if len(sys.argv) < 6 or sys.argv[1] != "inside" or sys.argv[4] != "--":
        raise SystemExit("usage: model_relay.py inside <socket> <port> -- <command...>")
    raise SystemExit(inside(sys.argv[2], int(sys.argv[3]), sys.argv[5:]))
