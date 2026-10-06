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
                            ("feedback", self.feedback), ("request", self.request)):
            patch = mock.patch.object(runner, name, value)
            patch.start()
            self.addCleanup(patch.stop)
        patch = mock.patch.object(sys, "argv", ["coding_run", "0001", "--timeout-seconds", "1"])
        patch.start()
        self.addCleanup(patch.stop)

    def request(self, url, body=None, token=""):
        return {"data": {"task": self.task}} if "/worker?" in url else {}

    def worker(self, workspace, prompt, timeout):
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


if __name__ == "__main__":
    unittest.main()
