"""Private durable ledger for runner-owned autonomous code steps.

The ledger is the validated plan plus runner observations. Models receive a
bounded projection but never write this file. Each mutation is revision-checked,
locked against concurrent local writers and atomically replaced on disk.
"""
from __future__ import annotations

from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import tempfile

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("coding_code_steps", HERE / "coding_code_steps.py")
coding_code_steps = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(coding_code_steps)
PLAN_SCHEMA = coding_code_steps.PLAN_SCHEMA
repository_path = coding_code_steps.repository_path


LEDGER_SCHEMA = "agentx.coding-code-ledger/v1"
SUMMARY_SCHEMA = "agentx.code-step-summary/v1"
STATES = ("pending", "running", "verified", "failed", "blocked")
MAX_ATTEMPTS = 3
_SOURCE_OID = re.compile(r"[0-9a-f]{40}(?:[0-9a-f]{24})?")
_COMMIT_OID = re.compile(r"[0-9a-f]{40}")
_PROFILE_ID = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9._:/-]{0,119})")


class CodeLedgerError(ValueError):
    """Ledger content or a requested state transition is invalid."""


class LedgerConflict(CodeLedgerError):
    """Another writer changed the ledger revision."""


def _now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _text(value, label, limit=2_000):
    if not isinstance(value, str) or not value.strip():
        raise CodeLedgerError(f"{label} must be a nonempty string")
    value = value.strip()
    if len(value) > limit:
        raise CodeLedgerError(f"{label} exceeds {limit} characters")
    return value


def _oid(value, label="commit", pattern=_COMMIT_OID):
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise CodeLedgerError(f"{label} must be a complete lowercase Git object id")
    return value


def _canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def plan_fingerprint(plan):
    return hashlib.sha256(_canonical_json(plan).encode()).hexdigest()


def _validate_plan_shape(plan):
    if not isinstance(plan, dict) or set(plan) != {"schema", "summary", "steps"} or plan.get("schema") != PLAN_SCHEMA:
        raise CodeLedgerError("ledger plan does not match the validated plan schema")
    _text(plan.get("summary"), "plan summary")
    steps = plan.get("steps")
    if not isinstance(steps, list) or not 1 <= len(steps) <= 16:
        raise CodeLedgerError("ledger plan needs one to sixteen steps")
    prior = set()
    for index, step in enumerate(steps, 1):
        expected = f"step-{index:02d}"
        fields = {"id", "title", "objective", "paths", "testTargets", "dependsOn"}
        if not isinstance(step, dict) or set(step) != fields or step.get("id") != expected:
            raise CodeLedgerError(f"ledger plan step {index} is not canonical")
        _text(step.get("title"), f"{expected} title", 160)
        _text(step.get("objective"), f"{expected} objective")
        paths = step.get("paths")
        targets = step.get("testTargets")
        dependencies = step.get("dependsOn")
        if not isinstance(paths, list) or not paths or len(paths) > 8 or len(set(paths)) != len(paths):
            raise CodeLedgerError(f"{expected} has invalid paths")
        if not isinstance(targets, list) or not targets or len(targets) > 6 or len(set(targets)) != len(targets):
            raise CodeLedgerError(f"{expected} has invalid focused test targets")
        for value in paths + targets:
            try:
                repository_path(value)
            except ValueError as error:
                raise CodeLedgerError(str(error)) from error
        if (not isinstance(dependencies, list) or len(set(dependencies)) != len(dependencies)
                or any(dependency not in prior for dependency in dependencies)):
            raise CodeLedgerError(f"{expected} dependencies are not ordered")
        prior.add(expected)
    authorized = sorted({path for step in steps for path in step["paths"]})
    capability = {"agent": {"recommendedStepContext": 65_536}}
    try:
        canonical = coding_code_steps.validate_plan(plan, authorized, capability)
    except ValueError as error:
        raise CodeLedgerError(str(error)) from error
    if canonical != plan:
        raise CodeLedgerError("ledger plan is not canonical")


def new_ledger(task_id, source_commit, plan, *, created_at=None, max_attempts=MAX_ATTEMPTS):
    """Create the in-memory ledger from one already validated canonical plan."""
    _validate_plan_shape(plan)
    task_id = _text(task_id, "task id", 200)
    source_commit = _oid(source_commit, "source commit", _SOURCE_OID)
    if type(max_attempts) is not int or not 1 <= max_attempts <= 5:
        raise CodeLedgerError("maxAttempts must be an integer from one to five")
    timestamp = created_at or _now()
    rows = []
    for step in plan["steps"]:
        rows.append({**deepcopy(step), "state": "pending", "attempts": 0, "commit": None,
                     "changedPaths": [], "verification": [], "failure": None, "history": []})
    ledger = {
        "schema": LEDGER_SCHEMA,
        "taskId": task_id,
        "sourceCommit": source_commit,
        "planFingerprint": plan_fingerprint(plan),
        "planSummary": plan["summary"],
        "maxAttempts": max_attempts,
        "revision": 0,
        "createdAt": timestamp,
        "updatedAt": timestamp,
        "steps": rows,
    }
    validate_ledger(ledger)
    return ledger


def _validate_verification(value, step, *, completed):
    if not isinstance(value, list) or (completed and not value):
        raise CodeLedgerError(f"{step['id']} verification must be a nonempty list when verified")
    seen = set()
    covered = set()
    for index, receipt in enumerate(value, 1):
        fields = {"profile", "targets", "outcome", "exitCode", "durationMs"}
        if not isinstance(receipt, dict) or set(receipt) != fields:
            raise CodeLedgerError(f"{step['id']} verification receipt {index} has invalid fields")
        profile = receipt.get("profile")
        if not isinstance(profile, str) or not _PROFILE_ID.fullmatch(profile):
            raise CodeLedgerError("verification profile must be a bounded identifier")
        targets = receipt.get("targets")
        if not isinstance(targets, list) or not targets or len(set(targets)) != len(targets):
            raise CodeLedgerError("verification targets must be a nonempty distinct list")
        if any(target not in step["testTargets"] for target in targets):
            raise CodeLedgerError("verification exceeds the planned focused test targets")
        key = (profile, tuple(targets))
        if key in seen:
            raise CodeLedgerError("verification receipts must be distinct")
        seen.add(key)
        covered.update(targets)
        outcome = receipt.get("outcome")
        exit_code = receipt.get("exitCode")
        duration = receipt.get("durationMs")
        if (outcome not in ("passed", "failed") or type(exit_code) is not int or type(duration) is not int
                or not 0 <= duration <= 604_800_000):
            raise CodeLedgerError("verification outcome, exitCode, and durationMs are invalid")
        if (outcome == "passed") != (exit_code == 0):
            raise CodeLedgerError("verification outcome must agree with its exit code")
        if completed and outcome != "passed":
            raise CodeLedgerError("a verified step cannot contain a failed test")
    if completed and covered != set(step["testTargets"]):
        raise CodeLedgerError("verification must cover every planned focused test target")


def _validate_failure(value):
    if not isinstance(value, dict) or set(value) != {"reason", "at"}:
        raise CodeLedgerError("a failed or blocked step needs its runner reason")
    _text(value.get("reason"), "failure reason", 1_000)
    _text(value.get("at"), "failure time", 80)


def _validate_history(step, max_attempts):
    history = step.get("history")
    if not isinstance(history, list) or len(history) > max_attempts:
        raise CodeLedgerError(f"{step['id']} has invalid attempt history")
    for number, entry in enumerate(history, 1):
        fields = {"attempt", "state", "commit", "changedPaths", "verification", "failure"}
        if not isinstance(entry, dict) or set(entry) != fields or entry.get("attempt") != number:
            raise CodeLedgerError(f"{step['id']} attempt history is not append-only")
        if entry.get("state") not in {"failed", "verified"}:
            raise CodeLedgerError(f"{step['id']} attempt history state is invalid")
        _validate_verification(entry.get("verification"), step, completed=entry["state"] == "verified")
        if entry["state"] == "verified":
            _oid(entry.get("commit"))
            changed = entry.get("changedPaths")
            if not isinstance(changed, list) or not changed or any(path not in step["paths"] for path in changed):
                raise CodeLedgerError(f"{step['id']} verified attempt history exceeds its scope")
            if entry.get("failure") is not None:
                raise CodeLedgerError("verified attempt history cannot retain a failure")
        else:
            if entry.get("commit") is not None or entry.get("changedPaths") != []:
                raise CodeLedgerError("failed attempt history cannot retain a commit")
            _validate_failure(entry.get("failure"))


def validate_ledger(ledger):
    """Validate complete durable state and return it for convenient composition."""
    fields = {"schema", "taskId", "sourceCommit", "planFingerprint", "planSummary", "maxAttempts",
              "revision", "createdAt", "updatedAt", "steps"}
    if not isinstance(ledger, dict) or set(ledger) != fields or ledger.get("schema") != LEDGER_SCHEMA:
        raise CodeLedgerError("invalid code-step ledger schema or fields")
    _text(ledger.get("taskId"), "task id", 200)
    _oid(ledger.get("sourceCommit"), "source commit", _SOURCE_OID)
    if not re.fullmatch(r"[0-9a-f]{64}", ledger.get("planFingerprint", "")):
        raise CodeLedgerError("invalid plan fingerprint")
    _text(ledger.get("planSummary"), "plan summary")
    if type(ledger.get("maxAttempts")) is not int or not 1 <= ledger["maxAttempts"] <= 5:
        raise CodeLedgerError("invalid maxAttempts")
    if type(ledger.get("revision")) is not int or ledger["revision"] < 0:
        raise CodeLedgerError("invalid ledger revision")
    _text(ledger.get("createdAt"), "createdAt", 80)
    _text(ledger.get("updatedAt"), "updatedAt", 80)
    steps = ledger.get("steps")
    if not isinstance(steps, list) or not 1 <= len(steps) <= 16:
        raise CodeLedgerError("ledger needs one to sixteen steps")
    ids = []
    commits = set()
    running = 0
    plan_steps = []
    for index, step in enumerate(steps, 1):
        plan_fields = {"id", "title", "objective", "paths", "testTargets", "dependsOn"}
        runtime_fields = {"state", "attempts", "commit", "changedPaths", "verification", "failure", "history"}
        if not isinstance(step, dict) or set(step) != plan_fields | runtime_fields:
            raise CodeLedgerError(f"ledger step {index} has invalid fields")
        plan_steps.append({key: deepcopy(step[key]) for key in plan_fields})
        step_id = step.get("id")
        if step_id != f"step-{index:02d}":
            raise CodeLedgerError(f"ledger step {index} is out of order")
        ids.append(step_id)
        state = step.get("state")
        if state not in STATES:
            raise CodeLedgerError(f"{step_id} has an invalid state")
        running += state == "running"
        attempts = step.get("attempts")
        if type(attempts) is not int or not 0 <= attempts <= ledger["maxAttempts"]:
            raise CodeLedgerError(f"{step_id} has invalid attempts")
        _validate_history(step, ledger["maxAttempts"])
        expected_history = attempts - 1 if state == "running" else attempts
        if state == "pending":
            expected_history = 0
        if len(step["history"]) != expected_history:
            raise CodeLedgerError(f"{step_id} attempt history does not match its state")
        commit = step.get("commit")
        changed = step.get("changedPaths")
        if not isinstance(changed, list) or len(set(changed)) != len(changed) or any(path not in step["paths"] for path in changed):
            raise CodeLedgerError(f"{step_id} changedPaths exceed its scope")
        completed = state == "verified"
        if completed:
            commit = _oid(commit)
            if commit in commits or not changed:
                raise CodeLedgerError("each verified step needs one unique commit and changed path")
            commits.add(commit)
        elif commit is not None or changed:
            raise CodeLedgerError("only a verified step may retain a commit or changed paths")
        _validate_verification(step.get("verification"), step, completed=completed)
        if completed and step.get("failure") is not None:
            raise CodeLedgerError("a verified step cannot retain a failure")
        if state in ("failed", "blocked"):
            failure = step.get("failure")
            _validate_failure(failure)
        elif step.get("failure") is not None:
            raise CodeLedgerError("pending, running, and verified steps cannot retain a failure")
        if state in ("running", "verified", "failed") and attempts < 1:
            raise CodeLedgerError(f"{step_id} state requires an attempt")
    if running > 1:
        raise CodeLedgerError("only one code step may be running")
    plan = {"schema": PLAN_SCHEMA, "summary": ledger["planSummary"], "steps": plan_steps}
    _validate_plan_shape(plan)
    if plan_fingerprint(plan) != ledger["planFingerprint"]:
        raise CodeLedgerError("ledger plan fingerprint does not match its steps")
    return ledger


def _step(ledger, step_id):
    for step in ledger["steps"]:
        if step["id"] == step_id:
            return step
    raise CodeLedgerError(f"unknown code step {step_id!r}")


def next_step(ledger):
    """Return the first runnable unfinished step, without changing state."""
    validate_ledger(ledger)
    states = {step["id"]: step["state"] for step in ledger["steps"]}
    for step in ledger["steps"]:
        if step["state"] in ("pending", "failed") and step["attempts"] < ledger["maxAttempts"]:
            if all(states[dependency] == "verified" for dependency in step["dependsOn"]):
                return deepcopy(step)
    return None


def summary(ledger):
    """Return a model-safe dependency summary without failure text or paths."""
    validate_ledger(ledger)
    return [{"id": step["id"], "title": step["title"], "state": step["state"],
             **({"commit": step["commit"]} if step["commit"] else {})}
            for step in ledger["steps"]]


def progress_projection(ledger, step_context, budget_source):
    """Project the ledger into Core's bounded public codeSteps contract."""
    validate_ledger(ledger)
    state_map = {"verified": "passed", "blocked": "failed"}
    rows = []
    for step in ledger["steps"]:
        state = state_map.get(step["state"], step["state"])
        row = {"id": step["id"], "title": step["title"], "state": state,
               "tests": [{"profile": receipt["profile"], "outcome": receipt["outcome"],
                           "durationMs": receipt["durationMs"]} for receipt in step["verification"]]}
        if state == "passed":
            row["commit"] = step["commit"]
        rows.append(row)
    counts = {state: sum(row["state"] == state for row in rows) for state in ("pending", "running", "passed", "failed")}
    current = next((row["id"] for row in rows if row["state"] == "running"), None)
    return {"schema": SUMMARY_SCHEMA, "planFingerprint": ledger["planFingerprint"], "stepContext": step_context,
            "budgetSource": budget_source, "currentStep": current, "counts": counts, "steps": rows}


class CodeStepLedger:
    """Atomic file-backed mutation API for one private task ledger."""

    def __init__(self, path):
        self.path = Path(path)
        self.lock_path = self.path.with_name(self.path.name + ".lock")

    @contextmanager
    def _lock(self):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.path.parent, 0o700)
        descriptor = os.open(self.lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            os.fchmod(descriptor, 0o600)
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            yield
        finally:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)

    def _read(self):
        try:
            info = self.path.lstat()
        except FileNotFoundError:
            raise CodeLedgerError("code-step ledger does not exist") from None
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            raise CodeLedgerError("code-step ledger must be a private regular file")
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise CodeLedgerError("code-step ledger is unreadable") from error
        return validate_ledger(value)

    def load(self):
        with self._lock():
            return deepcopy(self._read())

    def _write(self, ledger):
        validate_ledger(ledger)
        payload = (json.dumps(ledger, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()
        descriptor, temporary = tempfile.mkstemp(prefix=self.path.name + ".", suffix=".tmp", dir=self.path.parent)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
            directory = os.open(self.path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass

    def create(self, task_id, source_commit, plan, *, created_at=None, max_attempts=MAX_ATTEMPTS):
        with self._lock():
            if self.path.exists():
                raise CodeLedgerError("code-step ledger already exists")
            ledger = new_ledger(task_id, source_commit, plan, created_at=created_at, max_attempts=max_attempts)
            self._write(ledger)
            return deepcopy(ledger)

    def save(self, ledger, expected_revision):
        """CAS-save a caller-produced valid ledger."""
        with self._lock():
            current = self._read()
            if current["revision"] != expected_revision:
                raise LedgerConflict("code-step ledger revision changed")
            value = deepcopy(ledger)
            if value.get("revision") != expected_revision:
                raise CodeLedgerError("saved ledger must carry the expected revision")
            value["revision"] += 1
            value["updatedAt"] = _now()
            self._write(value)
            return deepcopy(value)

    def _mutate(self, expected_revision, operation):
        with self._lock():
            ledger = deepcopy(self._read())
            if ledger["revision"] != expected_revision:
                raise LedgerConflict("code-step ledger revision changed")
            operation(ledger)
            ledger["revision"] += 1
            ledger["updatedAt"] = _now()
            self._write(ledger)
            return deepcopy(ledger)

    def start(self, step_id, expected_revision):
        def operation(ledger):
            step = _step(ledger, step_id)
            candidate = next_step(ledger)
            if candidate is None or candidate["id"] != step_id:
                raise CodeLedgerError("step is not the next dependency-ready step")
            step["state"] = "running"
            step["attempts"] += 1
            step["failure"] = None
            step["verification"] = []
        return self._mutate(expected_revision, operation)

    def record_verified(self, step_id, commit, changed_paths, verification, expected_revision):
        def operation(ledger):
            step = _step(ledger, step_id)
            if step["state"] != "running":
                raise CodeLedgerError("only the running step can be verified")
            step["commit"] = _oid(commit)
            step["changedPaths"] = [repository_path(path, "changed path") for path in changed_paths]
            step["verification"] = deepcopy(verification)
            step["failure"] = None
            step["state"] = "verified"
            step["history"].append({"attempt": step["attempts"], "state": "verified",
                                    "commit": step["commit"], "changedPaths": deepcopy(step["changedPaths"]),
                                    "verification": deepcopy(step["verification"]), "failure": None})
            validate_ledger(ledger)
        return self._mutate(expected_revision, operation)

    def record_failure(self, step_id, reason, expected_revision, *, verification=None):
        def operation(ledger):
            step = _step(ledger, step_id)
            if step["state"] != "running":
                raise CodeLedgerError("only the running step can fail")
            step["verification"] = deepcopy(verification or [])
            _validate_verification(step["verification"], step, completed=False)
            step["state"] = "blocked" if step["attempts"] >= ledger["maxAttempts"] else "failed"
            step["failure"] = {"reason": _text(reason, "failure reason", 1_000), "at": _now()}
            step["history"].append({"attempt": step["attempts"], "state": "failed", "commit": None,
                                    "changedPaths": [], "verification": deepcopy(step["verification"]),
                                    "failure": deepcopy(step["failure"])})
        return self._mutate(expected_revision, operation)

    def block(self, step_id, reason, expected_revision):
        def operation(ledger):
            step = _step(ledger, step_id)
            if step["state"] not in ("pending", "failed"):
                raise CodeLedgerError("only an unfinished inactive step can be blocked")
            step["state"] = "blocked"
            step["failure"] = {"reason": _text(reason, "block reason", 1_000), "at": _now()}
        return self._mutate(expected_revision, operation)
