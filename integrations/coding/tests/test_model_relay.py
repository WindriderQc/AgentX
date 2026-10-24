"""Local socket fixtures only: no model service or shared runtime is contacted."""
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import socket
import tempfile
import threading
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location("model_relay", Path(__file__).resolve().parents[1] / "model_relay.py")
relay = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(relay)


class RelayStopTest(unittest.TestCase):
    def test_last_allowed_reply_can_save_before_an_extra_call_is_refused(self):
        spec = importlib.util.spec_from_file_location('coding_progress', Path(__file__).resolve().parents[1] / 'coding_progress.py')
        progress_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(progress_module)
        arrived, release = threading.Event(), threading.Event()
        forwarded, errors = [], []
        class Upstream(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers['Content-Length']))
                forwarded.append(True); arrived.set()
                release.wait(5)
                self.send_response(200); self.end_headers(); self.wfile.write(b'final save result')
            def log_message(self, *_args):
                pass
        upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        self.addCleanup(upstream.server_close); self.addCleanup(upstream.shutdown)
        self.addCleanup(release.set)
        with tempfile.TemporaryDirectory() as directory:
            path, saved = str(Path(directory)/'model.sock'), Path(directory)/'step.json'
            progress = progress_module.Progress('0001', '11111111-2222-4333-8444-555555555555')
            progress.phase = 'running'; progress.report_mode = True; progress.model_calls = 127
            progress.begin_step(4, 60, str(saved))
            server = relay.serve(path, f'http://127.0.0.1:{upstream.server_port}/v1',
                                 observer=progress.model_events.put, request_budget=progress.relay_call_budget())
            self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
            def request():
                connection = http.client.HTTPConnection('worker', timeout=5)
                connection.sock = socket.socket(socket.AF_UNIX); connection.sock.connect(path)
                connection.request('POST', '/v1/chat/completions', body=b'{}')
                response = connection.getresponse(); result = (response.status, response.read())
                connection.close(); return result
            def worker():
                try:
                    status, body = request()
                    self.assertEqual(status, 200)
                    saved.write_bytes(body)
                    self.assertEqual(request()[0], 400)
                except BaseException as error:
                    errors.append(error)
            thread = threading.Thread(target=worker); thread.start()
            self.assertTrue(arrived.wait(3))
            try:
                self.assertIsNone(progress.tick())
                self.assertEqual(progress.model_calls, 128)
                self.assertFalse(saved.exists())
            finally:
                release.set(); thread.join(5)
            self.assertFalse(thread.is_alive()); self.assertEqual(errors, [])
            self.assertEqual(saved.read_bytes(), b'final save result')
            self.assertIsNone(progress.tick())
            self.assertEqual(progress.model_calls, 128)
            self.assertEqual(len(forwarded), 1)

    def test_each_request_receives_fresh_guidance_without_growing_history_or_changing_options(self):
        received = []
        class Upstream(BaseHTTPRequestHandler):
            def do_POST(self):
                received.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                self.send_response(200); self.end_headers(); self.wfile.write(b'{}')
            def log_message(self, *_args):
                pass
        upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        self.addCleanup(upstream.server_close); self.addCleanup(upstream.shutdown)
        snapshots = iter(['Runner budget: 120 seconds', 'Runner budget: 60 seconds'])
        original = {'model': 'fixture-model', 'messages': [{'role': 'system', 'content': 'Original instructions'},
                    {'role': 'user', 'content': 'Synthetic task'}], 'stream': False, 'max_tokens': 1024,
                    'options': {'num_ctx': 8192, 'think': True}, 'tools': [{'type': 'function', 'function': {'name': 'fixture'}}]}
        body = json.dumps(original).encode()
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'model.sock')
            server = relay.serve(path, f'http://127.0.0.1:{upstream.server_port}/v1', budget_guidance=lambda: next(snapshots))
            self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
            for _ in range(2):
                connection = http.client.HTTPConnection('worker')
                connection.sock = socket.socket(socket.AF_UNIX); connection.sock.connect(path)
                connection.request('POST', '/v1/chat/completions', body=body)
                self.assertEqual(connection.getresponse().read(), b'{}'); connection.close()
        self.assertEqual([value['messages'][-1]['content'] for value in received],
                         ['Runner budget: 120 seconds', 'Runner budget: 60 seconds'])
        for value in received:
            self.assertEqual(value['messages'][:-1], original['messages'])
            self.assertEqual(len(value['messages']), len(original['messages']) + 1)
            self.assertEqual({k: v for k, v in value.items() if k != 'messages'},
                             {k: v for k, v in original.items() if k != 'messages'})
        self.assertEqual(json.loads(body), original)

    def test_runner_gateway_token_replaces_whatever_the_worker_sends(self):
        seen = []
        class Upstream(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers['Content-Length']))
                seen.append(self.headers.get('Authorization'))
                self.send_response(200); self.end_headers(); self.wfile.write(b'{}')
            def log_message(self, *_args):
                pass
        upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        self.addCleanup(upstream.server_close); self.addCleanup(upstream.shutdown)
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'model.sock')
            server = relay.serve(path, f'http://127.0.0.1:{upstream.server_port}/v1',
                                 runner_headers={'Authorization': 'Bearer runner-gateway-token'})
            self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
            connection = http.client.HTTPConnection('worker')
            connection.sock = socket.socket(socket.AF_UNIX); connection.sock.connect(path)
            connection.request('POST', '/v1/chat/completions', body=b'{}', headers={'Authorization': 'Bearer local-no-auth'})
            self.assertEqual(connection.getresponse().read(), b'{}'); connection.close()
        self.assertEqual(seen, ['Bearer runner-gateway-token'])

    def test_absent_guidance_and_malformed_requests_keep_original_bytes(self):
        for body in [b'{}', b'[]', b'{', b'{"messages":[7]}', b'{ "messages": [] }']:
            self.assertEqual(relay.with_budget_guidance(body, 'Synthetic advisory'), body)
        body = b'{ "messages": [] }'
        self.assertEqual(relay.with_budget_guidance(body, None), body)

    def test_source_policy_reaches_the_wire_without_expanding_lower_caps_or_context(self):
        received, observed = [], []
        class Upstream(BaseHTTPRequestHandler):
            def do_POST(self):
                received.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                self.send_response(200); self.end_headers(); self.wfile.write(b'{}')
            def log_message(self, *_args):
                pass
        upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        self.addCleanup(upstream.server_close); self.addCleanup(upstream.shutdown)
        original = {'model': 'fixture-model', 'messages': [{'role': 'user', 'content': 'Fix the reviewed source'}],
                    'tools': [{'type': 'function', 'function': {'name': 'edit'}}], 'stream': True,
                    'max_tokens': 32768, 'max_completion_tokens': 8192, 'reasoning_effort': 'high',
                    'options': {'num_ctx': 196608, 'num_predict': 8192}}
        body = json.dumps(original).encode()
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'model.sock')
            server = relay.serve(path, f'http://127.0.0.1:{upstream.server_port}/v1',
                observer=observed.append, request_policy={'max_tokens': 4096, 'reasoning_effort': 'none'},
                request_budget={'calls': 2, 'key': 'source-step'}, budget_guidance=lambda: 'Existing native budget')
            self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
            def request(value):
                connection = http.client.HTTPConnection('worker', timeout=3)
                connection.sock = socket.socket(socket.AF_UNIX); connection.sock.connect(path)
                connection.request('POST', '/v1/chat/completions', body=value)
                response = connection.getresponse(); status = response.status; response.read(); connection.close()
                return status
            self.assertEqual(request(body), 200)
            lower = json.loads(body); lower['options']['num_predict'] = 128
            self.assertEqual(request(json.dumps(lower).encode()), 200)
            self.assertEqual(request(body), 400)
            self.assertEqual(request(b'{'), 400)
        self.assertEqual(len(received), 2)
        for value, cap in zip(received, [4096, 128]):
            self.assertEqual(value['max_tokens'], cap)
            self.assertEqual(value['max_completion_tokens'], cap)
            self.assertEqual(value['options'], {'num_ctx': 196608, 'num_predict': cap})
            self.assertEqual(value['reasoning_effort'], 'none')
            for key in ['model', 'tools', 'stream']:
                self.assertEqual(value[key], original[key])
            self.assertEqual(value['messages'][:-1], original['messages'])
        self.assertEqual(observed.count('model_request'), 2)
        self.assertEqual(json.loads(body), original)

    def test_invalid_source_caps_refuse_and_missing_policy_keeps_legacy_bytes(self):
        policy = {'max_tokens': 4096, 'reasoning_effort': 'none'}
        for value in [[], {'options': []}, {'max_tokens': 0}, {'max_tokens': True},
                      {'max_completion_tokens': -1}, {'options': {'num_predict': '4096'}}]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                relay.with_request_policy(json.dumps(value).encode(), policy)
        self.assertEqual(relay.with_request_policy(b'{ "messages": [] }', None), b'{ "messages": [] }')

    def test_editing_phase_filters_discovery_without_changing_model_history_or_context(self):
        body = {'model': 'fixture', 'messages': [{'role': 'user', 'content': 'Complete sources'}],
                'tools': [{'type': 'function', 'function': {'name': name}} for name in
                          ['read', 'edit', 'write', 'bash', 'apply_patch', 'web_search']],
                'tool_choice': 'none', 'options': {'num_ctx': 196608}}
        policy = {'max_tokens': 4096, 'reasoning_effort': 'none', 'tools': 'edit_only'}
        result = json.loads(relay.with_request_policy(json.dumps(body).encode(), policy))
        self.assertEqual([t['function']['name'] for t in result['tools']], ['edit', 'write', 'apply_patch'])
        self.assertEqual(result['tool_choice'], 'auto')
        for key in ['model', 'messages', 'options']:
            self.assertEqual(result[key], body[key])
        body['tools'] = [{'type': 'function', 'function': {'name': 'read'}}]
        with self.assertRaises(ValueError):
            relay.with_request_policy(json.dumps(body).encode(), policy)

    def test_invalid_runner_policy_preserves_an_existing_socket_path(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'model.sock'; path.write_bytes(b'existing owner')
            for policy in [{'max_tokens': 0, 'reasoning_effort': 'none'},
                           {'max_tokens': 4096, 'reasoning_effort': 'high'}, {'max_tokens': 4096}]:
                with self.subTest(policy=policy), self.assertRaises(ValueError):
                    relay.serve(str(path), 'http://127.0.0.1:9/v1', request_policy=policy)
                self.assertEqual(path.read_bytes(), b'existing owner')

    def test_guidance_cannot_expand_a_request_beyond_the_native_size_limit(self):
        body = b'{"messages":[{"role":"user","content":"Synthetic task"}]}'
        observed = []
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'model.sock')
            server = relay.serve(path, 'http://127.0.0.1:9/v1', observer=observed.append,
                                 budget_guidance=lambda: 'Synthetic runner advisory')
            self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
            connection = http.client.HTTPConnection('worker', timeout=2)
            connection.sock = socket.socket(socket.AF_UNIX); connection.sock.connect(path)
            self.addCleanup(connection.close)
            with mock.patch.object(relay, 'MAX_REQUEST_BYTES', len(body)):
                connection.request('POST', '/v1/chat/completions', body=body)
                response = connection.getresponse()
                self.assertEqual(response.status, 403); response.read()
        self.assertEqual(observed, [])

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
