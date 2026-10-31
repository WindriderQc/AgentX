"""Real local HTTP transport, synthetic provider; no model or shared compute."""
import http.client
import json
import socket
import struct
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from llm_proxy import LLMProxy


class DrainTests(unittest.TestCase):
    def test_a_disconnected_harness_does_not_cancel_either_core_transport(self):
        for wire, route in [('responses', 'responses'), ('chat', 'chat/completions')]:
            with self.subTest(wire=wire):
                release, finished = threading.Event(), threading.Event()
                failures, calls = [], []

                class Provider(BaseHTTPRequestHandler):
                    def log_message(self, *_): pass
                    def do_POST(self):
                        calls.append(self.path)
                        self.rfile.read(int(self.headers['Content-Length']))
                        self.send_response(200)
                        self.end_headers()
                        try:
                            if not release.wait(5): raise RuntimeError('fixture was not released')
                            # Exceeds socket buffers: closing the upstream instead of
                            # draining it makes this write fail, including its terminal.
                            for _ in range(64): self.wfile.write(b'x' * 65536)
                            self.wfile.write(b'data: [DONE]\n\n')
                            self.wfile.flush()
                        except Exception as error:
                            failures.append(type(error).__name__)
                        finally:
                            finished.set()

                server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
                worker = threading.Thread(target=server.serve_forever, daemon=True)
                worker.start()
                proxy = LLMProxy(f'http://127.0.0.1:{server.server_port}/api/llm/v1', 'synthetic', wire=wire)
                try:
                    with proxy:
                        client = http.client.HTTPConnection('127.0.0.1', proxy.port, timeout=3)
                        client.request('POST', '/api/llm/v1/' + route, json.dumps({'model': 'agentx-primary'}),
                                       {'Authorization': 'Bearer ' + proxy.capability})
                        response = client.getresponse()
                        sock = response.fp.raw._sock
                        sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack('ii', 1, 0))
                        response.close()
                        client.close()
                        release.set()
                        self.assertTrue(finished.wait(5), 'same upstream request must reach EOF')
                    self.assertEqual(failures, [])
                    self.assertEqual(calls, ['/api/llm/v1/' + route], 'no replacement request')
                    self.assertEqual(proxy.connections, set())
                finally:
                    release.set()
                    server.shutdown()
                    server.server_close()
                    worker.join()

    def test_shutdown_waits_for_an_existing_request_before_reporting_cleanup(self):
        proxy = LLMProxy(None, drain_timeout=2)
        proxy.__enter__()
        connection = Mock()
        with proxy.lock: proxy.connections.add(connection)
        stopped, errors = threading.Event(), []

        def close():
            try: proxy.__exit__(None, None, None)
            except Exception as error: errors.append(error)
            finally: stopped.set()

        closer = threading.Thread(target=close)
        closer.start()
        try:
            self.assertFalse(stopped.wait(.7), 'pending Core response must not be closed immediately')
            connection.close.assert_not_called()
        finally:
            with proxy.idle:
                proxy.connections.discard(connection)
                proxy.idle.notify_all()
            closer.join(3)
        self.assertTrue(stopped.is_set())
        self.assertEqual(errors, [])

    def test_drain_timeout_never_claims_local_cleanup_or_native_release(self):
        proxy = LLMProxy(None, drain_timeout=.01)
        proxy.__enter__()
        connection = Mock()
        with proxy.lock: proxy.connections.add(connection)
        with self.assertRaisesRegex(RuntimeError, 'native Core release remains unproven'):
            proxy.__exit__(None, None, None)
        connection.sock.shutdown.assert_called_once_with(socket.SHUT_RDWR)
        connection.close.assert_called_once()

    def test_shutdown_refuses_a_handler_that_has_not_dispatched_yet(self):
        with LLMProxy('http://127.0.0.1:1/api/llm/v1', 'synthetic') as proxy:
            with proxy.lock: proxy.closing = True
            client = http.client.HTTPConnection('127.0.0.1', proxy.port, timeout=3)
            client.request('POST', '/api/llm/v1/responses', '{"model":"agentx-primary"}',
                           {'Authorization': 'Bearer ' + proxy.capability})
            self.assertEqual(client.getresponse().status, 503)
            client.close()
            self.assertEqual(proxy.connections, set())


if __name__ == '__main__': unittest.main()
