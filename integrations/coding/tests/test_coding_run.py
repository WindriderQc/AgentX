import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location("coding_run", Path(__file__).resolve().parents[1] / "coding_run.py")
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class CodingRunTest(unittest.TestCase):
    def setUp(self):
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        self.workspace = Path(root.name) / "task-0001"
        self.workspace.mkdir()
        runner.git(self.workspace, "init", "--quiet")
        (self.workspace / "README.md").write_text("Initial source\n")
        runner.git(self.workspace, "add", "README.md")
        runner.git(self.workspace, *runner.AUTHOR, "commit", "--quiet", "-m", "Initial")
        runner.git(self.workspace, "update-ref", "refs/remotes/origin/main", "HEAD")
        self.task = {"title": "Fix a synthetic fixture", "spec": "Keep the full request.",
                     "feedback": [{"by": "operator", "text": f"Fact {i}."} for i in range(20)],
                     "planningContext": {"text": "Reference only. " + "x" * 5000 + " Final fact."}}
        self.feedback = mock.Mock()
        for name, value in (("WORKSPACES", Path(root.name)), ("MODEL", "fixture-model"),
                            ("feedback", self.feedback), ("request", self.request),
                            ("install_dependencies", lambda workspace, progress=None: None)):
            patch = mock.patch.object(runner, name, value)
            patch.start()
            self.addCleanup(patch.stop)
        patch = mock.patch.object(sys, "argv", ["coding_run", "0001", "--timeout-seconds", "1"])
        patch.start()
        self.addCleanup(patch.stop)

    def request(self, url, body=None, token=""):
        return {"data": {"task": self.task}} if "/worker?" in url else {}

    def worker(self, workspace, prompt, timeout, progress=None):
        self.prompt = prompt
        (workspace / "result.txt").write_text("Synthetic result\n")
        return subprocess.CompletedProcess([], self.exit_code, stdout="Ran fixture verification.", stderr="")

    def test_completed_work_is_committed_and_offered_as_a_draft_pr(self):
        self.exit_code = 0
        with mock.patch.object(runner, "run_worker", self.worker), \
                mock.patch.object(runner, "push_and_open_pr", return_value="https://example.test/pr") as publish, \
                mock.patch.dict(os.environ, {"GH_TOKEN": "fixture-token"}), mock.patch("builtins.print"):
            self.assertEqual(runner.main(), 0)
        self.assertEqual(self.feedback.call_args.args[-1], "done")  # Core maps worker done to review.
        self.assertEqual(publish.call_count, 1)
        self.assertEqual(runner.git(self.workspace, "status", "--porcelain"), "")
        self.assertIn("Fact 0.", self.prompt)
        self.assertIn("Fact 19.", self.prompt)
        self.assertIn(self.task["planningContext"]["text"], self.prompt)

    def test_interrupted_work_stays_committed_locally_without_a_pr(self):
        self.exit_code = 124
        with mock.patch.object(runner, "run_worker", self.worker), \
                mock.patch.object(runner, "push_and_open_pr") as publish, \
                mock.patch.dict(os.environ, {"GH_TOKEN": "fixture-token"}), mock.patch("builtins.print"):
            self.assertEqual(runner.main(), 1)
        self.assertEqual(self.feedback.call_args.args[-1], "blocked")
        publish.assert_not_called()
        self.assertEqual(runner.git(self.workspace, "status", "--porcelain"), "")
        self.assertTrue((self.workspace / "result.txt").exists())

    def test_nonzero_exit_is_not_retried_and_terminal_receipt_keeps_checkpoint(self):
        self.exit_code = 7
        key = "11111111-2222-4333-8444-555555555555"
        import json
        with mock.patch.object(sys, "argv", ["coding_run", "0001", "--request-id", key]), \
                mock.patch.object(runner, "RECEIPTS", self.workspace.parent / "receipts"), \
                mock.patch.object(runner, "run_worker", side_effect=self.worker) as worker, \
                mock.patch.object(runner, "push_and_open_pr") as publish, mock.patch("builtins.print"):
            self.assertEqual(runner.main(), 1)
        self.assertEqual(worker.call_count, 1)
        publish.assert_not_called()
        value = json.loads((self.workspace.parent / "receipts" / f"{key}.progress.json").read_text())
        self.assertEqual((value["phase"], value["result"], value["stopReason"]), ("finished", "blocked", "worker_exit"))
        self.assertEqual(value["checkpoint"], runner.git(self.workspace, "rev-parse", "HEAD"))

    def test_checkpoint_excludes_generated_caches_and_transcripts(self):
        self.exit_code = 124
        def worker(workspace, prompt, timeout, progress):
            for name in [".lab/probe.txt", ".npmcache/cache", "nested/session.jsonl", "core/result.js"]:
                path = workspace / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("Synthetic fixture")
            return subprocess.CompletedProcess([], 124, stdout="", stderr="")
        with mock.patch.object(runner, "run_worker", worker), mock.patch("builtins.print"):
            self.assertEqual(runner.main(), 1)
        self.assertEqual(runner.git(self.workspace, "diff", "--name-only", "HEAD^", "HEAD"), "core/result.js")
        self.assertTrue((self.workspace / ".lab/probe.txt").exists())

    def test_no_change_is_blocked_without_publishing(self):
        run = subprocess.CompletedProcess([], 0, stdout="No change needed.", stderr="")
        with mock.patch.object(runner, "run_worker", return_value=run), \
                mock.patch.object(runner, "push_and_open_pr") as publish, mock.patch("builtins.print"):
            self.assertEqual(runner.main(), 1)
        publish.assert_not_called()
        self.assertEqual(self.feedback.call_args.args[-1], "blocked")

    def test_publishing_never_force_pushes_or_puts_the_token_in_the_remote(self):
        with mock.patch.object(runner, "git") as git, \
                mock.patch.object(runner, "request", return_value=[{"html_url": "https://example.test/pr"}]):
            runner.push_and_open_pr(self.workspace, "agentx/coding-task-0001", "0001", "Fixture", "Summary", "secret-fixture")
        self.assertNotIn("--force", git.call_args.args)
        self.assertNotIn("secret-fixture", " ".join(str(arg) for arg in git.call_args.args))

    def test_delivery_git_does_not_execute_repository_hooks_or_owner_filters(self):
        marker = self.workspace / "outside-command-ran"
        hook = self.workspace / ".git/hooks/pre-commit"
        hook.write_text(f"#!/usr/bin/env python3\nfrom pathlib import Path\nPath({str(marker)!r}).touch()\n")
        hook.chmod(0o700)
        global_config = self.workspace.parent / "owner-gitconfig"
        global_config.write_text(f'[filter "probe"]\n clean = touch {marker}\n')
        (self.workspace / ".gitattributes").write_text("result.txt filter=probe\n")
        (self.workspace / "result.txt").write_text("Preserve the worker's file\n")
        with mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": str(global_config)}):
            runner.git(self.workspace, "add", "-A")
            runner.git(self.workspace, *runner.AUTHOR, "commit", "--quiet", "-m", "Fixture")
        self.assertFalse(marker.exists())
        self.assertEqual(runner.git(self.workspace, "show", "HEAD:result.txt"), "Preserve the worker's file")


    def test_changed_package_files_wait_for_the_owner_instead_of_a_pr(self):
        self.exit_code = 0

        def worker(workspace, prompt, timeout, progress=None):
            (workspace / "core").mkdir()
            (workspace / "core/package.json").write_text('{"dependencies":{"left-pad":"1.3.0"}}\n')
            return subprocess.CompletedProcess([], 0, stdout="Needs left-pad installed.", stderr="")

        with mock.patch.object(runner, "run_worker", worker), \
                mock.patch.object(runner, "push_and_open_pr") as publish, \
                mock.patch.dict(os.environ, {"GH_TOKEN": "fixture-token"}), mock.patch("builtins.print"):
            self.assertEqual(runner.main(), 1)
        self.assertEqual(self.feedback.call_args.args[-1], "blocked")
        self.assertIn("approve the installation", self.feedback.call_args.args[1])
        self.assertEqual(publish.call_count, 0)


class ModelRelayTest(unittest.TestCase):
    """The worker's sandbox has no network and one relay, which forwards chat completions only."""

    def setUp(self):
        import http.server
        import threading
        seen = self.seen = []

        class Upstream(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                seen.append((self.path, self.rfile.read(int(self.headers["Content-Length"]))))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"choices":[{"message":{"content":"pong"}}]}')

            def log_message(self, *args):
                pass

        self.upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        threading.Thread(target=self.upstream.serve_forever, daemon=True).start()
        self.addCleanup(self.upstream.server_close)
        self.addCleanup(self.upstream.shutdown)
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        self.home = Path(root.name) / "home"
        self.workspace = Path(root.name) / "task-0001"
        (self.workspace / ".git").mkdir(parents=True)
        self.home.mkdir()
        self.port = self.upstream.server_address[1]
        relay = runner.model_relay.serve(str(self.home / "model.sock"), f"http://127.0.0.1:{self.port}/v1")
        self.addCleanup(relay.server_close)
        self.addCleanup(relay.shutdown)

    PROBE = """
import json, socket, sys, urllib.error, urllib.request
def call(method, url, body=None):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=body, method=method), timeout=10) as reply:
            return reply.status, reply.read().decode()
    except urllib.error.HTTPError as error:
        return error.code, ""
    except OSError as error:
        return "unreachable", type(error).__name__
relay = "http://127.0.0.1:8377"
print(json.dumps({
    "chat": call("POST", relay + "/v1/chat/completions", b'{"messages":[]}'),
    "other_path": call("POST", relay + "/api/pipeline/tasks", b"{}")[0],
    "other_method": call("GET", relay + "/v1/chat/completions")[0],
    "host_service": call("POST", "http://127.0.0.1:%s/v1/chat/completions" % sys.argv[1], b"{}")[0],
}))
"""

    def test_the_sandboxed_worker_reaches_the_model_route_and_nothing_else(self):
        with mock.patch.object(runner, "DSH_ROOT", self.home):
            command = runner.sandbox(self.workspace, self.home, [
                "python3", "/opt/coding/model_relay.py", "inside", "/home/agent/model.sock", "8377", "--",
                "python3", "-c", self.PROBE, str(self.port)], network=False, timeout_seconds=60)
        run = subprocess.run(command, text=True, capture_output=True)
        if run.returncode != 0 and "bwrap" in run.stderr:
            self.skipTest("Bubblewrap cannot create a sandbox on this machine")
        import json
        self.assertEqual(json.loads(run.stdout), {
            "chat": [200, '{"choices":[{"message":{"content":"pong"}}]}'],
            "other_path": 403, "other_method": 403, "host_service": "unreachable"}, run.stderr)
        self.assertEqual(self.seen, [("/v1/chat/completions", b'{"messages":[]}')])


if __name__ == "__main__":
    unittest.main()
