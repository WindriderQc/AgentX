import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from reports_stubs import FakeOpener, RouteStub
from reports import openclaw_leantime_idea_inbox as inbox


URL = "http://leantime.example.test:8080/api/jsonrpc"


class LeantimeInboxTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.key_file = Path(temp.name) / "leantime-key"
        self.key_file.write_text("synthetic-key\n", encoding="utf-8")

    def run_main(self, argv, body, env=None):
        stub = RouteStub({"/api/jsonrpc": body})
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, env or {}, clear=True), \
                mock.patch.object(inbox.urllib.request, "build_opener", lambda *_: FakeOpener(stub)), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = inbox.main(argv)
        return code, out.getvalue(), err.getvalue(), stub

    def args(self):
        return ["--url", URL, "--user-id", "3", "--api-key-file", str(self.key_file)]

    def test_lists_open_ideas_with_source_host(self):
        body = {"jsonrpc": "2.0", "id": 1, "result": [
            {"id": 11, "headline": "  Build a   bird feeder ", "projectName": "Maison"},
            {"id": 12, "headline": "", "projectName": None},
        ]}
        code, out, _, stub = self.run_main(self.args(), body)
        self.assertEqual(code, 0)
        self.assertEqual(out.strip().splitlines(), [
            "📝 Liste d'idées — Leantime",
            "",
            "• Build a bird feeder   (#11 · Maison)",
            "• sans titre   (#12 · projet inconnu)",
            "",
            "2 idée(s) ouverte(s) · source : Leantime @ leantime.example.test",
        ])
        request = stub.requests[0]
        self.assertEqual(request.get_header("X-api-key"), "synthetic-key")
        payload = json.loads(request.data)
        self.assertEqual(payload["method"], "leantime.rpc.Tickets.getAllOpenUserTickets")
        self.assertEqual(payload["params"], {"userId": 3})

    def test_empty_inbox(self):
        code, out, _, _ = self.run_main(self.args(), {"result": []})
        self.assertEqual(code, 0)
        self.assertIn("(inbox vide)", out)

    def test_environment_configuration(self):
        code, _, _, stub = self.run_main([], {"result": []}, env={
            "LEANTIME_JSONRPC_URL": URL,
            "LEANTIME_IDEA_USER_ID": "5",
            "LEANTIME_API_KEY_FILE": str(self.key_file),
        })
        self.assertEqual(code, 0)
        self.assertEqual(stub.requests[0].full_url, URL)
        self.assertEqual(json.loads(stub.requests[0].data)["params"], {"userId": 5})

    def test_missing_url_or_user_fails_without_request(self):
        for argv, message in (
            (["--user-id", "3", "--api-key-file", str(self.key_file)], "URL is not configured"),
            (["--url", URL, "--api-key-file", str(self.key_file)], "user id is not configured"),
            (["--url", URL, "--user-id", "0", "--api-key-file", str(self.key_file)], "user id is invalid"),
            (["--url", "file:///etc/passwd", "--user-id", "3"], "URL is invalid"),
        ):
            code, out, err, stub = self.run_main(argv, {"result": []})
            self.assertEqual(code, 1)
            self.assertEqual(out, "")
            self.assertIn(message, err)
            self.assertEqual(stub.requests, [])

    def test_missing_credential_fails(self):
        argv = ["--url", URL, "--user-id", "3", "--api-key-file", str(self.key_file) + ".absent"]
        code, _, err, _ = self.run_main(argv, {"result": []})
        self.assertEqual(code, 1)
        self.assertIn("credential is unavailable", err)

    def test_jsonrpc_error_fails(self):
        code, _, err, _ = self.run_main(self.args(), {"error": {"code": -32601}, "result": None})
        self.assertEqual(code, 1)
        self.assertIn("invalid JSON-RPC response", err)

    def test_output_is_bounded(self):
        items = [{"id": n, "headline": "x" * 240, "projectName": "p"} for n in range(50)]
        text = inbox.render(items, "leantime.example.test")
        self.assertLessEqual(len(text), inbox.MAX_OUTPUT_CHARS)
        self.assertTrue(text.endswith("…[tronqué]"))


if __name__ == "__main__":
    unittest.main()
