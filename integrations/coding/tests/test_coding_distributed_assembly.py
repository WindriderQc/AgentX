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
        self.final_outcome, self.publication_failure = "passed", None
        self.reconciliations = 0
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
                 "outcome": self.final_outcome, "durationMs": 1501} for target in manifest["testTargets"]]

    def validate_publication(self, _workspace, _manifest, tests):
        if self.publication_failure:
            raise assembly_worker.DeterministicAssemblyFailure(
                "assembly_publication_failed", self.publication_failure, tests)

    def head(self, workspace):
        return git(workspace, "rev-parse", "HEAD")

    def publish(self, _workspace, _manifest, publication_id):
        self.publications += 1
        return {"requestId": publication_id, "state": "published", "url": "https://example.invalid/pr/1",
                "prNumber": 1, "headCommit": self.head(self.worktree)}

    def reconcile_publication(self, *_args):
        self.reconciliations += 1
        return None

    def complete(self, _body):
        self.completions += 1

    def failure(self, body):
        self.failures.append(body)

    @staticmethod
    def now():
        return "2026-10-22T12:00:00.000Z"


def manifest(adapter, ready=None, final=False, final_budget=None):
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
           "finalVerificationBudget": (final_budget or {"workSeconds": 30, "testSeconds": 30}) if final else None,
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

    def test_failed_final_verification_posts_and_replays_one_terminal_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            adapter = AssemblyAdapter(Path(directory))
            adapter.final_outcome = "failed"
            worker = assembly_worker.AssemblyWorker(adapter, Path(directory) / "journal")
            failed = worker.execute(manifest(adapter, final=True))
            replay = worker.execute(manifest(adapter, final=True))
            self.assertEqual(failed["failure"]["code"], "assembly_verification_failed")
            self.assertEqual(failed["failure"]["tests"][0]["durationMs"], 1501)
            self.assertTrue(replay["replayed"])
            self.assertEqual(adapter.publications, 0)
            self.assertEqual(adapter.failures[0], adapter.failures[1])

    def test_passing_tests_that_exhaust_the_exact_budget_terminalize_before_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            adapter = AssemblyAdapter(Path(directory))
            worker = assembly_worker.AssemblyWorker(adapter, Path(directory) / "journal")
            result = worker.execute(manifest(adapter, final=True,
                final_budget={"workSeconds": 1, "testSeconds": 1}))
            self.assertEqual(result["failure"]["state"], "blocked")
            self.assertEqual(result["failure"]["code"], "assembly_budget_exhausted")
            self.assertEqual(result["failure"]["tests"][0]["durationMs"], 1501)
            self.assertEqual(adapter.publications, 0)

    def test_lost_failure_ack_replays_the_exact_durable_terminal_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            adapter = AssemblyAdapter(Path(directory))
            adapter.final_outcome = "failed"
            posted = []
            def lose_first_ack(body):
                posted.append(body)
                if len(posted) == 1:
                    raise OSError("terminal receipt response lost")
            adapter.failure = lose_first_ack
            worker = assembly_worker.AssemblyWorker(adapter, Path(directory) / "journal")
            with self.assertRaises(OSError):
                worker.execute(manifest(adapter, final=True))
            replay = worker.execute(manifest(adapter, final=True))
            self.assertTrue(replay["replayed"])
            self.assertEqual(posted[0], posted[1])
            self.assertEqual(adapter.publications, 0)

    def test_publication_preflight_transport_error_stays_uncertain(self):
        with tempfile.TemporaryDirectory() as directory:
            adapter = AssemblyAdapter(Path(directory))
            adapter.validate_publication = mock.Mock(side_effect=OSError("GitHub unavailable"))
            worker = assembly_worker.AssemblyWorker(adapter, Path(directory) / "journal")
            with self.assertRaisesRegex(OSError, "GitHub unavailable"):
                worker.execute(manifest(adapter, final=True))
            self.assertEqual(adapter.failures, [])
            self.assertEqual(adapter.publications, 0)

    def test_deterministic_publication_preflight_failure_terminalizes_after_passing_tests(self):
        with tempfile.TemporaryDirectory() as directory:
            adapter = AssemblyAdapter(Path(directory))
            adapter.publication_failure = "GitHub publication is locally unavailable"
            result = assembly_worker.AssemblyWorker(adapter, Path(directory) / "journal").execute(
                manifest(adapter, final=True))
            self.assertEqual(result["failure"]["code"], "assembly_publication_failed")
            self.assertEqual(result["failure"]["tests"][0]["outcome"], "passed")
            self.assertEqual(adapter.publications, 0)

    def test_sent_publication_with_lost_reply_only_resumes_read_only_reconciliation(self):
        with tempfile.TemporaryDirectory() as directory:
            adapter = AssemblyAdapter(Path(directory))
            def lose_reply(*_args):
                adapter.publications += 1
                raise OSError("publication response lost")
            adapter.publish = lose_reply
            worker = assembly_worker.AssemblyWorker(adapter, Path(directory) / "journal")
            with self.assertRaises(assembly_worker.PublicationOutcomeUnknown):
                worker.execute(manifest(adapter, final=True))
            with self.assertRaises(assembly_worker.PublicationOutcomeUnknown):
                worker.execute(manifest(adapter, final=True))
            self.assertEqual(adapter.publications, 1)
            self.assertEqual(adapter.reconciliations, 1)
            self.assertEqual(adapter.failures, [])

    def test_final_dependency_install_cannot_change_the_tree_that_will_be_published(self):
        runtime = types.SimpleNamespace(
            coding_progress=types.SimpleNamespace(source_state=mock.Mock(side_effect=["before", "changed"])),
            install_dependencies=mock.Mock(), sandbox=mock.Mock(), supervise=mock.Mock(),
            worker_home=mock.Mock(), git=mock.Mock(), push_and_open_pr=mock.Mock(),
            RECEIPTS=Path("/tmp"), WORKSPACES=Path("/tmp"), REPOSITORY="example/project",
            BASE_BRANCH="main")
        progress = mock.Mock()
        args = types.SimpleNamespace(graph_id=GRAPH, task_id="0946", timeout_seconds=30)
        checked = {"verificationProfile": "agentx-dispatcher-tests/v1", "testTargets": ["test:a"],
                   "finalVerificationBudget": {"workSeconds": 30, "testSeconds": 30}, "artifacts": [],
                   "task": {"title": "Synthetic"}}
        adapter = assembly_worker.RunnerAssemblyAdapter(runtime, args, progress, checked, None, "/endpoint")
        adapter._module = mock.Mock(return_value=types.SimpleNamespace(full_command=lambda _profile: ["test"]))
        with self.assertRaises(assembly_worker.DeterministicAssemblyFailure) as raised:
            adapter.tests(Path("/worktree"), checked)
        self.assertEqual(raised.exception.code, "assembly_source_changed")
        self.assertEqual(raised.exception.tests[0]["outcome"], "failed")
        runtime.sandbox.assert_not_called(); runtime.supervise.assert_not_called()

    def test_final_dependency_install_uses_the_aggregate_deadline_and_terminalizes_exhaustion(self):
        class DeadlineExceeded(RuntimeError):
            pass
        observed = []
        def install(_workspace, _progress, *, deadline):
            observed.append(deadline)
            raise DeadlineExceeded("fixture deadline")
        runtime = types.SimpleNamespace(
            CodingDeadlineExceeded=DeadlineExceeded,
            coding_progress=types.SimpleNamespace(source_state=mock.Mock(return_value="before")),
            install_dependencies=mock.Mock(side_effect=install), sandbox=mock.Mock(), supervise=mock.Mock(),
            worker_home=mock.Mock(), git=mock.Mock(), push_and_open_pr=mock.Mock(),
            RECEIPTS=Path("/tmp"), WORKSPACES=Path("/tmp"), REPOSITORY="example/project",
            BASE_BRANCH="main")
        progress = mock.Mock()
        args = types.SimpleNamespace(graph_id=GRAPH, task_id="0946", timeout_seconds=5)
        checked = {"verificationProfile": "agentx-dispatcher-tests/v1", "testTargets": ["test:a"],
                   "finalVerificationBudget": {"workSeconds": 5, "testSeconds": 8}, "artifacts": [],
                   "task": {"title": "Synthetic"}}
        adapter = assembly_worker.RunnerAssemblyAdapter(runtime, args, progress, checked, None, "/endpoint")
        adapter._module = mock.Mock(return_value=types.SimpleNamespace(full_command=lambda _profile: ["test"]))
        with mock.patch.object(assembly_worker.time, "monotonic", side_effect=[100.0, 100.25]), \
                self.assertRaises(assembly_worker.DeterministicAssemblyFailure) as raised:
            adapter.tests(Path("/worktree"), checked)
        self.assertEqual(observed, [104.0])
        self.assertEqual(raised.exception.code, "assembly_budget_exhausted")
        self.assertEqual(raised.exception.state, "blocked")
        self.assertEqual(raised.exception.tests[0]["durationMs"], 250)
        runtime.sandbox.assert_not_called(); runtime.supervise.assert_not_called()

    def test_dependency_time_is_removed_from_the_final_command_timeout(self):
        runtime = types.SimpleNamespace(
            coding_progress=types.SimpleNamespace(source_state=mock.Mock(return_value="same")),
            install_dependencies=mock.Mock(), sandbox=mock.Mock(return_value=["sandboxed-test"]),
            supervise=mock.Mock(return_value=subprocess.CompletedProcess([], 0)), worker_home=mock.Mock(),
            git=mock.Mock(), push_and_open_pr=mock.Mock(), RECEIPTS=Path("/tmp"), WORKSPACES=Path("/tmp"),
            REPOSITORY="example/project", BASE_BRANCH="main")
        args = types.SimpleNamespace(graph_id=GRAPH, task_id="0946", timeout_seconds=5)
        checked = {"verificationProfile": "agentx-dispatcher-tests/v1", "testTargets": ["test:a"],
                   "finalVerificationBudget": {"workSeconds": 5, "testSeconds": 8}, "artifacts": [],
                   "task": {"title": "Synthetic"}}
        adapter = assembly_worker.RunnerAssemblyAdapter(runtime, args, mock.Mock(), checked, None, "/endpoint")
        adapter._module = mock.Mock(return_value=types.SimpleNamespace(full_command=lambda _profile: ["test"]))
        with mock.patch.object(assembly_worker.time, "monotonic",
                               side_effect=[100.0, 101.0, 101.2, 103.0]):
            tests = adapter.tests(Path("/worktree"), checked)
        self.assertEqual(tests[0]["durationMs"], 3000)
        self.assertEqual(runtime.install_dependencies.call_args.kwargs, {"deadline": 104.0})
        self.assertEqual(runtime.sandbox.call_args.kwargs["timeout_seconds"], 2)
        self.assertEqual(runtime.supervise.call_args.kwargs, {"deadline": 104.0})

    def test_publication_refuses_a_dirty_post_verification_tree(self):
        runtime = types.SimpleNamespace(
            git=mock.Mock(return_value=" M package-lock.json"), push_and_open_pr=mock.Mock(),
            REPOSITORY="example/project", BASE_BRANCH="main")
        args = types.SimpleNamespace(graph_id=GRAPH, task_id="0946")
        checked = {"task": {"title": "Synthetic"}, "artifacts": []}
        adapter = assembly_worker.RunnerAssemblyAdapter(runtime, args, mock.Mock(), checked, None, "/endpoint")
        checked.update(verificationProfile="agentx-dispatcher-tests/v1", testTargets=["test:a"])
        with self.assertRaises(assembly_worker.DeterministicAssemblyFailure) as raised:
            adapter.validate_publication(Path("/worktree"), checked,
                [{"target": "test:a", "profile": "agentx-dispatcher-tests/v1",
                  "outcome": "passed", "durationMs": 10}])
        self.assertEqual(raised.exception.code, "assembly_source_changed")
        runtime.push_and_open_pr.assert_not_called()


if __name__ == "__main__":
    unittest.main()
