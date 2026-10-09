import io
import json
import os
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stdout, redirect_stderr
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from memory_review import cli  # noqa: E402
from memory_review.watermarks import WatermarkStore  # noqa: E402


def write_jsonl(path: Path, events):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        for event in events:
            handle.write(json.dumps(event) + "\n")


def make_openclaw_home(root: Path):
    sessions = root / "openclaw" / "agents" / "main" / "sessions"
    write_jsonl(sessions / "chat.jsonl", [
        {"type": "message", "id": "e1", "timestamp": 1,
         "message": {"role": "user", "senderId": "owner-1",
                     "content": [{"type": "text", "text": "Remember that deploys go through CI."}]}},
    ])
    return root / "openclaw"


class StubCore(BaseHTTPRequestHandler):
    """Minimal /api/memory-review stub. Class attrs configure behavior."""

    accept_observations = True
    open_runs: list = []
    open_status = "collecting"
    calls: list = []

    def _reply(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        type(self).calls.append((self.path, body))
        if self.path.endswith("/observations") and not type(self).accept_observations:
            self._reply(500, {"status": "error", "message": "boom"})
            return
        if self.path == "/api/memory-review/runs":
            self._reply(200, {"status": "success", "data": {"runId": "run-1", "status": type(self).open_status}})
        elif self.path.endswith("/observations"):
            count = len(body.get("observations") or [])
            self._reply(200, {"status": "success", "data": {"accepted": count, "duplicates": 0}})
        elif self.path.endswith("/finalize"):
            self._reply(200, {"status": "success", "data": {"status": "completed",
                                                            "summary": {"noEligibleObservations": True}}})
        else:
            self._reply(200, {"status": "success", "data": {}})

    def do_GET(self):
        type(self).calls.append((self.path, None))
        if self.path.startswith("/api/memory-review/runs?"):
            self._reply(200, {"status": "success", "data": {"runs": type(self).open_runs}})
        elif self.path.endswith("/synthesis-input"):
            self._reply(200, {"status": "success", "data": {"observations": []}})
        elif "/runs/" in self.path:
            self._reply(200, {"status": "success", "data": {
                "runId": "run-1", "mode": "shadow", "status": "completed",
                "window": {}, "model": {}, "collectors": [], "candidates": [],
                "summary": {"noEligibleObservations": True},
            }})
        else:
            self._reply(200, {"status": "success", "data": {"runs": []}})

    def log_message(self, *args):  # silence request logging in tests
        pass


class CliDryRunTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.state = self.root / "state"
        self._owner_ids = os.environ.get("AGENTX_MEMORY_REVIEW_OWNER_IDS")
        os.environ["AGENTX_MEMORY_REVIEW_OWNER_IDS"] = "owner-1"
        self.addCleanup(self._restore_owner_ids)

    def _restore_owner_ids(self):
        if self._owner_ids is None:
            os.environ.pop("AGENTX_MEMORY_REVIEW_OWNER_IDS", None)
        else:
            os.environ["AGENTX_MEMORY_REVIEW_OWNER_IDS"] = self._owner_ids

    def test_synthesis_exchanges_are_kept_private_and_bounded(self):
        import contextlib, io as _io, stat, tempfile
        from memory_review import cli as cli_module
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp)
            original = cli_module.SYNTHESIS_EXCHANGES_KEPT
            cli_module.SYNTHESIS_EXCHANGES_KEPT = 2
            try:
                with contextlib.redirect_stdout(_io.StringIO()):
                    cli_module._keep_synthesis_exchanges(state, "run-empty", [])
                    for name in ("run-a", "run-b", "run-c"):
                        cli_module._keep_synthesis_exchanges(
                            state, name, [{"request": {"messages": []}, "reply": "{}", "reasoning": "why"}])
            finally:
                cli_module.SYNTHESIS_EXCHANGES_KEPT = original
            kept = sorted((state / "synthesis").glob("*.json"))
            self.assertEqual(len(kept), 2)
            self.assertFalse(any(path.name.startswith(("run-empty", "run-a")) for path in kept))
            self.assertEqual(stat.S_IMODE(kept[0].stat().st_mode), 0o600)
            self.assertEqual(json.loads(kept[0].read_text())["exchanges"][0]["reasoning"], "why")

    def test_collect_dry_run_is_read_only(self):
        home = make_openclaw_home(self.root)
        out = io.StringIO()
        with redirect_stdout(out):
            code = cli.main([
                "collect", "--runtime", "openclaw", "--dry-run",
                "--openclaw-home", str(home), "--state-dir", str(self.state),
            ])
        self.assertEqual(code, 0)
        self.assertIn("eligible=1", out.getvalue())
        # dry-run must not create watermark state
        self.assertFalse((self.state / "watermarks-openclaw.json").exists())

    def test_collect_without_server_never_advances_watermarks(self):
        home = make_openclaw_home(self.root)
        out = io.StringIO()
        with redirect_stdout(out):
            cli.main([
                "collect", "--runtime", "openclaw",
                "--openclaw-home", str(home), "--state-dir", str(self.state),
            ])
        self.assertFalse((self.state / "watermarks-openclaw.json").exists())

    def test_watermarks_show_and_reset(self):
        store = WatermarkStore("openclaw", self.state)
        store.commit({"a.jsonl": {"size": 1, "mtimeNs": 1, "offset": 1, "sig": "x", "sigLen": 1}})
        out = io.StringIO()
        with redirect_stdout(out):
            cli.main(["watermarks", "show", "--runtime", "openclaw",
                      "--state-dir", str(self.state)])
        self.assertIn("1 sources", out.getvalue())
        with redirect_stdout(io.StringIO()):
            cli.main(["watermarks", "reset", "--runtime", "openclaw",
                      "--state-dir", str(self.state)])
        self.assertEqual(WatermarkStore("openclaw", self.state).entries, {})

    def test_legacy_file_writer_is_not_a_canonical_entry_point(self):
        out = io.StringIO()
        with redirect_stderr(out):
            with self.assertRaises(SystemExit) as ctx:
                cli.main(["legacy-proposal", "--help"])
        self.assertEqual(ctx.exception.code, 2)
        self.assertIn("invalid choice", out.getvalue())


class CliRunOrchestrationTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.state = self.root / "state"
        StubCore.calls = []
        StubCore.accept_observations = True
        StubCore.open_runs = []
        StubCore.open_status = "collecting"
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), StubCore)
        self.addCleanup(self.server.server_close)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.shutdown)
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self._owner_ids = os.environ.get("AGENTX_MEMORY_REVIEW_OWNER_IDS")
        os.environ["AGENTX_MEMORY_REVIEW_OWNER_IDS"] = "owner-1"
        self.addCleanup(self._restore_owner_ids)

    def _restore_owner_ids(self):
        if self._owner_ids is None:
            os.environ.pop("AGENTX_MEMORY_REVIEW_OWNER_IDS", None)
        else:
            os.environ["AGENTX_MEMORY_REVIEW_OWNER_IDS"] = self._owner_ids

    def _run_cli(self, extra=None):
        out = io.StringIO()
        with redirect_stdout(out):
            argv = [
                "run", "--runtime", "openclaw", "--mode", "shadow",
                "--model", "verified-test-model",
                "--agentx-url", self.base_url,
                "--openclaw-home", str(make_openclaw_home(self.root)),
                "--state-dir", str(self.state),
            ]
            code = cli.main(argv + list(extra or []))
        return code, out.getvalue()

    def test_acceptance_advances_watermarks(self):
        code, output = self._run_cli()
        self.assertEqual(code, 0, output)
        self.assertIn("watermarks committed", output)
        store = WatermarkStore("openclaw", self.state)
        self.assertEqual(len(store.entries), 1)
        paths = [p for p, _ in StubCore.calls]
        self.assertIn("/api/memory-review/runs", paths)
        self.assertTrue(any(p.endswith("/observations") for p in paths))
        self.assertTrue(any(p.endswith("/finalize") for p in paths))

    def test_failed_submission_does_not_advance_watermarks(self):
        StubCore.accept_observations = False
        code, output = self._run_cli()
        self.assertEqual(code, 1)
        self.assertIn("NOT advanced", output)
        self.assertFalse((self.state / "watermarks-openclaw.json").exists())

    def test_submit_only_leaves_shared_run_collecting(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = cli.main([
                "run", "--runtime", "openclaw", "--mode", "shadow",
                "--submit-only", "--agentx-url", self.base_url,
                "--openclaw-home", str(make_openclaw_home(self.root)),
                "--state-dir", str(self.state),
            ])
        self.assertEqual(code, 0, out.getvalue())
        paths = [path for path, _ in StubCore.calls]
        self.assertTrue(any(path.endswith("/observations") for path in paths))
        self.assertFalse(any(path.endswith("/finalize") for path in paths))
        self.assertFalse(any(path.endswith("/synthesis-input") for path in paths))

    def test_rerun_after_acceptance_submits_nothing_new(self):
        self._run_cli()
        StubCore.calls = []
        code, output = self._run_cli()
        self.assertEqual(code, 0, output)
        observation_batches = [body for path, body in StubCore.calls
                               if path.endswith("/observations") and body]
        total = sum(len(b.get("observations") or []) for b in observation_batches)
        self.assertEqual(total, 0)

    def test_agentx_down_fails_soft(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = cli.main([
                "run", "--runtime", "openclaw",
                "--model", "verified-test-model",
                "--agentx-url", "http://127.0.0.1:9",
                "--openclaw-home", str(make_openclaw_home(self.root)),
                "--state-dir", str(self.state),
            ])
        self.assertEqual(code, 1)
        self.assertIn("cannot open run", out.getvalue())
        self.assertFalse((self.state / "watermarks-openclaw.json").exists())

    def test_reconciliation_recovers_an_older_unfinished_run(self):
        StubCore.open_runs = [{
            "runId": "old-run", "runKey": "memory-review-20260811", "status": "collecting",
        }]
        code, output = self._run_cli(["--run-key", "memory-review-20260812"])
        self.assertEqual(code, 0, output)
        self.assertIn("recovering unfinished prior reconciliation old-run", output)
        paths = [path for path, _ in StubCore.calls]
        self.assertLess(paths.index("/api/memory-review/runs/old-run/finalize"),
                        paths.index("/api/memory-review/runs"))

    def test_reconciliation_recovers_same_day_failed_shadow_synthesis_only(self):
        StubCore.open_runs = [
            {"runId": "failed-today", "runKey": "today", "status": "failed", "mode": "shadow",
             "failure": {"stage": "synthesis", "retryable": True}},
            {"runId": "manual-review", "status": "failed", "mode": "review",
             "failure": {"stage": "synthesis", "retryable": True}},
            {"runId": "failed-collection", "status": "failed", "mode": "shadow",
             "failure": {"stage": "collection", "retryable": True}},
            {"runId": "not-retryable", "status": "failed", "mode": "shadow",
             "failure": {"stage": "synthesis", "retryable": False}},
        ]
        code, output = self._run_cli(["--run-key", "today"])
        self.assertEqual(code, 0, output)
        paths = [path for path, _ in StubCore.calls]
        self.assertLess(paths.index("/api/memory-review/runs/failed-today/finalize"),
                        paths.index("/api/memory-review/runs"))
        for skipped in ("manual-review", "failed-collection", "not-retryable"):
            self.assertFalse(any(f"/{skipped}/" in path for path in paths))

    def test_reopening_reviewed_window_does_not_recollect_or_advance_watermarks(self):
        for status in ("ready_for_review", "partially_reviewed"):
            with self.subTest(status=status):
                StubCore.calls = []
                StubCore.open_status = status
                code, output = self._run_cli()
                self.assertEqual(code, 0, output)
                self.assertIn("existing candidates remain for review", output)
                self.assertFalse(any(path.endswith(("/observations", "/finalize", "/candidates"))
                                     for path, _ in StubCore.calls))
                self.assertFalse((self.state / "watermarks-openclaw.json").exists())

    def test_reopening_synthesis_finishes_retained_evidence_without_recollecting(self):
        StubCore.open_status = "synthesizing"
        code, output = self._run_cli()
        self.assertEqual(code, 0, output)
        paths = [path for path, _ in StubCore.calls]
        self.assertIn("/api/memory-review/runs/run-1/finalize", paths)
        self.assertFalse(any(path.endswith("/observations") for path in paths))
        self.assertFalse((self.state / "watermarks-openclaw.json").exists())


if __name__ == "__main__":
    unittest.main()
