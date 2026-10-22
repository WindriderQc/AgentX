#!/usr/bin/env python3
"""Execute one Core-authorized code DAG step on a pinned executor.

The worker owns only an isolated worktree and one immutable Git bundle.  Core
owns the graph, attempt identity and settlement.  The small adapter boundary is
intentional: CPU tests can exercise the complete protocol without a model or a
network, while ``coding_run.py`` supplies the installed harness at runtime.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from urllib.request import Request, urlopen


UUID = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")
SHA1 = re.compile(r"^[a-f0-9]{40}$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
STEP = re.compile(r"^step-(?:0[1-9]|1[0-6])$")
SCHEMAS = {"agentx.pipeline-code-step-worker-manifest/v1", "agentx.pipeline-code-step-manifest/v1"}


class DistributedStepError(RuntimeError):
    pass


class DeterministicStepFailure(DistributedStepError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def add_arguments(parser):
    parser.add_argument("--distributed-role", choices=("step", "assembly"), default=None)
    parser.add_argument("--graph-id", default=None)
    parser.add_argument("--executor-id", default=None)
    parser.add_argument("--step-id", default=None)
    parser.add_argument("--manifest-fingerprint", default=None)


def validate_arguments(parser, args):
    identity = (args.graph_id, args.executor_id, args.manifest_fingerprint)
    if args.distributed_role:
        if args.autonomous or args.report_name or not args.request_id or not all(identity):
            parser.error("distributed execution needs its exact request, graph, executor, and manifest")
        if args.distributed_role == "step" and not args.step_id:
            parser.error("a distributed step needs its exact step id")
        if args.distributed_role == "assembly" and args.step_id:
            parser.error("the root assembly manifest does not accept a step id")
    elif any((*identity, args.step_id)):
        parser.error("distributed identity fields require --distributed-role")


def failed(args, error, progress):
    if not args.distributed_role:
        return None
    progress.write()
    print(f"distributed {args.distributed_role} request requires reconciliation: "
          f"{type(error).__name__}", file=__import__("sys").stderr)
    return 2


def execute_role(runtime, args, progress):
    if args.distributed_role == "step":
        return execute(runtime, args, progress)
    if args.distributed_role == "assembly":
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "coding_distributed_assembly", Path(__file__).with_name("coding_distributed_assembly.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.execute(runtime, args, progress)
    return None


def _atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent,
                                     prefix=".distributed-step-", delete=False) as output:
        json.dump(value, output, sort_keys=True, separators=(",", ":"))
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
        temporary = Path(output.name)
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def _read_json(path: Path) -> dict | None:
    if not path.exists():
        return None
    if path.is_symlink() or path.stat().st_size > 128 * 1024:
        raise DistributedStepError("distributed step journal is invalid")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise DistributedStepError("distributed step journal is invalid")
    return value


def _field(container: dict, *names):
    for name in names:
        if name in container:
            return container[name]
    return None


def _base_adoptions(value: object, *, source_commit: str, base_commit: str) -> list[dict]:
    if not isinstance(value, list):
        raise DistributedStepError("step manifest has no exact base adoption chain")
    expected_head = source_commit
    seen = set()
    normalized = []
    for row in value:
        if not isinstance(row, dict):
            raise DistributedStepError("step base adoption is invalid")
        artifact = row.get("artifact")
        step_id = row.get("stepId")
        required = ("requestId", "commit", "parent", "adoptedParent", "adoptedCommit",
                    "allowedPaths", "downloadPath")
        if not STEP.fullmatch(str(step_id or "")) or step_id in seen \
                or any(name not in row for name in required) or not isinstance(artifact, dict) \
                or not UUID.fullmatch(str(row["requestId"])) \
                or not SHA1.fullmatch(str(row["commit"])) or not SHA1.fullmatch(str(row["parent"])) \
                or not SHA1.fullmatch(str(row["adoptedParent"])) \
                or not SHA1.fullmatch(str(row["adoptedCommit"])) \
                or row["adoptedParent"] != expected_head \
                or not isinstance(row["allowedPaths"], list) or not row["allowedPaths"] \
                or not isinstance(row["downloadPath"], str) or not row["downloadPath"] \
                or not isinstance(artifact.get("id"), str) or not artifact["id"] \
                or not SHA256.fullmatch(str(artifact.get("sha256", ""))) \
                or type(artifact.get("sizeBytes")) is not int or artifact["sizeBytes"] <= 0 \
                or artifact.get("format") != "git-bundle/v1":
            raise DistributedStepError("step base adoption receipt is incomplete or discontinuous")
        seen.add(step_id)
        normalized.append({**row, "id": step_id, "artifactSha256": artifact["sha256"],
                           "artifactSize": artifact["sizeBytes"]})
        expected_head = row["adoptedCommit"]
    if expected_head != base_commit:
        raise DistributedStepError("step base adoption chain does not produce its exact base")
    return normalized


def validate_manifest(value: object, *, task_id: str, request_id: str, graph_id: str,
                      executor_id: str, step_id: str, fingerprint: str) -> dict:
    if not isinstance(value, dict) or value.get("schema") not in SCHEMAS or value.get("role") != "step":
        raise DistributedStepError("Core returned no supported step manifest")
    task = value.get("task") or {"pipelineId": value.get("pipelineId")}
    graph = value.get("graph") or {"graphId": value.get("graphId"), "sourceCommit": value.get("sourceCommit")}
    request = value.get("request") or {"requestId": value.get("requestId"), "baseCommit": value.get("baseCommit"),
                                       "budget": value.get("budget"), "model": value.get("model")}
    executor = value.get("executor") or {"executorId": value.get("executorId"),
                                          "model": value.get("model"), "harness": value.get("harness")}
    step = value.get("step")
    if not all(isinstance(item, dict) for item in (task, graph, request, executor, step)):
        raise DistributedStepError("step manifest is incomplete")
    observed = (_field(task, "pipelineId", "id"), _field(request, "requestId", "id"),
                _field(graph, "graphId", "id"), _field(executor, "executorId", "id"),
                _field(step, "stepId", "id"), value.get("manifestFingerprint"))
    expected = (task_id, request_id, graph_id, executor_id, step_id, fingerprint)
    if observed != expected:
        raise DistributedStepError("step manifest identity differs from the pinned launch")
    base = _field(request, "baseCommit") or _field(step, "baseCommit") or _field(graph, "baseCommit", "sourceCommit")
    source = _field(graph, "sourceCommit") or value.get("sourceCommit")
    paths = _field(step, "paths", "allowedPaths")
    targets = step.get("testTargets")
    profile = _field(request, "verificationProfile") or value.get("verificationProfile")
    model = _field(executor, "model") or _field(request, "model") or value.get("model")
    root_lease = value.get("rootLeaseId")
    budget = request.get("budget") or value.get("budget")
    if not SHA1.fullmatch(str(base or "")) or not SHA1.fullmatch(str(source or "")) \
            or not isinstance(paths, list) or not paths \
            or not isinstance(targets, list) or not targets or not isinstance(profile, str) or not profile \
            or not isinstance(model, str) or model in {"", "auto", "agentx-primary"} \
            or not isinstance(root_lease, str) or not root_lease or not isinstance(budget, dict) \
            or set(budget) != {"workSeconds", "testSeconds", "modelSeconds", "modelCalls"} \
            or any(type(budget[name]) is not int or budget[name] <= 0 for name in budget):
        raise DistributedStepError("step manifest has no exact base, scope, tests, model, lease, or positive budget")
    base_adoptions = _base_adoptions(value.get("baseAdoptions"), source_commit=source, base_commit=base)
    executor["model"] = model
    if not UUID.fullmatch(request_id) or not STEP.fullmatch(step_id) or not SHA256.fullmatch(fingerprint):
        raise DistributedStepError("pinned step launch identity is invalid")
    return {**value, "task": task, "graph": graph, "request": request, "executor": executor,
            "sourceCommit": source, "baseCommit": base, "baseAdoptions": base_adoptions,
            "allowedPaths": paths, "testTargets": targets,
            "verificationProfile": profile}


def step_prompt(manifest: dict) -> str:
    step = manifest["step"]
    return (
        "Implement only this independently testable code step. Read AGENTS.md first. "
        "Do not commit or push; the runner owns verification and the single commit.\n\n"
        f"Step: {_field(step, 'stepId', 'id')} — {step.get('title', '')}\n"
        f"Objective: {step.get('objective', '')}\n"
        f"Exact writable paths: {json.dumps(manifest['allowedPaths'])}\n"
        f"Runner-owned focused tests: {json.dumps(manifest['testTargets'])}\n"
    )


class HttpCore:
    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")

    def _call(self, endpoint: str, *, method="GET", body=None, content_type="application/json"):
        data = body
        if isinstance(body, dict):
            data = json.dumps(body).encode()
        headers = {"Accept": "application/json", "x-service-caller": "coding-run"}
        if data is not None:
            headers["Content-Type"] = content_type
        with urlopen(Request(self.base_url + endpoint, data=data, headers=headers, method=method), timeout=30) as response:
            payload = json.load(response)
        return payload.get("data", payload)

    def manifest(self, endpoint):
        return self._call(endpoint)

    def upload(self, endpoint, path: Path):
        return self._call(endpoint, method="PUT", body=path.read_bytes(), content_type="application/octet-stream")

    def post(self, endpoint, body):
        return self._call(endpoint, method="POST", body=body)

    def download(self, endpoint: str, destination: Path, maximum=8 * 1024 * 1024):
        """Download one bounded immutable artifact without following mutable workspace state."""
        url = endpoint if endpoint.startswith(("http://", "https://")) else self.base_url + endpoint
        with urlopen(Request(url, headers={"Accept": "application/octet-stream",
                                          "x-service-caller": "coding-run"}), timeout=30) as response:
            data = response.read(maximum + 1)
        if not data or len(data) > maximum:
            raise DistributedStepError("code-step artifact download is empty or exceeds its bound")
        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        destination.write_bytes(data)
        os.chmod(destination, 0o600)
        return destination


class StepWorker:
    """Protocol driver; ``adapter`` provides local Git, harness and test operations."""

    def __init__(self, adapter, journal_dir: str | os.PathLike[str]):
        self.adapter = adapter
        self.journal_dir = Path(journal_dir)

    def _publish_artifact(self, path: Path, record: dict, *, replayed: bool) -> dict:
        artifact_path = Path(record.get("artifactPath", ""))
        export = record.get("export")
        intent = record.get("resultIntent")
        if not isinstance(export, dict) or not isinstance(intent, dict) \
                or intent.get("outcome") != "verified" or not artifact_path.is_file():
            raise DistributedStepError("artifact-ready step journal is malformed")
        uploaded = self.adapter.upload(artifact_path)
        artifact = {"id": uploaded["id"], "sha256": uploaded["sha256"],
            "sizeBytes": uploaded.get("sizeBytes", uploaded.get("size")),
            "format": uploaded.get("format", "git-bundle/v1")}
        if artifact["sha256"] != export.get("sha256") or artifact["sizeBytes"] != export.get("size"):
            result = {"outcome": "failed", "actualUsage": intent["actualUsage"],
                      "receipt": {"code": "artifact_receipt_mismatch",
                                  "finishedAt": intent["receipt"]["finishedAt"]}}
        else:
            result = {**intent, "receipt": {**intent["receipt"], "artifact": artifact}}
        terminal = {"schemaVersion": 1, "state": "terminal",
                    "manifestFingerprint": record["manifestFingerprint"],
                    "artifactPath": str(artifact_path), "result": result}
        _atomic_json(path, terminal)
        self.adapter.result(result)
        return {**result, **({"replayed": True} if replayed else {})}

    def execute(self, manifest: dict) -> dict:
        request_id = _field(manifest["request"], "requestId", "id")
        path = self.journal_dir / f"{request_id}.distributed-step.json"
        prior = _read_json(path)
        if prior:
            if prior.get("manifestFingerprint") != manifest["manifestFingerprint"]:
                raise DistributedStepError("request journal belongs to another manifest")
            if prior.get("state") == "terminal":
                self.adapter.result(prior["result"])
                return {**prior["result"], "replayed": True}
            if prior.get("state") == "artifact_ready":
                return self._publish_artifact(path, prior, replayed=True)
            raise DistributedStepError("step has an unresolved non-terminal journal")
        started = time.monotonic()
        _atomic_json(path, {"schemaVersion": 1, "state": "running",
                            "manifestFingerprint": manifest["manifestFingerprint"]})
        try:
            workspace = self.adapter.prepare(manifest)
            run = self.adapter.harness(workspace, step_prompt(manifest), manifest)
            if getattr(run, "returncode", 0) != 0:
                raise DeterministicStepFailure("harness_failed", "coding harness did not complete the step")
            changed = sorted(self.adapter.changed(workspace, manifest["baseCommit"]))
            allowed = manifest["allowedPaths"]
            outside = [name for name in changed if not any(name == root or name.startswith(root + "/") for root in allowed)]
            if not changed:
                raise DeterministicStepFailure("no_changes", "coding harness produced no source change")
            if outside:
                raise DeterministicStepFailure("step_scope_changed", "coding harness exceeded the exact step scope")
            tests = self.adapter.tests(workspace, manifest)
            if not tests or any(item.get("outcome") != "passed" for item in tests):
                raise DeterministicStepFailure("focused_tests_failed", "runner-owned focused verification did not pass")
            commit = self.adapter.commit(workspace, manifest, changed)
            if not SHA1.fullmatch(commit) or self.adapter.parent(workspace, commit) != manifest["baseCommit"]:
                raise DeterministicStepFailure("commit_shape_invalid", "step result is not exactly one commit above its base")
            artifact_path, export = self.adapter.export(workspace, manifest, commit)
            intent = {"outcome": "verified", "actualUsage": self.adapter.usage(started), "receipt": {
                "commit": commit, "changedPaths": changed, "tests": tests,
                "finishedAt": self.adapter.now()}}
            ready = {"schemaVersion": 1, "state": "artifact_ready",
                     "manifestFingerprint": manifest["manifestFingerprint"],
                     "artifactPath": str(artifact_path), "export": export, "resultIntent": intent}
            _atomic_json(path, ready)
            return self._publish_artifact(path, ready, replayed=False)
        except DeterministicStepFailure as failure:
            result = {"outcome": "failed", "actualUsage": self.adapter.usage(started),
                      "receipt": {"code": failure.code, "finishedAt": self.adapter.now()}}
            artifact_path = None
        terminal = {"schemaVersion": 1, "state": "terminal",
                    "manifestFingerprint": manifest["manifestFingerprint"], "result": result}
        if artifact_path is not None:
            terminal["artifactPath"] = str(artifact_path)
        _atomic_json(path, terminal)
        self.adapter.result(result)
        return result


class RunnerStepAdapter:
    """Production adapter over coding_run's already installed primitives."""

    def __init__(self, runtime, args, progress, manifest, core, endpoint):
        self.r, self.args, self.progress = runtime, args, progress
        self.manifest, self.core, self.endpoint = manifest, core, endpoint
        self.test_seconds = 0
        budget = manifest["request"]["budget"]
        self.progress.cumulative_limits = dict(budget)
        self.progress.hard_deadline = self.progress.started + budget["workSeconds"]
        self.progress.soft_deadline = min(self.progress.soft_deadline, self.progress.hard_deadline)
        self.progress.no_progress_limit = budget["workSeconds"]

    def _repository(self) -> Path:
        configured = os.environ.get("AGENTX_CODING_REPOSITORY_PATH", "").strip()
        if configured:
            return Path(configured).resolve(strict=True)
        mirror = self.r.WORKSPACES / ".distributed-repository.git"
        if not mirror.exists():
            self.r.WORKSPACES.mkdir(mode=0o700, parents=True, exist_ok=True)
            result = subprocess.run(["git", "clone", "--mirror", "--no-tags",
                f"https://github.com/{self.r.REPOSITORY}.git", str(mirror)], capture_output=True)
            if result.returncode:
                raise DistributedStepError("distributed repository preparation failed")
        try:
            self.workspace_module.refresh_public_heads(mirror)
        except self.workspace_module.WorkspaceError as error:
            raise DistributedStepError("distributed repository public-head refresh failed") from error
        return mirror

    def _module(self, name):
        spec = __import__("importlib.util").util.spec_from_file_location(
            name, Path(__file__).with_name(name + ".py"))
        module = __import__("importlib.util").util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def prepare(self, manifest):
        self.workspace_module = self._module("coding_step_workspace")
        target = self.r.WORKSPACES / f"graph-{self.args.graph_id}" / f"{self.args.step_id}-{self.args.request_id}"
        branch = f"agentx/code-step/{self.args.graph_id[:12]}/{self.args.step_id}/{self.args.request_id[:8]}"
        self.workspace_module.prepare_worktree(self._repository(), target, manifest["sourceCommit"], branch)
        if manifest["baseAdoptions"]:
            assembly = self._module("coding_step_assembly").Assembly(
                target, self.r.RECEIPTS / "code-step-bases" / self.args.request_id)
            for row in manifest["baseAdoptions"]:
                artifact = self.r.RECEIPTS / "code-step-artifacts" / f"{row['requestId']}.base.bundle"
                self.core.download(row["downloadPath"], artifact)
                receipt = assembly.adopt_one({"id": row["id"], "requestId": row["requestId"],
                    "commit": row["commit"], "parent": row["parent"], "artifactPath": str(artifact),
                    "artifactSha256": row["artifactSha256"], "artifactSize": row["artifactSize"],
                    "allowedPaths": row["allowedPaths"]})
                if receipt.get("status") != "adopted" \
                        or receipt.get("previousHead") != row["adoptedParent"] \
                        or receipt.get("resultCommit") != row["adoptedCommit"]:
                    raise DistributedStepError("base adoption did not reconstruct its exact recorded commit")
        prepared_head = self.workspace_module._git(target, "rev-parse", "--verify", "HEAD").decode().strip()
        if prepared_head != manifest["baseCommit"]:
            raise DistributedStepError("prepared step worktree does not match its exact base commit")
        self.r.install_dependencies(target, self.progress)
        self.installed_dependencies = self.r.dependency_state(target)
        return target

    def harness(self, workspace, prompt, manifest):
        executor = manifest["executor"]
        model = executor.get("model") or manifest["request"].get("model") or self.r.MODEL
        self.progress.phase = "running"
        budget = manifest["request"]["budget"]
        self.progress.relay_headers = {
            "x-agentx-coding-task": self.args.task_id,
            "x-agentx-code-graph": self.args.graph_id,
            "x-agentx-code-step": self.args.step_id,
            "x-agentx-code-step-request": self.args.request_id,
            "x-agentx-code-step-executor": self.args.executor_id,
            "x-agentx-coding-lease": manifest.get("rootLeaseId", ""),
        }
        self.progress.begin_step(budget["modelCalls"], budget["modelSeconds"],
                                 f"code-step:{self.args.step_id}", result_kind="source")
        try:
            return self.r.run_worker(workspace, prompt,
                max(1, min(self.args.timeout_seconds, budget["workSeconds"])), self.progress, model=model)
        finally:
            self.progress.end_step()

    def changed(self, workspace, base):
        if self.r.dependency_state(workspace) != self.installed_dependencies:
            raise DeterministicStepFailure("dependencies_changed",
                                           "code step changed dependencies that were not installed for this attempt")
        tracked = self.r.git(workspace, "diff", "--name-only", base, "--").splitlines()
        untracked = self.r.git(workspace, "ls-files", "--others", "--exclude-standard").splitlines()
        return sorted(set(filter(None, [*tracked, *untracked])))

    def tests(self, workspace, manifest):
        spec = __import__("importlib.util").util.spec_from_file_location(
            "coding_verification", Path(__file__).with_name("coding_verification.py"))
        verification = __import__("importlib.util").util.module_from_spec(spec)
        spec.loader.exec_module(verification)
        command = verification.focused_command(workspace, manifest["verificationProfile"], manifest["testTargets"])
        before = self.r.coding_progress.source_state(workspace)
        started = time.monotonic()
        result = self.r.supervise(self.r.sandbox(workspace, self.r.worker_home(workspace), command,
            network=False, timeout_seconds=max(1, int(self.progress.test_remaining()))), self.progress)
        duration = max(0, int((time.monotonic() - started) * 1000))
        self.test_seconds += (duration + 999) // 1000
        if result.returncode or self.r.coding_progress.source_state(workspace) != before:
            return [{"target": target, "profile": manifest["verificationProfile"],
                     "outcome": "failed", "durationMs": duration} for target in manifest["testTargets"]]
        return [{"target": target, "profile": manifest["verificationProfile"],
                 "outcome": "passed", "durationMs": duration} for target in manifest["testTargets"]]

    def commit(self, workspace, manifest, changed):
        self.r.git(workspace, "add", "-A", "--", *changed)
        self.r.git(workspace, *self.r.AUTHOR, "commit", "--quiet", "--no-verify", "-m",
                   f"Implement {self.args.step_id}: {manifest['step'].get('title', 'code step')}")
        if self.r.git(workspace, "status", "--porcelain", "--untracked-files=normal"):
            raise DistributedStepError("step worktree is not clean after its runner-owned commit")
        commit = self.r.git(workspace, "rev-parse", "HEAD")
        self.progress.checkpoint = commit
        self.progress.write()
        return commit

    def parent(self, workspace, commit):
        return self.r.git(workspace, "rev-parse", f"{commit}^")

    def export(self, workspace, manifest, commit):
        artifact = self.r.RECEIPTS / "code-step-artifacts" / f"{self.args.request_id}.bundle"
        receipt = self.workspace_module.export_commit(workspace, artifact, manifest["baseCommit"],
                                                       commit, manifest["allowedPaths"])
        return artifact, receipt

    def upload(self, path):
        return self.core.upload(self.manifest.get("artifactUploadPath") or self.endpoint + "/artifact", path)

    def result(self, body):
        response = self.core.post(self.manifest.get("terminalResultPath") or self.endpoint + "/result", body)
        run = self.r.coding_dispatch_control.read_receipt(self.args.request_id)
        if not isinstance(run, dict) or run.get("requestId") != self.args.request_id \
                or run.get("pipelineId") != self.args.task_id:
            raise DistributedStepError("host launch receipt changed before terminal result recording")
        run.update(codeStepResult=body, coreRecorded=True)
        self.r.coding_dispatch_control.atomic_json(self.r.RECEIPTS / f"{self.args.request_id}.json", run)
        self.progress.core_recorded = True
        return response

    def usage(self, started):
        observed = self.progress.usage() if hasattr(self.progress, "usage") else {}
        work = max(0, int(time.monotonic() - started))
        budget = self.manifest["request"]["budget"]
        measured = {"workSeconds": min(work, int(observed.get("workSeconds", work))),
                    "testSeconds": self.test_seconds,
                    "modelSeconds": max(0, int(observed.get("modelSeconds", 0))),
                    "modelCalls": max(0, int(observed.get("modelCalls", 0)))}
        return {name: min(measured[name], budget[name]) for name in measured}

    @staticmethod
    def now():
        return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def execute(runtime, args, progress) -> int:
    """Runtime entry used by coding_run; all network calls retain the run URL."""
    endpoint = f"/api/pipeline/coding-autonomy/tasks/{args.task_id}/runs/{args.request_id}"
    core = HttpCore(runtime.CORE)
    raw = core.manifest(endpoint + "/manifest")
    manifest = validate_manifest(raw, task_id=args.task_id, request_id=args.request_id,
        graph_id=args.graph_id, executor_id=args.executor_id, step_id=args.step_id,
        fingerprint=args.manifest_fingerprint)
    factory = getattr(runtime, "distributed_step_adapter", RunnerStepAdapter)
    adapter = factory(runtime, args, progress, manifest, core, endpoint)
    result = StepWorker(adapter, runtime.RECEIPTS).execute(manifest)
    reason = None if result["outcome"] == "verified" else "code_step_blocked"
    progress.finish("local_only" if result["outcome"] == "verified" else "blocked", reason,
                    getattr(progress, "checkpoint", None))
    return 0
