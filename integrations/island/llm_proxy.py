"""Per-run loopback capability: only the logical model and one inference transport.

The sandbox receives an ephemeral capability, never the upstream credential.
Core still owns inference admission. This proxy cannot redirect or retry a call.
Each run opens exactly one inference route: Responses (Codex) or Chat
Completions (DSH, pi). The other one refuses like any unknown path.
"""
from __future__ import annotations

import hmac
import http.client
import json
import secrets
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

PREFIX = "/api/llm/v1"
MODEL = "agentx-primary"
MAX_BODY = 8 * 1024 * 1024
# The single inference route a run may open, by wire API.
INFERENCE = {"responses": PREFIX + "/responses", "chat": PREFIX + "/chat/completions"}


class LLMProxy:
    def __init__(self, upstream: str | None, token: str = "", timeout: float = 1200, wire: str = "responses", drain_timeout: float = 60):
        if wire not in INFERENCE:
            raise ValueError("inference wire must be responses or chat")
        self.wire, self.inference_path = wire, INFERENCE[wire]
        self.target = urlsplit(upstream or "http://127.0.0.1")
        if upstream and (self.target.scheme not in ("http", "https") or not self.target.hostname
                         or self.target.username or self.target.password or self.target.query
                         or self.target.fragment or self.target.path.rstrip("/") != PREFIX):
            raise ValueError("gateway must be an explicit HTTP(S) /api/llm/v1 base URL")
        if upstream and self.target.scheme == "http" and self.target.hostname not in ("127.0.0.1", "::1", "localhost"):
            raise ValueError("non-loopback gateway credentials require TLS")
        if upstream and (not token.strip() or any(c in token for c in "\r\n")):
            raise ValueError("dedicated gateway credential required")
        self.upstream, self.token, self.timeout = upstream, token, timeout
        if not 0 < drain_timeout <= timeout:
            raise ValueError("drain timeout must be positive and no longer than the request timeout")
        self.drain_timeout, self.closing = drain_timeout, False
        self.capability = secrets.token_urlsafe(32)
        self.connections = set()
        self.lock = threading.Lock()
        self.idle = threading.Condition(self.lock)
        proxy = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args): pass

            def reject(self, status):
                body = json.dumps({"error": {"message": "Inference capability refused"}}).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Connection", "close")
                self.end_headers()
                if self.command != "HEAD": self.wfile.write(body)
                self.close_connection = True

            def handle_request(self):
                allowed = {("GET", PREFIX + "/models"), ("POST", proxy.inference_path)}
                # Compare the raw request target; no normalization, query, redirects or CONNECT.
                if (self.command, self.path) not in allowed:
                    return self.reject(403)
                auth = self.headers.get_all("Authorization", [])
                if len(auth) != 1 or not hmac.compare_digest(auth[0], "Bearer " + proxy.capability):
                    return self.reject(401)
                if self.headers.get("Transfer-Encoding") or self.headers.get("Upgrade"):
                    return self.reject(400)
                if self.command == "GET":
                    body = json.dumps({"object": "list", "data": [{"id": MODEL, "object": "model"}]}).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                lengths = self.headers.get_all("Content-Length", [])
                if len(lengths) != 1 or not lengths[0].isdigit(): return self.reject(411)
                length = int(lengths[0])
                if not 0 < length <= MAX_BODY: return self.reject(413)
                self.connection.settimeout(30)
                body = self.rfile.read(length)
                if len(body) != length: return self.reject(400)
                try:
                    value = json.loads(body)
                except (ValueError, UnicodeError):
                    return self.reject(400)
                if not isinstance(value, dict) or value.get("model") != MODEL:
                    return self.reject(403)
                # Netcheck has no upstream at all and cannot accidentally invoke a model.
                if not proxy.upstream: return self.reject(503)
                cls = http.client.HTTPSConnection if proxy.target.scheme == "https" else http.client.HTTPConnection
                conn = cls(proxy.target.hostname, proxy.target.port, timeout=proxy.timeout)
                with proxy.lock:
                    admitted = not proxy.closing
                    if admitted: proxy.connections.add(conn)
                if not admitted:
                    conn.close()
                    return self.reject(503)
                sent = False
                try:
                    conn.request("POST", proxy.inference_path, body=body, headers={
                        "Authorization": "Bearer " + proxy.token,
                        "Content-Type": "application/json", "Connection": "close",
                    })
                    response = conn.getresponse()
                    # Never forward redirects or cookies to a model-controlled client.
                    if 300 <= response.status < 400: return self.reject(502)
                    sent = True
                    attached = True
                    try:
                        self.send_response(response.status)
                        self.send_header("Content-Type", response.getheader("Content-Type", "application/json"))
                        self.send_header("Connection", "close")
                        self.end_headers()
                    except OSError:
                        attached = False
                    while chunk := response.read1(65536):
                        if attached:
                            try:
                                self.wfile.write(chunk)
                                self.wfile.flush()
                            except OSError:
                                # A reminder/context reset can stop the harness mid-answer.
                                # Keep reading this SAME admitted Core request to EOF;
                                # discarding late output does not retry or release it.
                                attached = False
                except (OSError, http.client.HTTPException):
                    if not sent: self.reject(502)
                finally:
                    conn.close()
                    with proxy.idle:
                        proxy.connections.discard(conn)
                        proxy.idle.notify_all()
                    self.close_connection = True

            do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = handle_request
            do_HEAD = do_OPTIONS = do_CONNECT = do_TRACE = handle_request

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def port(self): return self.server.server_port

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_args):
        with self.lock: self.closing = True
        self.server.shutdown()
        self.server.server_close()
        with self.idle:
            drained = self.idle.wait_for(lambda: not self.connections, timeout=self.drain_timeout)
            pending = list(self.connections)
        for connection in pending:
            if connection.sock:
                try: connection.sock.shutdown(socket.SHUT_RDWR)
                except OSError: pass
            connection.close()
        self.thread.join(timeout=5)
        if not drained:
            raise RuntimeError("inference response drain timed out; native Core release remains unproven")
