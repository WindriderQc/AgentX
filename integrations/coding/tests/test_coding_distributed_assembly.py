import hashlib
import importlib.util
from pathlib import Path
import shutil
import subprocess
import tempfile
import types
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


assembly_worker = load("coding_distributed_assembly")
workspace_tools = load("coding_step_workspace")
assembly_tools = load("coding_step_assembly")
REQUEST = "22222222-2222-4222-8222-222222222222"
GRAPH = "b" * 64


def git(path, *args):
    return subprocess.run(["git", "-C", str(path), *args], check=True,
                          text=True, capture_output=True).stdout.strip()


class AssemblyAdapter:
    def __init__(self, root):
        self.root, self.repo = root, root / "repo"
        self.worktree, self.bundles = root / "assembly", []
        self.publications = self.completions = 0
        self.adoptions, self.failures = [], []
        self._prepare_source()

    def _prepare_source(self):
        self.repo.mkdir()
        git(self.repo, "init", "-q")
        git(self.repo, "config", "user.name", "Test")
        git(self.repo, "config", "user.email", "test@example.invalid")
        (self.repo / "one.txt").write_text("one\n")
        (self.repo / "two.txt").write_text("two\n")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-qm", "base")
        self.base = git(self.repo, "rev-parse", "HEAD")
        for number, name in enumerate(("one.txt", "two.txt"), 1):
            worktree = self.root / f"child-{number}"
            workspace_tools.prepare_worktree(self.repo, worktree, self.base, f"child-{number}")
            (worktree / name).write_text(f"changed-{number}\n")
            git(worktree, "add", name)
            git(worktree, "-c", "user.name=Worker", "-c", "user.email=w@example.invalid",
                "commit", "-qm", f"step {number}")
            commit = git(worktree, "rev-parse", "HEAD")
            bundle = self.root / f"step-{number}.bundle"
            receipt = workspace_tools.export_commit(worktree, bundle, self.base, commit, [name])
            self.bundles.append((bundle, receipt, name, commit))
        conflict = self.root / "child-conflict"
        workspace_tools.prepare_worktree(self.repo, conflict, self.base, "child-conflict")
        (conflict / "one.txt").write_text("competing-change\n")
        git(conflict, "add", "one.txt")
        git(conflict, "-c", "user.name=Worker", "-c", "user.email=w@example.invalid",
            "commit", "-qm", "conflicting step")
        commit = git(conflict, "rev-parse", "HEAD")
        bundle = self.root / "step-conflict.bundle"
        receipt = workspace_tools.export_commit(conflict, bundle, self.base, commit, ["one.txt"])
        self.bundles.append((bundle, receipt, "one.txt", commit))

    def prepare(self, manifest):
        if not self.worktree.exists():
            workspace_tools.prepare_worktree(self.repo, self.worktree, self.base, "assembly-test")
        return self.worktree

    def download(self, row):
        target = self.root / (row["id"] + ".download")
        shutil.copyfile(row["sourcePath"], target)
        return target

    def adopt(self, workspace, entries, _manifest):
        return assembly_tools.Assembly(workspace, self.root / "adoption-journal").adopt(entries)

    def adoption(self, receipt):
        self.adoptions.append(receipt)

    def tests(self, _workspace, manifest):
        return [{"target": target, "profile": manifest["verificationProfile"],
                 "outcome": "passed", "durationMs": 5} for target in manifest["testTargets"]]

    def head(self, workspace):
        return git(workspace, "rev-parse", "HEAD")

    def publish(self, _workspace, _manifest, publication_id):
        self.publications += 1
        return {"requestId": publication_id, "state": "published", "url": "https://example.invalid/pr/1",
                "prNumber": 1, "headCommit": self.head(self.worktree)}

    def reconcile_publication(self, *_args):
        return None

    def complete(self, _body):
        self.completions += 1

    def failure(self, body):
        self.failures.append(body)

    @staticmethod
    def now():
        return "2026-10-22T12:00:00.000Z"


def manifest(adapter, ready=None, final=False):
    artifacts = []
    if ready is not None:
        path, receipt, name, commit = adapter.bundles[ready - 1]
        artifacts.append({"stepId": f"step-{ready:02d}", "requestId": f"{ready}" * 8 + "-1111-4111-8111-111111111111",
                          "commit": commit, "parent": adapter.base, "sha256": receipt["sha256"],
                          "sizeBytes": receipt["size"], "url": f"/artifact/{ready}",
                          "allowedPaths": [name], "effectiveDependsOn": [], "sourcePath": str(path)})
    raw = {"schema": "agentx.pipeline-code-step-worker-manifest/v1", "role": "assembly",
           "pipelineId": "0946", "title": "Assemble", "graphId": GRAPH,
           "sourceCommit": adapter.base, "planFingerprint": "d" * 64,
           "requestId": REQUEST, "executorId": "coordinator", "harness": "opencode",
           "artifacts": artifacts, "finalReady": final,
           "testTargets": ["integrations/coding/tests/test_x.py"],
           "verificationProfile": "agentx-dispatcher-tests/v1", "manifestFingerprint": "c" * 64}
    return assembly_worker.validate_manifest(raw, task_id="0946", request_id=REQUEST,
        graph_id=GRAPH, executor_id="coordinator", fingerprint="c" * 64)


class DistributedAssemblyTest(unittest.TestCase):
    def test_parallel_step_bundles_are_adopted_and_published_once(self):
        with tempfile.TemporaryDirectory() as directory:
            adapter = AssemblyAdapter(Path(directory))
            worker = assembly_worker.AssemblyWorker(adapter, Path(directory) / "journal")
            self.assertEqual(worker.execute(manifest(adapter, ready=1))["state"], "waiting")
            self.assertEqual(worker.execute(manifest(adapter, ready=2))["state"], "waiting")
            first = worker.execute(manifest(adapter, final=True))
            replay = worker.execute(manifest(adapter, final=True))
            self.assertEqual(first["publication"]["state"], "published")
            self.assertTrue(replay["replayed"])
            self.assertEqual(adapter.publications, 1)
            self.assertEqual(adapter.completions, 2)
            self.assertEqual(len(adapter.adoptions), 2)
            self.assertEqual((adapter.worktree / "one.txt").read_text(), "changed-1\n")
            self.assertEqual((adapter.worktree / "two.txt").read_text(), "changed-2\n")

    def test_conflicting_adoption_posts_and_replays_one_terminal_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            adapter = AssemblyAdapter(Path(directory))
            worker = assembly_worker.AssemblyWorker(adapter, Path(directory) / "journal")
            self.assertEqual(worker.execute(manifest(adapter, ready=1))["state"], "waiting")
            failed = worker.execute(manifest(adapter, ready=3))
            replay = worker.execute(manifest(adapter, ready=3))
            self.assertEqual(failed["failure"]["code"], "assembly_conflict")
            self.assertEqual(failed["failure"]["stepId"], "step-03")
            self.assertTrue(replay["replayed"])
            self.assertEqual(len(adapter.failures), 2)
            self.assertEqual(adapter.failures[0], adapter.failures[1])
            self.assertEqual(git(adapter.worktree, "rev-parse", "HEAD"),
                             adapter.adoptions[0]["resultCommit"])
            self.assertFalse(git(adapter.worktree, "status", "--porcelain"))

    def test_final_dependency_install_cannot_change_the_tree_that_will_be_published(self):
        runtime = types.SimpleNamespace(
            coding_progress=types.SimpleNamespace(source_state=mock.Mock(side_effect=["before", "changed"])),
            install_dependencies=mock.Mock(), sandbox=mock.Mock(), supervise=mock.Mock(),
            worker_home=mock.Mock(), git=mock.Mock(), push_and_open_pr=mock.Mock(),
            RECEIPTS=Path("/tmp"), WORKSPACES=Path("/tmp"), REPOSITORY="example/project",
            BASE_BRANCH="main")
        progress = mock.Mock()
        args = types.SimpleNamespace(graph_id=GRAPH, task_id="0946", timeout_seconds=30)
        checked = {"verificationProfile": "agentx-dispatcher-tests/v1", "testTargets": ["test:a"], "artifacts": [],
                   "task": {"title": "Synthetic"}}
        adapter = assembly_worker.RunnerAssemblyAdapter(runtime, args, progress, checked, None, "/endpoint")
        adapter._module = mock.Mock(return_value=types.SimpleNamespace(full_command=lambda _profile: ["test"]))
        receipts = adapter.tests(Path("/worktree"), checked)
        self.assertEqual(receipts[0]["outcome"], "failed")
        runtime.sandbox.assert_not_called(); runtime.supervise.assert_not_called()

    def test_publication_refuses_a_dirty_post_verification_tree(self):
        runtime = types.SimpleNamespace(
            git=mock.Mock(return_value=" M package-lock.json"), push_and_open_pr=mock.Mock(),
            REPOSITORY="example/project", BASE_BRANCH="main")
        args = types.SimpleNamespace(graph_id=GRAPH, task_id="0946")
        checked = {"task": {"title": "Synthetic"}, "artifacts": []}
        adapter = assembly_worker.RunnerAssemblyAdapter(runtime, args, mock.Mock(), checked, None, "/endpoint")
        with self.assertRaisesRegex(assembly_worker.DistributedAssemblyError, "source changed"):
            adapter.publish(Path("/worktree"), checked, "publication-id")
        runtime.push_and_open_pr.assert_not_called()


if __name__ == "__main__":
    unittest.main()
