import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from memory_review.client import MemoryReviewClient, AgentXUnavailable
from memory_review.synthesis import http_chat_completion, SynthesisError


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

    def test_review_and_synthesis_use_lan_without_credentials(self):
        self.assertTrue(MemoryReviewClient(self.base).digest()["accepted"])
        self.assertEqual(http_chat_completion(self.base, {}), "synthetic answer")
        self.assertEqual(self.seen, [
            ("/api/memory-review/digest", None),
            ("/api/hermes-openai/v1/chat/completions", None),
        ])

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
