import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from memory_review.client import MemoryReviewClient, AgentXUnavailable
from memory_review.synthesis import http_chat_completion, SynthesisError


class NativeAccessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.code_file = Path(self.temp.name) / "parent-code"
        self.code_file.write_text("synthetic-parent-code\n", encoding="utf-8")
        self.env = patch.dict(os.environ, {"AGENTX_ACCESS_CODE_FILE": str(self.code_file)})
        self.env.start()
        self.addCleanup(self.env.stop)
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
                    self.send_header("Location", "/must-not-receive-credentials")
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

    def test_review_and_synthesis_use_same_code_and_read_rotation(self):
        client = MemoryReviewClient(self.base)
        self.assertTrue(client.digest()["accepted"])
        self.code_file.write_text("rotated-synthetic-code", encoding="utf-8")
        self.assertEqual(http_chat_completion(self.base, {}), "synthetic answer")
        self.assertEqual(self.seen, [
            ("/api/memory-review/digest", "Bearer synthetic-parent-code"),
            ("/api/hermes-openai/v1/chat/completions", "Bearer rotated-synthetic-code"),
        ])

    def test_loopback_without_configured_code_remains_available(self):
        os.environ.pop("AGENTX_ACCESS_CODE_FILE")
        MemoryReviewClient(self.base).digest()
        http_chat_completion(self.base, {})
        self.assertTrue(all(auth is None for _, auth in self.seen))

    def test_unreadable_empty_or_multiline_code_sends_nothing(self):
        for content in ("", "\n", "first\nsecond", None):
            with self.subTest(content=content):
                if content is None:
                    self.code_file.unlink()
                else:
                    self.code_file.write_text(content, encoding="utf-8")
                with self.assertRaises(AgentXUnavailable):
                    MemoryReviewClient(self.base).digest()
                with self.assertRaises(SynthesisError):
                    http_chat_completion(self.base, {})
        self.assertEqual(self.seen, [])

    def test_redirects_never_forward_observations_or_code(self):
        for status in (301, 302, 303, 307, 308):
            with self.subTest(status=status):
                self.redirect = status
                with self.assertRaises(AgentXUnavailable):
                    MemoryReviewClient(self.base).digest()
                with self.assertRaises(SynthesisError):
                    http_chat_completion(self.base, {"synthetic": "observation"})
        self.assertEqual(len(self.seen), 10)
        self.assertFalse(any(path == "/must-not-receive-credentials" for path, _ in self.seen))


if __name__ == "__main__":
    unittest.main()
