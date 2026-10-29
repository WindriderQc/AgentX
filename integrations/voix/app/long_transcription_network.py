"""HTTPS-only YouTube egress. Every CONNECT resolves and pins a public IP.

Redirects must establish another approved tunnel. No direct downloader socket,
environment proxy, private address, cookie file, generic extractor or ffmpeg fetch.
"""
import ipaddress
import select
import socket
import socketserver
import threading
from contextlib import contextmanager
from urllib.parse import urlsplit, parse_qs
import re

VIDEO = re.compile(r"^[A-Za-z0-9_-]{11}$")


def youtube_url(value):
    if not isinstance(value, str) or len(value) > 2048:
        raise ValueError("URL YouTube invalide.")
    url = urlsplit(value)
    if url.scheme != "https" or url.username or url.password or url.port not in (None, 443):
        raise ValueError("Une URL YouTube HTTPS publique est requise.")
    host, path = (url.hostname or "").lower(), url.path
    if host == "youtu.be":
        video = path.lstrip("/")
    elif host in ("youtube.com", "www.youtube.com", "m.youtube.com"):
        video = parse_qs(url.query).get("v", [""])[0] if path == "/watch" else (
            path.split("/")[-1] if path.startswith(("/shorts/", "/live/")) else "")
    else:
        video = ""
    if not VIDEO.fullmatch(video):
        raise ValueError("Choisissez une vidéo YouTube, pas une playlist ou une autre adresse.")
    return "https://www.youtube.com/watch?v=" + video


def public_target(host, port):
    host = host.lower()
    if port != 443 or not any(host == root or host.endswith("." + root)
                               for root in ("youtube.com", "googlevideo.com", "ytimg.com")):
        raise ValueError("Destination de téléchargement refusée.")
    addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(row[4][0]).is_global for row in addresses):
        raise ValueError("Une destination réseau privée est interdite.")
    return addresses[0]


class Tunnel(socketserver.StreamRequestHandler):
    def handle(self):
        upstream = None
        try:
            line = self.rfile.readline(4097).decode("ascii")
            method, authority, version = line.strip().split(" ")
            if method != "CONNECT" or len(authority) > 260:
                raise ValueError()
            host, port = authority.rsplit(":", 1)
            for _ in range(100):
                header = self.rfile.readline(4097)
                if header in (b"\r\n", b"\n"):
                    break
                if not header or len(header) > 4096:
                    raise ValueError()
            else:
                raise ValueError()
            family, socktype, proto, _, target = public_target(host, int(port))
            upstream = socket.socket(family, socktype, proto)
            upstream.settimeout(15)
            upstream.connect(target)  # numeric address; never resolve a second time
            self.wfile.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
            self.wfile.flush()
            while True:
                ready, _, _ = select.select([self.connection, upstream], [], [], 20)
                if not ready:
                    break
                for source in ready:
                    chunk = source.recv(65536)
                    if not chunk:
                        return
                    (upstream if source is self.connection else self.connection).sendall(chunk)
        except (OSError, ValueError):
            try:
                self.wfile.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
                self.wfile.flush()
            except OSError:
                pass
        finally:
            if upstream is not None:
                upstream.close()


class Proxy(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    # Local process only; bound concurrency also limits downloader fragments.
    request_queue_size = 8


@contextmanager
def youtube_proxy():
    with Proxy(("127.0.0.1", 0), Tunnel) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield "http://127.0.0.1:" + str(server.server_address[1])
        finally:
            server.shutdown()
            thread.join()
