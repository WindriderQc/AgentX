import json
from unittest import mock
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from memory_review.client import MemoryReviewClient, AgentXUnavailable
from memory_review.synthesis import http_chat_completion, SynthesisError



_PRIOR_TOKEN = None


def setUpModule():
    global _PRIOR_TOKEN
    _PRIOR_TOKEN = os.environ.get("AGENTX_LLM_MEMORY_REVIEW_TOKEN")
    os.environ["AGENTX_LLM_MEMORY_REVIEW_TOKEN"] = "memory-review-token-0123"


def tearDownModule():
    if _PRIOR_TOKEN is None:
        os.environ.pop("AGENTX_LLM_MEMORY_REVIEW_TOKEN", None)
    else:
        os.environ["AGENTX_LLM_MEMORY_REVIEW_TOKEN"] = _PRIOR_TOKEN

class NativeAccessTests(unittest.TestCase):
    def setUp(self):
        self.seen = []
        self.redirect = None
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                owner.seen.append((self.path, self.headers.get("Authorization")))
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                if owner.redirect:
                    self.send_response(owner.redirect)
                    self.send_header("Location", "/must-not-receive-observations")
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "data": {"accepted": True},
                    "choices": [{"message": {"content": "synthetic answer"}}],
                }).encode())

            do_POST = do_GET

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def test_review_needs_no_credential_and_synthesis_sends_its_gateway_token(self):
        self.assertTrue(MemoryReviewClient(self.base).digest()["accepted"])
        self.assertEqual(http_chat_completion(self.base, {}), "synthetic answer")
        self.assertEqual(self.seen, [
            ("/api/memory-review/digest", None),
            ("/api/llm/v1/chat/completions", "Bearer memory-review-token-0123"),
        ])

    def test_synthesis_without_its_token_refuses_before_sending(self):
        with mock.patch.dict(os.environ, {"AGENTX_LLM_MEMORY_REVIEW_TOKEN": ""}):
            with self.assertRaises(SynthesisError):
                http_chat_completion(self.base, {})
        self.assertEqual(self.seen, [])

    def test_redirects_never_forward_observations(self):
        for status in (301, 302, 303, 307, 308):
            with self.subTest(status=status):
                self.redirect = status
                with self.assertRaises(AgentXUnavailable):
                    MemoryReviewClient(self.base).digest()
                with self.assertRaises(SynthesisError):
                    http_chat_completion(self.base, {"synthetic": "observation"})
        self.assertEqual(len(self.seen), 10)
        self.assertFalse(any(path == "/must-not-receive-observations" for path, _ in self.seen))


if __name__ == "__main__":
    unittest.main()
