"""CPU/socket fixtures: no native harness or model service is invoked."""
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import socket
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


budget_module, relay = module('coding_reply_budget'), module('model_relay')


def reply(count=1, reason='tool_calls'):
    return json.dumps({'choices': [{'message': {'role': 'assistant', 'tool_calls': [
        {'id': str(i), 'type': 'function', 'function': {'name': 'write', 'arguments': '{}'}}
        for i in range(count)]}, 'finish_reason': reason}]}).encode()


def stream():
    chunks = [
        {'choices': [{'index': 0, 'delta': {'tool_calls': [{'index': 0, 'id': 'x'}]}, 'finish_reason': None}]},
        {'choices': [{'index': 0, 'delta': {'tool_calls': [{'index': 0, 'function': {'arguments': '{}'}}]}, 'finish_reason': None}]},
        {'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'tool_calls'}]},
        {'choices': [], 'usage': {'completion_tokens': 12}},
    ]
    return (''.join('data: ' + json.dumps(x) + '\n\n' for x in chunks) + 'data: [DONE]\n\n').encode()


class ReplyBudgetTest(unittest.TestCase):
    def test_stream_fragments_charge_one_call_and_share_cumulative_allowance(self):
        guard = budget_module.ReplyBudget(2, time.monotonic() + 30)
        guard(stream(), 'text/event-stream'); guard(reply(), 'application/json')
        self.assertEqual(guard.admitted_tools, 2)
        with self.assertRaises(ValueError): guard(reply(), 'application/json')
        self.assertEqual(guard.admitted_tools, 2)

    def test_truncation_invalid_choices_and_legacy_calls_are_refused(self):
        for data, kind in [(stream().replace(b'data: [DONE]\n\n', b''), 'text/event-stream'),
                           (b'{"choices":[]}', 'application/json'),
                           (reply(reason='length'), 'application/json'),
                           (b'{"choices":[{"message":{"function_call":{}},"finish_reason":"stop"}]}', 'application/json')]:
            with self.subTest(data=data), self.assertRaises(ValueError):
                budget_module.ReplyBudget(10, time.monotonic() + 30)(data, kind)

    def test_deadline_refuses_even_a_final_reply(self):
        with self.assertRaises(ValueError):
            budget_module.ReplyBudget(10, time.monotonic() - 1)(reply(0, 'stop'), 'application/json')

    def test_concurrent_replies_cannot_overdraw_the_same_budget(self):
        guard = budget_module.ReplyBudget(1, time.monotonic() + 30)
        accepted = []
        def call():
            try: guard(reply(), 'application/json'); accepted.append(True)
            except ValueError: pass
        threads = [threading.Thread(target=call) for _ in range(8)]
        for t in threads: t.start()
        for t in threads: t.join()
        self.assertEqual(len(accepted), 1)

    def test_relay_veto_hides_entire_tool_reply_and_call_limit_still_blocks_dispatch(self):
        calls = []
        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *_args): pass
            def do_POST(self):
                calls.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                data = reply(2)
                self.send_response(200); self.send_header('Content-Type', 'application/json')
                self.end_headers(); self.wfile.write(data)
        upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        self.addCleanup(upstream.server_close); self.addCleanup(upstream.shutdown)
        with tempfile.TemporaryDirectory() as t:
            path = str(Path(t) / 'model.sock')
            server = relay.serve(path, f'http://127.0.0.1:{upstream.server_port}/v1',
                request_budget={'calls': 1, 'key': 'fixture'},
                request_policy={'max_tokens': 32, 'reasoning_effort': 'none'},
                response_guard=budget_module.ReplyBudget(1, time.monotonic() + 30))
            self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
            for _ in range(2):
                c = http.client.HTTPConnection('worker', timeout=5)
                c.sock = socket.socket(socket.AF_UNIX); c.sock.connect(path)
                c.request('POST', '/v1/chat/completions', body=json.dumps({'max_tokens': 4096}))
                r = c.getresponse(); body = r.read(); c.close()
                self.assertEqual(r.status, 400)
                self.assertNotIn(b'"tool_calls":', body)
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0]['max_tokens'], 32)

    def test_invalid_reply_guard_preserves_existing_socket_path(self):
        with tempfile.TemporaryDirectory() as t:
            path = Path(t) / 'kept'; path.write_text('keep')
            for kwargs in [{'response_guard': True}, {'response_guard': lambda *_: None, 'max_response_bytes': 0}]:
                with self.assertRaises(ValueError): relay.serve(str(path), 'http://127.0.0.1:1', **kwargs)
            self.assertEqual(path.read_text(), 'keep')


if __name__ == '__main__': unittest.main()
