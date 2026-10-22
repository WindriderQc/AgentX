#!/usr/bin/env python3
"""Root-coordinator assembly of verified distributed code-step bundles."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import tempfile
import subprocess
from datetime import datetime, timezone

try:
    import coding_distributed_step as protocol
except ModuleNotFoundError:
    import importlib.util
    _SPEC = importlib.util.spec_from_file_location(
        "coding_distributed_step", Path(__file__).with_name("coding_distributed_step.py"))
    protocol = importlib.util.module_from_spec(_SPEC)
    assert _SPEC.loader is not None
    _SPEC.loader.exec_module(protocol)


class DistributedAssemblyError(RuntimeError):
    pass


def _atomic(path: Path, value: dict) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent,
                                     prefix=".distributed-assembly-", delete=False) as output:
        json.dump(value, output, sort_keys=True, separators=(",", ":"))
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
        temporary = Path(output.name)
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def _read(path: Path) -> dict | None:
    if not path.exists():
        return None
    if path.is_symlink() or path.stat().st_size > 256 * 1024:
        raise DistributedAssemblyError("assembly journal is invalid")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise DistributedAssemblyError("assembly journal is invalid")
    return value


def validate_manifest(value: object, *, task_id: str, request_id: str, graph_id: str,
                      executor_id: str, fingerprint: str) -> dict:
    if not isinstance(value, dict) or value.get("schema") not in protocol.SCHEMAS or value.get("role") != "assembly":
        raise DistributedAssemblyError("Core returned no supported assembly manifest")
    task = value.get("task") or {"pipelineId": value.get("pipelineId"), "title": value.get("title", "")}
    graph = value.get("graph") or {"graphId": value.get("graphId"), "sourceCommit": value.get("sourceCommit"),
                                   "planFingerprint": value.get("planFingerprint")}
    request = value.get("request") or {"requestId": value.get("requestId")}
    executor = value.get("executor") or {"executorId": value.get("executorId")}
    observed = (protocol._field(task, "pipelineId", "id"), protocol._field(request, "requestId", "id"),
                protocol._field(graph, "graphId", "id"), protocol._field(executor, "executorId", "id"),
                value.get("manifestFingerprint"))
    if observed != (task_id, request_id, graph_id, executor_id, fingerprint):
        raise DistributedAssemblyError("assembly manifest identity differs from the pinned root launch")
    base = protocol._field(graph, "sourceCommit", "baseCommit")
    artifacts = value.get("artifacts")
    if artifacts is None:
        ready = value.get("readyAdoption")
        if ready:
            artifact = ready.get("artifact") or {}
            artifacts = [{**ready, "parent": ready.get("parent") or ready.get("baseCommit"),
                "sha256": artifact.get("sha256"), "sizeBytes": artifact.get("sizeBytes"),
                "url": ready.get("downloadPath"), "allowedPaths": ready.get("allowedPaths"),
                "effectiveDependsOn": ready.get("effectiveDependsOn", [])}]
        else:
            artifacts = []
    targets = value.get("testTargets") or graph.get("testTargets")
    profile = value.get("verificationProfile") or request.get("verificationProfile")
    final_ready = value.get("finalReady") is True
    if not protocol.SHA1.fullmatch(str(base or "")) or not isinstance(artifacts, list) \
            or final_ready and (not isinstance(targets, list) or not targets or not isinstance(profile, str)):
        raise DistributedAssemblyError("assembly manifest lacks its exact artifacts, base, or final tests")
    seen = set()
    normalized = []
    for row in artifacts:
        if not isinstance(row, dict):
            raise DistributedAssemblyError("assembly artifact entry is invalid")
        step_id = protocol._field(row, "stepId", "id")
        if not protocol.STEP.fullmatch(str(step_id or "")) or step_id in seen:
            raise DistributedAssemblyError("assembly artifact step identity is invalid")
        seen.add(step_id)
        required = ("requestId", "commit", "parent", "sha256", "sizeBytes", "url", "allowedPaths")
        if any(name not in row for name in required) or not protocol.UUID.fullmatch(str(row["requestId"])) \
                or not protocol.SHA1.fullmatch(str(row["commit"])) or not protocol.SHA1.fullmatch(str(row["parent"])) \
                or not protocol.SHA256.fullmatch(str(row["sha256"])) or type(row["sizeBytes"]) is not int \
                or not isinstance(row["allowedPaths"], list):
            raise DistributedAssemblyError("assembly artifact receipt is incomplete")
        normalized.append({**row, "id": step_id, "artifactSha256": row["sha256"],
                           "artifactSize": row["sizeBytes"], "dependsOn": row.get("effectiveDependsOn", [])})
    return {**value, "task": task, "graph": graph, "request": request, "executor": executor,
            "baseCommit": base, "artifacts": normalized, "finalReady": final_ready,
            "testTargets": targets or [], "verificationProfile": profile}


class AssemblyWorker:
    """Deterministic root worker with explicit lost-publication reconciliation."""

    def __init__(self, adapter, journal_dir: str | os.PathLike[str]):
        self.adapter = adapter
        self.journal_dir = Path(journal_dir)

    def _replay_terminal(self, prior: dict) -> dict:
        self.adapter.complete(prior["completion"])
        return {**prior["completion"], "replayed": True}

    def execute(self, manifest: dict) -> dict:
        request_id = protocol._field(manifest["request"], "requestId", "id")
        path = self.journal_dir / f"{request_id}.distributed-assembly.json"
        prior = _read(path) or {"schemaVersion": 1, "state": "assembling",
            "identity": {"graphId": protocol._field(manifest["graph"], "graphId", "id"),
                         "requestId": request_id, "sourceCommit": manifest["baseCommit"],
                         "planFingerprint": manifest["graph"].get("planFingerprint") or manifest.get("planFingerprint")},
            "adoptions": [], "manifestFingerprints": {}}
        identity = {"graphId": protocol._field(manifest["graph"], "graphId", "id"),
                    "requestId": request_id, "sourceCommit": manifest["baseCommit"],
                    "planFingerprint": manifest["graph"].get("planFingerprint") or manifest.get("planFingerprint")}
        if prior.get("identity") != identity:
            raise DistributedAssemblyError("assembly journal belongs to another graph or plan")
        if prior and prior.get("state") == "terminal":
            return self._replay_terminal(prior)

        if prior.get("state") in {"failure_intent", "failed"}:
            failure = prior.get("failure")
            if not isinstance(failure, dict):
                raise DistributedAssemblyError("assembly failure journal is malformed")
            self.adapter.failure(failure)
            replayed = prior["state"] == "failed"
            if not replayed:
                prior = {**prior, "state": "failed"}
                _atomic(path, prior)
            return {"state": "failed", "failure": failure, "replayed": replayed}

        workspace = self.adapter.prepare(manifest)
        if prior and prior.get("state") == "publication_intent":
            publication = self.adapter.reconcile_publication(prior["publicationRequestId"], manifest)
            if not publication:
                raise DistributedAssemblyError("publication outcome is unknown; retain the original root request")
            completion = {**prior["completion"], "publication": publication}
            terminal = {**prior, "state": "terminal", "completion": completion}
            _atomic(path, terminal)
            return self._replay_terminal(terminal)

        entries = []
        for row in manifest["artifacts"]:
            artifact_path = self.adapter.download(row)
            entries.append({**row, "artifactPath": str(artifact_path)})
        if entries:
            adoptions = self.adapter.adopt(workspace, entries, manifest)
            conflict = next((item for item in adoptions if item.get("status") == "conflict"), None)
            if conflict:
                paths = conflict.get("conflictPaths") if isinstance(conflict.get("conflictPaths"), list) else []
                detail = ", ".join(str(item) for item in paths[:16]) or "recorded paths"
                failure = {"state": "failed", "code": "assembly_conflict",
                           "stepId": conflict.get("stepId"),
                           "reason": f"{conflict.get('stepId')} conflicts during deterministic adoption: {detail}"[:500],
                           "finishedAt": self.adapter.now()}
                intent = {**prior, "state": "failure_intent", "failure": failure,
                          "finalManifestFingerprint": manifest["manifestFingerprint"]}
                _atomic(path, intent)
                self.adapter.failure(failure)
                _atomic(path, {**intent, "state": "failed"})
                return {"state": "failed", "failure": failure, "replayed": False}
            if len(adoptions) != len(entries) or any(item.get("status") != "adopted" for item in adoptions):
                raise DistributedAssemblyError("assembly stopped before the ready step was adopted")
            for adoption in adoptions:
                self.adapter.adoption(adoption)
                existing = next((row for row in prior["adoptions"] if row["stepId"] == adoption["stepId"]), None)
                if existing and existing != adoption:
                    raise DistributedAssemblyError("an adopted step has a different replay receipt")
                if not existing:
                    prior["adoptions"].append(adoption)
                prior["manifestFingerprints"][adoption["stepId"]] = manifest["manifestFingerprint"]
            _atomic(path, prior)
            return {"state": "waiting", "adoptions": adoptions, "replayed": bool(existing)}
        if not manifest["finalReady"]:
            _atomic(path, prior)
            return {"state": "waiting", "adoptions": [], "replayed": False}
        tests = self.adapter.tests(workspace, manifest)
        if not tests or any(item.get("outcome") != "passed" for item in tests):
            raise DistributedAssemblyError("independent final verification did not pass")
        head = self.adapter.head(workspace)
        publication_id = f"{request_id}:publish"
        completion = {"headCommit": head, "tests": tests, "completedAt": self.adapter.now()}
        intent = {**prior, "state": "publication_intent", "finalManifestFingerprint": manifest["manifestFingerprint"],
                  "publicationRequestId": publication_id, "completion": completion}
        _atomic(path, intent)
        publication = self.adapter.publish(workspace, manifest, publication_id)
        if not isinstance(publication, dict):
            raise DistributedAssemblyError("publication did not return a durable receipt")
        completion = {**completion, "publication": publication}
        terminal = {**intent, "state": "terminal", "completion": completion}
        _atomic(path, terminal)
        self.adapter.complete(completion)
        return completion


class RunnerAssemblyAdapter:
    """Production adapter used only by the exact root coordinator manifest."""

    def __init__(self, runtime, args, progress, manifest, core, endpoint):
        self.r, self.args, self.progress = runtime, args, progress
        self.manifest, self.core, self.endpoint = manifest, core, endpoint
        self.by_step = {row["id"]: row for row in manifest["artifacts"]}

    def _module(self, name):
        import importlib.util
        spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def _repository(self):
        configured = os.environ.get("AGENTX_CODING_REPOSITORY_PATH", "").strip()
        if configured:
            return Path(configured).resolve(strict=True)
        mirror = self.r.WORKSPACES / ".distributed-repository.git"
        if not mirror.exists():
            self.r.WORKSPACES.mkdir(mode=0o700, parents=True, exist_ok=True)
            result = subprocess.run(["git", "clone", "--mirror", "--no-tags",
                f"https://github.com/{self.r.REPOSITORY}.git", str(mirror)], capture_output=True)
            if result.returncode:
                raise DistributedAssemblyError("assembly repository preparation failed")
        try:
            self.workspace_module.refresh_public_heads(mirror)
        except self.workspace_module.WorkspaceError as error:
            raise DistributedAssemblyError("assembly repository public-head refresh failed") from error
        return mirror

    def prepare(self, manifest):
        self.workspace_module = self._module("coding_step_workspace")
        self.assembly_module = self._module("coding_step_assembly")
        target = self.r.WORKSPACES / f"graph-{self.args.graph_id}" / "assembly"
        branch = f"agentx/code-graph/{self.args.graph_id[:24]}"
        if target.exists():
            if self.r.git(target, "branch", "--show-current") != branch \
                    or self.r.git(target, "status", "--porcelain", "--untracked-files=normal"):
                raise DistributedAssemblyError("existing assembly worktree cannot be reconciled")
            try:
                self.r.git(target, "merge-base", "--is-ancestor", manifest["baseCommit"], "HEAD")
            except subprocess.CalledProcessError as error:
                raise DistributedAssemblyError("assembly worktree does not descend from its exact base") from error
            return target
        self.workspace_module.prepare_worktree(self._repository(), target, manifest["baseCommit"], branch)
        return target

    def download(self, row):
        target = self.r.RECEIPTS / "code-step-artifacts" / f"{row['requestId']}.download.bundle"
        return self.core.download(row["url"], target)

    def adopt(self, workspace, entries, manifest):
        journal = self.r.RECEIPTS / "code-step-adoptions" / self.args.graph_id
        return self.assembly_module.Assembly(workspace, journal).adopt(entries)

    def adoption(self, receipt):
        source = self.by_step[receipt["stepId"]]
        body = {"stepId": receipt["stepId"], "sourceCommit": receipt["sourceCommit"],
                "parentCommit": receipt["previousHead"], "adoptedCommit": receipt["resultCommit"],
                "artifactSha256": source["sha256"], "adoptedAt": self.now()}
        return self.core.post(self.manifest.get("adoptionReceiptPath") or self.endpoint + "/adoptions", body)

    def tests(self, workspace, manifest):
        verification = self._module("coding_verification")
        started = __import__("time").monotonic()
        source_before = self.r.coding_progress.source_state(workspace)
        self.r.install_dependencies(workspace, self.progress)
        if self.r.coding_progress.source_state(workspace) != source_before:
            duration = max(0, int((__import__("time").monotonic() - started) * 1000))
            return [{"target": target, "profile": manifest["verificationProfile"],
                     "outcome": "failed", "durationMs": duration}
                    for target in manifest["testTargets"]]
        command = verification.full_command(manifest["verificationProfile"])
        result = self.r.supervise(self.r.sandbox(workspace, self.r.worker_home(workspace), command,
            network=False, timeout_seconds=max(1, self.args.timeout_seconds)), self.progress)
        duration = max(0, int((__import__("time").monotonic() - started) * 1000))
        passed = result.returncode == 0 and self.r.coding_progress.source_state(workspace) == source_before
        return [{"target": target, "profile": manifest["verificationProfile"],
                 "outcome": "passed" if passed else "failed", "durationMs": duration}
                for target in manifest["testTargets"]]

    def head(self, workspace):
        return self.r.git(workspace, "rev-parse", "HEAD")

    def publish(self, workspace, manifest, publication_id):
        if self.r.git(workspace, "status", "--porcelain", "--untracked-files=normal"):
            raise DistributedAssemblyError("assembly source changed after final verification")
        token = os.environ.get("GH_TOKEN", "").strip()
        if not token:
            raise DistributedAssemblyError("assembly publication requires the coding team's GitHub token")
        title = manifest["task"].get("title") or "Distributed coding task"
        summary = (f"Core code-step graph {self.args.graph_id}.\n\n"
                   f"Publication request: `{publication_id}`.\n"
                   "Every adopted step and final verification passed before publication.\n")
        url = self.r.push_and_open_pr(workspace,
            self.r.git(workspace, "branch", "--show-current"), self.args.task_id,
            title, summary, token, safe_body=True)
        match = re.fullmatch(r"https://github\.com/[^/]+/[^/]+/pull/([1-9][0-9]*)", url)
        if not match:
            raise DistributedAssemblyError("publication returned no canonical GitHub pull request URL")
        return {"requestId": publication_id, "state": "published", "url": url,
                "prNumber": int(match.group(1)), "headCommit": self.head(workspace)}

    def reconcile_publication(self, publication_id, manifest):
        # push_and_open_pr is keyed by the frozen branch and returns the existing
        # open PR without creating a second one; use that idempotent lookup path.
        workspace = self.r.WORKSPACES / f"graph-{self.args.graph_id}" / "assembly"
        return self.publish(workspace, manifest, publication_id)

    def complete(self, body):
        return self.core.post(self.manifest.get("finalReceiptPath") or self.endpoint + "/assembly", body)

    def failure(self, body):
        return self.core.post(self.manifest.get("failureReceiptPath")
                              or self.endpoint + "/code-step-assembly-failure", body)

    @staticmethod
    def now():
        return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def execute(runtime, args, progress, *, manifest=None, adapter=None) -> int:
    """Callable by the root coordinator; CLI assembly is only an exact-manifest seam."""
    endpoint = f"/api/pipeline/coding-autonomy/tasks/{args.task_id}/runs/{args.request_id}"
    core = protocol.HttpCore(runtime.CORE)
    raw = manifest if manifest is not None else core.manifest(endpoint + "/manifest")
    checked = validate_manifest(raw, task_id=args.task_id, request_id=args.request_id,
        graph_id=args.graph_id, executor_id=args.executor_id,
        fingerprint=args.manifest_fingerprint)
    factory = getattr(runtime, "distributed_assembly_adapter", RunnerAssemblyAdapter)
    active_adapter = adapter or factory(runtime, args, progress, checked, core, endpoint)
    result = AssemblyWorker(active_adapter, runtime.RECEIPTS).execute(checked)
    if result.get("state") in {"waiting", "failed"}:
        progress.set_stage("checkpoint")
        progress.write()
        return 0
    progress.checkpoint = result.get("headCommit")
    progress.finish("verified", checkpoint=progress.checkpoint)
    return 0
