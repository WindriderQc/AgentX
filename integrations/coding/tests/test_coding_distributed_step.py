import hashlib
import importlib.util
import json
from pathlib import Path
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


step_worker = load("coding_distributed_step")
workspace_tools = load("coding_step_workspace")
assembly_tools = load("coding_step_assembly")
REQUEST = "11111111-1111-4111-8111-111111111111"
FINGERPRINT = "a" * 64


def git(path, *args):
    return subprocess.run(["git", "-C", str(path), *args], check=True,
                          text=True, capture_output=True).stdout.strip()


class GitAdapter:
    def __init__(self, root, outside=False, fail_result_once=False, fail_upload_once=False):
        self.root = root
        self.repo = root / "repo"
        self.worktree = root / "worktree"
        self.artifact = root / "step.bundle"
        self.outside = outside
        self.fail_result_once = fail_result_once
        self.fail_upload_once = fail_upload_once
        self.harness_calls = self.test_calls = self.commit_calls = self.uploads = self.results = 0
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
        self.test_calls += 1
        return [{"target": target, "profile": manifest["verificationProfile"],
                 "outcome": "passed", "durationMs": 4} for target in manifest["testTargets"]]

    def commit(self, workspace, _manifest, changed):
        self.commit_calls += 1
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
        if self.fail_upload_once and self.uploads == 1:
            raise OSError("lost upload acknowledgement")
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


def manifest(base, *, source=None, base_adoptions=None, paths=None, step_id="step-01"):
    raw = {"schema": "agentx.pipeline-code-step-worker-manifest/v1", "role": "step",
           "pipelineId": "0946", "graphId": FINGERPRINT, "sourceCommit": source or base,
           "requestId": REQUEST, "baseCommit": base, "executorId": "alien-open",
           "budget": {"workSeconds": 600, "testSeconds": 120, "modelSeconds": 300, "modelCalls": 4},
           "verificationProfile": "agentx-dispatcher-tests/v1", "harness": "opencode",
           "model": "qwen3-coder:30b",
           "step": {"stepId": step_id, "title": "Change value", "objective": "change it",
                    "paths": paths or ["src/value.py"], "testTargets": ["integrations/coding/tests/test_x.py"]},
           "baseAdoptions": base_adoptions or [],
           "rootLeaseId": "root-lease-1", "manifestFingerprint": FINGERPRINT}
    return step_worker.validate_manifest(raw, task_id="0946", request_id=REQUEST,
        graph_id=FINGERPRINT, executor_id="alien-open", step_id=step_id, fingerprint=FINGERPRINT)


class DistributedStepTest(unittest.TestCase):
    def test_setup_exception_terminalizes_and_replays_without_a_model_call(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            adapter = GitAdapter(root)
            worker = step_worker.StepWorker(adapter, root / "journal")
            checked = manifest(adapter.base)
            with mock.patch.object(adapter, "prepare", side_effect=OSError("dependency service stopped")) as prepare:
                first = worker.execute(checked)
                replay = worker.execute(checked)
            journal = json.loads((root / "journal" / f"{REQUEST}.distributed-step.json").read_text())
            self.assertEqual((first["outcome"], first["receipt"]["code"]),
                             ("failed", "step_setup_failed"))
            self.assertTrue(replay["replayed"])
            self.assertEqual(journal["state"], "terminal")
            self.assertEqual((prepare.call_count, adapter.harness_calls, adapter.results), (1, 0, 2))
            self.assertEqual(first["actualUsage"]["modelCalls"], 0)

    def test_crash_after_model_boundary_settles_exact_request_without_model_replay(self):
        class SimulatedProcessLoss(BaseException):
            pass

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            adapter = GitAdapter(root)
            original_harness = adapter.harness

            def interrupted_harness(*args):
                original_harness(*args)
                raise SimulatedProcessLoss()

            adapter.harness = interrupted_harness
            worker = step_worker.StepWorker(adapter, root / "journal")
            checked = manifest(adapter.base)
            with self.assertRaises(SimulatedProcessLoss):
                worker.execute(checked)
            pending = json.loads((root / "journal" / f"{REQUEST}.distributed-step.json").read_text())
            self.assertEqual(pending["state"], "model_started")

            replay = worker.execute(checked)
            terminal = json.loads((root / "journal" / f"{REQUEST}.distributed-step.json").read_text())
            self.assertEqual((replay["outcome"], replay["receipt"]["code"]),
                             ("failed", "model_outcome_unknown"))
            self.assertTrue(replay["replayed"])
            self.assertEqual((adapter.harness_calls, adapter.results), (1, 1))
            self.assertEqual(terminal["state"], "terminal")
            self.assertEqual(replay["actualUsage"]["modelCalls"], checked["request"]["budget"]["modelCalls"])
            self.assertEqual(replay["actualUsage"]["modelSeconds"], checked["request"]["budget"]["modelSeconds"])

    def test_post_model_infrastructure_exception_is_terminal_and_not_replayed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            adapter = GitAdapter(root)
            worker = step_worker.StepWorker(adapter, root / "journal")
            checked = manifest(adapter.base)
            with mock.patch.object(adapter, "changed", side_effect=OSError("git unavailable")) as changed:
                first = worker.execute(checked)
                replay = worker.execute(checked)
            self.assertEqual((first["outcome"], first["receipt"]["code"]),
                             ("failed", "step_infrastructure_failed"))
            self.assertTrue(replay["replayed"])
            self.assertEqual((adapter.harness_calls, changed.call_count, adapter.results), (1, 1, 2))
            self.assertEqual(first["actualUsage"]["modelCalls"], checked["request"]["budget"]["modelCalls"])

    def test_terminal_intent_is_visible_before_a_lost_core_result_post(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            receipt_path = root / f"{REQUEST}.json"
            receipt_path.write_text(json.dumps({"requestId": REQUEST, "pipelineId": "0946"}))

            class Core:
                calls = 0

                @classmethod
                def post(cls, _endpoint, _body):
                    cls.calls += 1
                    if cls.calls == 1:
                        raise OSError("lost Core response")
                    return {"recorded": True}

            dispatch = types.SimpleNamespace(
                read_receipt=lambda _request_id: json.loads(receipt_path.read_text()),
                atomic_json=step_worker._atomic_json)
            runtime = types.SimpleNamespace(RECEIPTS=root, coding_dispatch_control=dispatch)
            args = types.SimpleNamespace(request_id=REQUEST, task_id="0946")
            progress = types.SimpleNamespace(started=0, soft_deadline=1000, core_recorded=False,
                                             checkpoint=None, finish=mock.Mock())
            checked = manifest("a" * 40)
            adapter = step_worker.RunnerStepAdapter(runtime, args, progress, checked, Core(), "/run")
            body = {"outcome": "failed", "actualUsage": {name: 0 for name in step_worker.BUDGET_KEYS},
                    "receipt": {"code": "model_outcome_unknown", "finishedAt": "2026-10-22T12:00:00.000Z"}}

            with self.assertRaisesRegex(OSError, "lost Core"):
                adapter.result(body)
            pending = json.loads(receipt_path.read_text())
            self.assertEqual(pending["codeStepResult"], body)
            self.assertFalse(pending["coreRecorded"])
            progress.finish.assert_called_once_with("blocked", "code_step_blocked", None)

            self.assertEqual(adapter.result(body), {"recorded": True})
            confirmed = json.loads(receipt_path.read_text())
            self.assertTrue(confirmed["coreRecorded"])
            self.assertTrue(progress.core_recorded)
            self.assertEqual(progress.finish.call_count, 2)

    def test_dependent_wave_reconstructs_exact_assembled_base_on_another_mirror(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            origin = root / "origin.git"
            subprocess.run(["git", "init", "--bare", "-q", str(origin)], check=True)
            source = root / "source"
            subprocess.run(["git", "clone", "-q", str(origin), str(source)], check=True)
            git(source, "config", "user.name", "Test")
            git(source, "config", "user.email", "test@example.invalid")
            (source / "src").mkdir()
            (source / "src/one.py").write_text("ONE = 1\n")
            (source / "src/two.py").write_text("TWO = 1\n")
            git(source, "add", ".")
            git(source, "commit", "-qm", "base")
            git(source, "push", "-q", "origin", "HEAD:main")
            base = git(source, "rev-parse", "HEAD")

            worker_one = root / "worker-one.git"
            root_mirror = root / "root.git"
            host_two_spaces = root / "host-two" / "spaces"
            host_two_spaces.mkdir(parents=True)
            worker_two = host_two_spaces / ".distributed-repository.git"
            for target in (worker_one, root_mirror, worker_two):
                subprocess.run(["git", "clone", "--mirror", "--no-tags", "-q",
                                str(origin), str(target)], check=True)

            first_worktree = root / "first-worktree"
            workspace_tools.prepare_worktree(worker_one, first_worktree, base, "step-one")
            (first_worktree / "src/one.py").write_text("ONE = 2\n")
            git(first_worktree, "add", "src/one.py")
            git(first_worktree, "-c", "user.name=Worker", "-c", "user.email=worker@example.invalid",
                "commit", "-qm", "step one")
            source_commit = git(first_worktree, "rev-parse", "HEAD")
            artifact = root / "step-one.bundle"
            exported = workspace_tools.export_commit(
                first_worktree, artifact, base, source_commit, ["src/one.py"])

            assembly_worktree = root / "assembly"
            workspace_tools.prepare_worktree(root_mirror, assembly_worktree, base, "assembly")
            adoption_request = "22222222-2222-4222-8222-222222222222"
            adoption = assembly_tools.Assembly(assembly_worktree, root / "assembly-journal").adopt_one({
                "id": "step-01", "requestId": adoption_request, "commit": source_commit,
                "parent": base, "artifactPath": str(artifact), "artifactSha256": exported["sha256"],
                "artifactSize": exported["size"], "allowedPaths": ["src/one.py"]})
            assembled = adoption["resultCommit"]
            self.assertNotEqual(assembled, source_commit)
            self.assertNotEqual(subprocess.run(
                ["git", "-C", str(worker_two), "cat-file", "-e", f"{assembled}^{{commit}}"],
                capture_output=True
            ).returncode, 0)

            (source / "public.py").write_text("PUBLIC = True\n")
            git(source, "add", "public.py")
            git(source, "commit", "-qm", "new public head")
            git(source, "push", "-q", "origin", "HEAD:main")
            public_head = git(source, "rev-parse", "HEAD")
            self.assertNotEqual(subprocess.run(
                ["git", "-C", str(worker_two), "cat-file", "-e", f"{public_head}^{{commit}}"],
                capture_output=True
            ).returncode, 0)

            row = {"stepId": "step-01", "requestId": adoption_request, "commit": source_commit,
                   "parent": base, "adoptedParent": base, "adoptedCommit": assembled,
                   "allowedPaths": ["src/one.py"],
                   "artifact": {"id": "artifact-step-one", "sha256": exported["sha256"],
                                "sizeBytes": exported["size"], "format": "git-bundle/v1"},
                   "downloadPath": "/artifacts/step-one"}
            checked = manifest(assembled, source=base, base_adoptions=[row],
                               paths=["src/two.py"], step_id="step-02")

            class Core:
                @staticmethod
                def download(_endpoint, destination):
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(artifact.read_bytes())
                    return destination

            runtime = types.SimpleNamespace(
                WORKSPACES=host_two_spaces, RECEIPTS=root / "host-two" / "receipts",
                REPOSITORY="unused/repository", git=git,
                install_dependencies=lambda _workspace, _progress: None,
                dependency_state=lambda _workspace: "installed")
            args = types.SimpleNamespace(graph_id=FINGERPRINT, step_id="step-02", request_id=REQUEST)
            progress = types.SimpleNamespace(started=10, soft_deadline=1000)
            prepared = step_worker.RunnerStepAdapter(
                runtime, args, progress, checked, Core(), "/run").prepare(checked)
            self.assertEqual(git(prepared, "rev-parse", "HEAD"), assembled)
            self.assertEqual(git(worker_two, "rev-parse", f"{public_head}^{{commit}}"), public_head)
            (prepared / "src/two.py").write_text("TWO = 2\n")
            git(prepared, "add", "src/two.py")
            git(prepared, "-c", "user.name=Worker", "-c", "user.email=worker@example.invalid",
                "commit", "-qm", "dependent step")
            self.assertEqual(git(prepared, "rev-parse", "HEAD^"), assembled)

    def test_production_adapter_applies_exact_budget_before_dependency_preparation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "source").mkdir()
            source = GitAdapter(root / "source")
            observed = []
            progress = types.SimpleNamespace(started=10, soft_deadline=1000)
            runtime = types.SimpleNamespace(WORKSPACES=root / "spaces", REPOSITORY="example/repo",
                install_dependencies=lambda _workspace, current: observed.append({
                    "limits": dict(current.cumulative_limits), "hard": current.hard_deadline,
                    "soft": current.soft_deadline, "noProgress": current.no_progress_limit}),
                dependency_state=lambda _workspace: "installed")
            args = types.SimpleNamespace(graph_id=FINGERPRINT, step_id="step-01", request_id=REQUEST)
            checked = manifest(source.base)
            with mock.patch.dict("os.environ", {"AGENTX_CODING_REPOSITORY_PATH": str(source.repo)}):
                step_worker.RunnerStepAdapter(runtime, args, progress, checked, None, "/run").prepare(checked)
            self.assertEqual(observed, [{"limits": checked["request"]["budget"], "hard": 610,
                "soft": 610, "noProgress": 600}])

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

    def test_lost_upload_ack_replays_artifact_intent_without_rerunning_work(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            adapter = GitAdapter(root, fail_upload_once=True)
            worker = step_worker.StepWorker(adapter, root / "journal")
            checked = manifest(adapter.base)
            with self.assertRaisesRegex(OSError, "lost upload acknowledgement"):
                worker.execute(checked)
            journal = json.loads((root / "journal" / f"{REQUEST}.distributed-step.json").read_text())
            self.assertEqual(journal["state"], "artifact_ready")
            self.assertEqual(journal["resultIntent"]["receipt"]["commit"],
                             git(adapter.worktree, "rev-parse", "HEAD"))
            replay = worker.execute(checked)
            self.assertEqual(replay["outcome"], "verified")
            self.assertTrue(replay["replayed"])
            self.assertEqual((adapter.harness_calls, adapter.test_calls, adapter.commit_calls), (1, 1, 1))
            self.assertEqual((adapter.uploads, adapter.results), (2, 1))


if __name__ == "__main__":
    unittest.main()
