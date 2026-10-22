#!/usr/bin/env python3
"""Deterministic, journaled adoption of completed code-step commits."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from typing import Callable, Iterable


try:
    import coding_step_workspace as workspace
except ModuleNotFoundError:  # Direct importlib loading in the standalone CPU tests.
    _SPEC = importlib.util.spec_from_file_location(
        "coding_step_workspace", Path(__file__).with_name("coding_step_workspace.py"))
    workspace = importlib.util.module_from_spec(_SPEC)
    assert _SPEC.loader is not None
    _SPEC.loader.exec_module(workspace)


IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$")


class AssemblyError(RuntimeError):
    """The assembly plan or local assembly worktree is invalid."""


class AdoptionUncertain(AssemblyError):
    """The worktree changed, but the intended adoption cannot be proved."""


class AdoptionConflict(AssemblyError):
    """Raised by ``adopt_one(..., raise_conflict=True)`` with its receipt."""

    def __init__(self, receipt: dict):
        super().__init__(f"code step {receipt['stepId']} conflicts: "
                         f"{', '.join(receipt['conflictPaths'])}")
        self.receipt = receipt


def _identifier(value: object, label: str) -> str:
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise AssemblyError(f"{label} must be a bounded identifier")
    return value


def ordered_steps(entries: Iterable[dict]) -> list[dict]:
    """Return a stable topological order, choosing the lowest ready id."""
    rows = list(entries)
    by_id: dict[str, dict] = {}
    dependencies: dict[str, set[str]] = {}
    for row in rows:
        if not isinstance(row, dict):
            raise AssemblyError("each code step must be an object")
        step_id = _identifier(row.get("id"), "step id")
        if step_id in by_id:
            raise AssemblyError(f"duplicate code step id: {step_id}")
        raw_dependencies = row.get("dependsOn", [])
        if not isinstance(raw_dependencies, list):
            raise AssemblyError(f"dependsOn for {step_id} must be a list")
        deps = [_identifier(item, f"dependency of {step_id}") for item in raw_dependencies]
        if len(set(deps)) != len(deps) or step_id in deps:
            raise AssemblyError(f"invalid dependencies for {step_id}")
        by_id[step_id] = row
        dependencies[step_id] = set(deps)
    missing = sorted({dep for deps in dependencies.values() for dep in deps if dep not in by_id})
    if missing:
        raise AssemblyError(f"unknown dependencies: {', '.join(missing)}")
    ordered: list[dict] = []
    completed: set[str] = set()
    while len(ordered) != len(rows):
        ready = sorted(step_id for step_id, deps in dependencies.items()
                       if step_id not in completed and deps <= completed)
        if not ready:
            blocked = sorted(set(by_id) - completed)
            raise AssemblyError(f"dependency cycle among: {', '.join(blocked)}")
        step_id = ready[0]
        ordered.append(by_id[step_id])
        completed.add(step_id)
    return ordered


def _environment(extra: dict[str, str] | None = None) -> dict[str, str]:
    result = os.environ.copy()
    result.update({"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
                   "GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C"})
    if extra:
        result.update(extra)
    return result


def _command(worktree: Path, *args: str, input_bytes: bytes | None = None,
             extra_env: dict[str, str] | None = None, check: bool = True) -> subprocess.CompletedProcess:
    result = subprocess.run(
        ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
         "-C", str(worktree), *args], input=input_bytes, capture_output=True,
        env=_environment(extra_env))
    if check and result.returncode:
        detail = result.stderr.decode("utf-8", "replace").strip()
        raise AssemblyError(f"Git command failed ({' '.join(args)}): {detail}")
    return result


def _head(worktree: Path) -> str:
    return _command(worktree, "rev-parse", "--verify", "HEAD").stdout.decode().strip()


def _atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n"
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                     prefix=".adoption-", delete=False) as output:
        output.write(encoded)
        output.flush()
        os.fsync(output.fileno())
        temporary = Path(output.name)
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def _read_json(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        if path.lstat().st_size > 64 * 1024 or path.is_symlink():
            raise AssemblyError("adoption journal entry is unsafe")
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise AssemblyError("adoption journal entry is unreadable") from error
    if not isinstance(value, dict):
        raise AssemblyError("adoption journal entry must be an object")
    return value


def _canonical_identity(entry: dict) -> dict:
    required = ("id", "requestId", "commit", "parent", "artifactPath",
                "artifactSha256", "artifactSize", "allowedPaths")
    if any(name not in entry for name in required):
        missing = [name for name in required if name not in entry]
        raise AssemblyError(f"code step is missing: {', '.join(missing)}")
    step_id = _identifier(entry["id"], "step id")
    request_id = _identifier(entry["requestId"], "request id")
    if not workspace.SHA1.fullmatch(str(entry["commit"])) \
            or not workspace.SHA1.fullmatch(str(entry["parent"])):
        raise AssemblyError("commit and parent must be full lowercase SHA-1 ids")
    if not isinstance(entry["artifactSha256"], str) \
            or not re.fullmatch(r"[0-9a-f]{64}", entry["artifactSha256"]):
        raise AssemblyError("artifactSha256 is invalid")
    if type(entry["artifactSize"]) is not int or entry["artifactSize"] <= 0:
        raise AssemblyError("artifactSize is invalid")
    # commit_paths performs the canonical scope validation after import.  Keep
    # the literal claim here so a replay cannot silently change its identity.
    if not isinstance(entry["allowedPaths"], list) or not entry["allowedPaths"]:
        raise AssemblyError("allowedPaths must be a non-empty list")
    return {"stepId": step_id, "requestId": request_id,
            "sourceCommit": entry["commit"], "sourceParent": entry["parent"],
            "artifactPath": str(Path(entry["artifactPath"]).absolute()),
            "artifactSha256": entry["artifactSha256"],
            "artifactSize": entry["artifactSize"],
            "allowedPaths": list(entry["allowedPaths"])}


def _patch_id(worktree: Path, parent: str, commit: str) -> str:
    diff = _command(worktree, "diff", "--binary", "--full-index", parent, commit).stdout
    result = _command(worktree, "patch-id", "--stable", input_bytes=diff).stdout.decode().split()
    if len(result) < 1 or not re.fullmatch(r"[0-9a-f]{40}", result[0]):
        raise AdoptionUncertain("adoption patch identity is unavailable")
    return result[0]


class Assembly:
    """Adopt verified step bundles into one clean local assembly worktree."""

    def __init__(self, worktree: str | os.PathLike[str], journal_dir: str | os.PathLike[str],
                 *, after_commit: Callable[[dict], None] | None = None):
        self.worktree = Path(worktree).resolve(strict=True)
        self.journal_dir = Path(journal_dir).absolute()
        self.after_commit = after_commit
        _head(self.worktree)

    def _journal_path(self, request_id: str) -> Path:
        return self.journal_dir / f"{request_id}.json"

    @staticmethod
    def _same_identity(record: dict, identity: dict) -> bool:
        return record.get("identity") == identity

    def _terminal(self, record: dict, identity: dict, *, raise_conflict: bool) -> dict:
        if not self._same_identity(record, identity):
            raise AdoptionUncertain("request id was already used for a different adoption")
        receipt = record.get("receipt")
        if record.get("state") not in {"adopted", "conflict"} or not isinstance(receipt, dict):
            raise AdoptionUncertain("adoption journal terminal state is malformed")
        if record["state"] == "conflict" and raise_conflict:
            raise AdoptionConflict(receipt)
        return receipt

    def _reconcile_prepared(self, record: dict, identity: dict) -> dict | None:
        if not self._same_identity(record, identity):
            raise AdoptionUncertain("request id was already prepared for a different adoption")
        expected = record.get("expectedHead")
        current = _head(self.worktree)
        if current == expected:
            return None
        parents = _command(self.worktree, "rev-list", "--parents", "-n", "1", current).stdout.decode().split()
        message = _command(self.worktree, "show", "-s", "--format=%B", current).stdout.decode()
        marker = f"AgentX-Adoption: {identity['requestId']}"
        if parents != [current, expected] or marker not in message.splitlines():
            raise AdoptionUncertain("assembly HEAD moved beyond the prepared adoption")
        if _patch_id(self.worktree, expected, current) != record.get("sourcePatchId"):
            raise AdoptionUncertain("assembly HEAD does not contain the prepared source patch")
        receipt = {"schemaVersion": 1, "status": "adopted", "stepId": identity["stepId"],
                   "requestId": identity["requestId"], "sourceCommit": identity["sourceCommit"],
                   "previousHead": expected, "resultCommit": current, "reconciled": True}
        _atomic_json(self._journal_path(identity["requestId"]),
                     {"schemaVersion": 1, "state": "adopted", "identity": identity,
                      "expectedHead": expected, "sourcePatchId": record["sourcePatchId"],
                      "receipt": receipt})
        return receipt

    def _conflict(self, record: dict, identity: dict, result: subprocess.CompletedProcess,
                  *, raise_conflict: bool) -> dict:
        raw = _command(self.worktree, "diff", "--name-only", "--diff-filter=U", "-z").stdout
        paths = sorted(item.decode("utf-8") for item in raw.split(b"\0") if item)
        abort = _command(self.worktree, "cherry-pick", "--abort", check=False)
        # `cherry-pick --no-commit` does not create sequencer state on every Git
        # version.  Reset only this dedicated assembly worktree to its journaled
        # pre-adoption HEAD when there is consequently nothing to abort.
        if abort.returncode:
            reset = _command(self.worktree, "reset", "--merge", record["expectedHead"], check=False)
            if reset.returncode:
                raise AdoptionUncertain("conflicting cherry-pick could not be restored cleanly")
        if _head(self.worktree) != record["expectedHead"] \
                or _command(self.worktree, "status", "--porcelain=v1", "-z").stdout:
            raise AdoptionUncertain("conflicting cherry-pick could not be restored cleanly")
        if not paths:
            detail = result.stderr.decode("utf-8", "replace").strip()
            raise AdoptionUncertain(f"cherry-pick failed without conflict evidence: {detail}")
        fingerprint_input = {"identity": identity, "expectedHead": record["expectedHead"],
                             "conflictPaths": paths}
        fingerprint = hashlib.sha256(json.dumps(
            fingerprint_input, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        receipt = {"schemaVersion": 1, "status": "conflict", "stepId": identity["stepId"],
                   "requestId": identity["requestId"], "sourceCommit": identity["sourceCommit"],
                   "expectedHead": record["expectedHead"], "conflictPaths": paths,
                   "conflictFingerprint": fingerprint}
        _atomic_json(self._journal_path(identity["requestId"]),
                     {"schemaVersion": 1, "state": "conflict", "identity": identity,
                      "expectedHead": record["expectedHead"],
                      "sourcePatchId": record["sourcePatchId"], "receipt": receipt})
        if raise_conflict:
            raise AdoptionConflict(receipt)
        return receipt

    def adopt_one(self, entry: dict, *, raise_conflict: bool = False) -> dict:
        identity = _canonical_identity(entry)
        path = self._journal_path(identity["requestId"])
        record = _read_json(path)
        if record and record.get("state") in {"adopted", "conflict"}:
            return self._terminal(record, identity, raise_conflict=raise_conflict)

        workspace.import_bundle(
            self.worktree, identity["artifactPath"],
            expected_sha256=identity["artifactSha256"], expected_size=identity["artifactSize"],
            expected_parent=identity["sourceParent"], commit=identity["sourceCommit"],
            allowed_paths=identity["allowedPaths"])
        source_patch = _patch_id(self.worktree, identity["sourceParent"], identity["sourceCommit"])
        if record:
            reconciled = self._reconcile_prepared(record, identity)
            if reconciled:
                return reconciled
        else:
            if _command(self.worktree, "status", "--porcelain=v1", "-z").stdout:
                raise AssemblyError("assembly worktree must be clean before adoption")
            record = {"schemaVersion": 1, "state": "prepared", "identity": identity,
                      "expectedHead": _head(self.worktree), "sourcePatchId": source_patch}
            _atomic_json(path, record)

        result = _command(self.worktree, "cherry-pick", "--no-commit", identity["sourceCommit"], check=False)
        if result.returncode:
            return self._conflict(record, identity, result, raise_conflict=raise_conflict)
        staged_raw = _command(self.worktree, "diff", "--cached", "--name-only", "-z").stdout
        staged = tuple(sorted(item.decode("utf-8") for item in staged_raw.split(b"\0") if item))
        if not staged:
            raise AdoptionUncertain("source commit became empty during adoption")
        try:
            workspace._verify_scope(staged, workspace._canonical_scope(identity["allowedPaths"]))
        except workspace.WorkspaceError as error:
            raise AdoptionUncertain(str(error)) from error
        author = _command(self.worktree, "show", "-s", "--format=%an%x00%ae%x00%aI",
                          identity["sourceCommit"]).stdout.decode().rstrip("\n").split("\0")
        if len(author) != 3:
            raise AdoptionUncertain("source author identity is unavailable")
        message = (f"Adopt code step {identity['stepId']}\n\n"
                   f"AgentX-Source: {identity['sourceCommit']}\n"
                   f"AgentX-Adoption: {identity['requestId']}")
        commit_env = {"GIT_AUTHOR_NAME": author[0], "GIT_AUTHOR_EMAIL": author[1],
                      "GIT_AUTHOR_DATE": author[2], "GIT_COMMITTER_NAME": "AgentX Code Assembly",
                      "GIT_COMMITTER_EMAIL": "agentx-code-assembly@localhost",
                      "GIT_COMMITTER_DATE": author[2]}
        _command(self.worktree, "commit", "--no-gpg-sign", "-m", message, extra_env=commit_env)
        result_commit = _head(self.worktree)
        if _patch_id(self.worktree, record["expectedHead"], result_commit) != source_patch:
            raise AdoptionUncertain("committed adoption does not match the source patch")
        if self.after_commit:
            self.after_commit({"stepId": identity["stepId"], "requestId": identity["requestId"],
                               "resultCommit": result_commit})
        receipt = {"schemaVersion": 1, "status": "adopted", "stepId": identity["stepId"],
                   "requestId": identity["requestId"], "sourceCommit": identity["sourceCommit"],
                   "previousHead": record["expectedHead"], "resultCommit": result_commit,
                   "reconciled": False}
        _atomic_json(path, {"schemaVersion": 1, "state": "adopted", "identity": identity,
                            "expectedHead": record["expectedHead"], "sourcePatchId": source_patch,
                            "receipt": receipt})
        return receipt

    def adopt(self, entries: Iterable[dict], *, raise_conflict: bool = False) -> list[dict]:
        """Adopt in stable DAG order and stop at the first deterministic conflict."""
        receipts = []
        for entry in ordered_steps(entries):
            receipt = self.adopt_one(entry, raise_conflict=raise_conflict)
            receipts.append(receipt)
            if receipt["status"] == "conflict":
                break
        return receipts
