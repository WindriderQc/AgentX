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

class RelayDrainTest(unittest.TestCase):
    def test_dead_worker_is_drained_to_native_eof_without_replaying_request(self):
        entered, release, eof = threading.Event(), threading.Event(), threading.Event()
        calls = []
        class Upstream(BaseHTTPRequestHandler):
            def do_POST(self):
                calls.append(1)
                self.rfile.read(int(self.headers['Content-Length']))
                self.send_response(200); self.end_headers()
                self.wfile.write(b'partial'); self.wfile.flush(); entered.set()
                release.wait(5)
                self.wfile.write(b'terminal'); self.wfile.flush(); eof.set()
            def log_message(self, *_args):
                pass
        upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        self.addCleanup(upstream.server_close); self.addCleanup(upstream.shutdown)
        with tempfile.TemporaryDirectory() as directory:
            server = relay.serve(str(Path(directory) / 'model.sock'), f'http://127.0.0.1:{upstream.server_port}/v1', drain_on_disconnect=True)
            self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
            client = socket.socket(socket.AF_UNIX); client.connect(server.server_address)
            client.sendall(b'POST /v1/chat/completions HTTP/1.0\r\nContent-Length: 2\r\n\r\n{}')
            self.assertTrue(entered.wait(5)); client.close()
            ticks = []
            def heartbeat():
                ticks.append(1); release.set()
            self.assertTrue(server.drain(2, heartbeat)); self.assertTrue(eof.is_set())
            self.assertTrue(ticks); self.assertEqual(calls, [1])
            self.assertFalse(server.track(socket.socket()))

    def test_unfinished_stream_reaches_bounded_drain_and_preserves_native_uncertainty(self):
        server = relay.UnixServer('/tmp/unused-agentx-relay-test', relay.ModelOnly, bind_and_activate=False)
        server.server_close()
        first, second = socket.socketpair()
        self.addCleanup(first.close); self.addCleanup(second.close)
        self.assertTrue(server.track(first))
        self.assertFalse(server.drain(0.02))
        self.assertIn(first, server.upstreams)
        self.assertFalse(server.track(socket.socket()))

    def test_stop_gate_prevents_forwarding_an_already_connected_request(self):
        from unittest.mock import Mock
        server = relay.UnixServer('/tmp/unused-agentx-relay-test', relay.ModelOnly, bind_and_activate=False)
        server.server_close()
        first, second = socket.socketpair()
        self.addCleanup(first.close); self.addCleanup(second.close)
        self.assertTrue(server.track(first))
        connection = Mock(sock=first)
        server.begin_drain()
        self.assertFalse(server.dispatch(connection, '/v1/chat/completions', b'{}', {}))
        connection.request.assert_not_called()
