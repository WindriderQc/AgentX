"""Local socket fixtures only: no model service or shared runtime is contacted."""
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
from pathlib import Path
import socket
import tempfile
import threading
import unittest

SPEC = importlib.util.spec_from_file_location("model_relay", Path(__file__).resolve().parents[1] / "model_relay.py")
relay = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(relay)


class RelayStopTest(unittest.TestCase):
    def test_shutdown_closes_only_its_inflight_upstream_connection(self):
        connected, closed = threading.Event(), threading.Event()
        class Upstream(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers['Content-Length']))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'partial stream')
                self.wfile.flush()
                connected.set()
                self.connection.settimeout(5)
                if self.connection.recv(1) == b'':
                    closed.set()
            def log_message(self, *_args):
                pass
        upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(upstream.server_close)
        self.addCleanup(upstream.shutdown)
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'model.sock')
            server = relay.serve(path, f'http://127.0.0.1:{upstream.server_port}/v1')
            self.addCleanup(server.server_close)
            connection = http.client.HTTPConnection('worker')
            connection.sock = socket.socket(socket.AF_UNIX)
            connection.sock.connect(path)
            self.addCleanup(connection.close)
            connection.request('POST', '/v1/chat/completions', body=b'{}')
            self.assertTrue(connected.wait(5))
            server.shutdown()
            self.assertTrue(closed.wait(5), 'upstream connection remained open after relay shutdown')
            self.assertFalse(server.track(socket.socket()))


if __name__ == '__main__':
    unittest.main()
