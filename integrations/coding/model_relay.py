#!/usr/bin/env python3
"""The coding worker's only way out of its sandbox: one model route.

The worker runs with no network. The runner listens on a Unix socket placed in
the worker's home and forwards chat completions to Core, and nothing else.
Inside the sandbox, `inside` exposes that socket on loopback for the harness,
which needs an HTTP address.
"""

from __future__ import annotations

from http.server import BaseHTTPRequestHandler
import os
import socket
import socketserver
import subprocess
import sys
import threading
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ALLOWED = ("POST", "/v1/chat/completions")
MAX_REQUEST_BYTES = 64 * 1024 * 1024
UPSTREAM_TIMEOUT_SECONDS = 3600


class ModelOnly(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"  # The reply ends when the connection closes, which also carries a stream.
    model_url = ""
    observer = staticmethod(lambda _event: None)

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
        call = Request(f"{self.model_url}/chat/completions", data=self.rfile.read(length), method="POST",
                       headers={"Content-Type": "application/json", "x-service-caller": "coding-run"})
        self.observer("model_request")
        try:
            upstream = urlopen(call, timeout=UPSTREAM_TIMEOUT_SECONDS)
        except HTTPError as error:
            upstream = error
        except (URLError, OSError):
            self.send_error(502, "The model route did not answer")
            return
        with upstream:
            self.send_response(upstream.status)
            self.send_header("Content-Type", upstream.headers.get("Content-Type", "application/json"))
            self.end_headers()
            while chunk := upstream.read1(65536):
                self.wfile.write(chunk)
                self.wfile.flush()

    do_GET = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = refuse

    def address_string(self) -> str:
        return "worker"

    def log_message(self, *_args) -> None:
        pass


class UnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def serve(socket_path: str, model_url: str, observer=None) -> UnixServer:
    """Start the runner-side relay; the caller shuts it down."""
    if os.path.exists(socket_path):
        os.unlink(socket_path)
    handler = type("Handler", (ModelOnly,), {"model_url": model_url.rstrip("/"),
                    "observer": staticmethod(observer or (lambda _event: None))})
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
