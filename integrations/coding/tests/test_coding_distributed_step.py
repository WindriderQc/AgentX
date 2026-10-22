import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import types
import unittest


ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


step_worker = load("coding_distributed_step")
workspace_tools = load("coding_step_workspace")
REQUEST = "11111111-1111-4111-8111-111111111111"
FINGERPRINT = "a" * 64


def git(path, *args):
    return subprocess.run(["git", "-C", str(path), *args], check=True,
                          text=True, capture_output=True).stdout.strip()


class GitAdapter:
    def __init__(self, root, outside=False, fail_result_once=False):
        self.root = root
        self.repo = root / "repo"
        self.worktree = root / "worktree"
        self.artifact = root / "step.bundle"
        self.outside = outside
        self.fail_result_once = fail_result_once
        self.harness_calls = self.uploads = self.results = 0
        self.result_bodies = []
        self.base = ""
        self._init_repo()

    def _init_repo(self):
        self.repo.mkdir()
        git(self.repo, "init", "-q")
        git(self.repo, "config", "user.name", "Test")
        git(self.repo, "config", "user.email", "test@example.invalid")
        (self.repo / "src").mkdir()
        (self.repo / "src/value.py").write_text("VALUE = 1\n")
        (self.repo / "outside.py").write_text("OLD = True\n")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-qm", "base")
        self.base = git(self.repo, "rev-parse", "HEAD")

    def prepare(self, manifest):
        workspace_tools.prepare_worktree(self.repo, self.worktree, self.base, "step-test")
        return self.worktree

    def harness(self, workspace, _prompt, _manifest):
        self.harness_calls += 1
        (workspace / "src/value.py").write_text("VALUE = 2\n")
        if self.outside:
            (workspace / "outside.py").write_text("OLD = False\n")
        return types.SimpleNamespace(returncode=0)

    def changed(self, workspace, base):
        return git(workspace, "diff", "--name-only", base).splitlines()

    def tests(self, _workspace, manifest):
        return [{"target": target, "profile": manifest["verificationProfile"],
                 "outcome": "passed", "durationMs": 4} for target in manifest["testTargets"]]

    def commit(self, workspace, _manifest, changed):
        git(workspace, "add", *changed)
        git(workspace, "-c", "user.name=Worker", "-c", "user.email=worker@example.invalid",
            "commit", "-qm", "step")
        return git(workspace, "rev-parse", "HEAD")

    def parent(self, workspace, commit):
        return git(workspace, "rev-parse", commit + "^")

    def export(self, workspace, manifest, commit):
        receipt = workspace_tools.export_commit(workspace, self.artifact, self.base,
                                                commit, manifest["allowedPaths"])
        return self.artifact, receipt

    def upload(self, path):
        self.uploads += 1
        data = path.read_bytes()
        return {"id": "artifact-1", "sha256": hashlib.sha256(data).hexdigest(),
                "sizeBytes": len(data), "format": "git-bundle/v1"}

    def result(self, body):
        self.results += 1
        self.result_bodies.append(body)
        if self.fail_result_once and self.results == 1:
            raise OSError("lost terminal response")

    def usage(self, _started):
        return {"workSeconds": 1, "testSeconds": 1, "modelSeconds": 1, "modelCalls": 1}

    @staticmethod
    def now():
        return "2026-10-22T12:00:00.000Z"


def manifest(base):
    raw = {"schema": "agentx.pipeline-code-step-worker-manifest/v1", "role": "step",
           "pipelineId": "0946", "graphId": FINGERPRINT, "sourceCommit": base,
           "requestId": REQUEST, "baseCommit": base, "executorId": "alien-open",
           "budget": {"workSeconds": 600, "testSeconds": 120, "modelSeconds": 300, "modelCalls": 4},
           "verificationProfile": "agentx-dispatcher-tests/v1", "harness": "opencode",
           "model": "qwen3-coder:30b",
           "step": {"stepId": "step-01", "title": "Change value", "objective": "change it",
                    "paths": ["src/value.py"], "testTargets": ["integrations/coding/tests/test_x.py"]},
           "rootLeaseId": "root-lease-1", "manifestFingerprint": FINGERPRINT}
    return step_worker.validate_manifest(raw, task_id="0946", request_id=REQUEST,
        graph_id=FINGERPRINT, executor_id="alien-open", step_id="step-01", fingerprint=FINGERPRINT)


class DistributedStepTest(unittest.TestCase):
    def test_verified_bundle_and_terminal_result_are_replay_safe(self):
        with tempfile.TemporaryDirectory() as directory:
            adapter = GitAdapter(Path(directory))
            worker = step_worker.StepWorker(adapter, Path(directory) / "journal")
            first = worker.execute(manifest(adapter.base))
            second = worker.execute(manifest(adapter.base))
            self.assertEqual(first["outcome"], "verified")
            self.assertTrue(second["replayed"])
            self.assertEqual(adapter.harness_calls, 1)
            self.assertEqual((adapter.uploads, adapter.results), (1, 2))
            self.assertEqual(git(adapter.worktree, "rev-list", "--count", adapter.base + "..HEAD"), "1")

    def test_scope_escape_posts_durable_failed_result_and_replays_it(self):
        with tempfile.TemporaryDirectory() as directory:
            adapter = GitAdapter(Path(directory), outside=True)
            worker = step_worker.StepWorker(adapter, Path(directory) / "journal")
            first = worker.execute(manifest(adapter.base))
            second = worker.execute(manifest(adapter.base))
            self.assertEqual(first["outcome"], "failed")
            self.assertEqual(first["receipt"]["code"], "step_scope_changed")
            self.assertTrue(second["replayed"])
            self.assertEqual(adapter.uploads, 0)
            self.assertEqual(adapter.results, 2)
            self.assertEqual(adapter.harness_calls, 1)
            self.assertEqual(git(adapter.worktree, "rev-parse", "HEAD"), adapter.base)

    def test_lost_terminal_post_stays_unknown_until_exact_replay(self):
        with tempfile.TemporaryDirectory() as directory:
            adapter = GitAdapter(Path(directory), fail_result_once=True)
            worker = step_worker.StepWorker(adapter, Path(directory) / "journal")
            with self.assertRaisesRegex(OSError, "lost terminal"):
                worker.execute(manifest(adapter.base))
            replay = worker.execute(manifest(adapter.base))
            self.assertEqual(replay["outcome"], "verified")
            self.assertTrue(replay["replayed"])
            self.assertEqual(adapter.harness_calls, 1)
            self.assertEqual(adapter.results, 2)


if __name__ == "__main__":
    unittest.main()
