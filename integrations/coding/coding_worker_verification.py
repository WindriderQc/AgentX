#!/usr/bin/env python3
"""Operator grants for the worker's bounded, read-only verification tool."""
from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import time
from urllib.parse import urlencode
from urllib.request import urlopen

try:
    from integrations.coding.coding_verification_sandbox import sandbox_arguments
    from integrations.coding.coding_dispatch_evidence import worker_workspace
except ModuleNotFoundError:
    from coding_verification_sandbox import sandbox_arguments
    from coding_dispatch_evidence import worker_workspace

SCHEMA = "agentx.coding-verification-grant/v1"
AGENT = re.compile(r"^[a-z0-9][a-z0-9-]{0,79}$")


def grant_root() -> Path:
    return Path.home() / ".local/state/agentx/coding-verification-grants"


def identifier(value):
    if not AGENT.fullmatch(str(value or "")):
        raise ValueError("invalid verification agent identity")
    return value


def canonical_session(agent, key):
    value = str(key or "").lower()
    if value.startswith(f"agent:{agent}:"):
        value = value[len(f"agent:{agent}:"):]
    if not re.fullmatch(r"[a-z0-9][a-z0-9._:-]{0,159}", value):
        raise ValueError("missing exact worker session")
    return value


@contextmanager
def locked(root, agent):
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.is_symlink() or root.stat().st_uid != os.getuid() or root.stat().st_mode & 0o077:
        raise ValueError("verification grants must be operator-owned and private")
    with (root / (identifier(agent) + ".lock")).open("a") as handle:
        os.chmod(handle.name, 0o600)
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield root / (agent + ".json")


def save(file, value):
    temporary = file.with_suffix(".tmp")
    descriptor = os.open(temporary, os.O_CREAT | os.O_TRUNC | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        os.fchmod(handle.fileno(), 0o600)
        json.dump(value, handle, sort_keys=True)
        handle.flush(); os.fsync(handle.fileno())
    temporary.replace(file)


def prepare(grant, *, root=None):
    agent = identifier(grant.get("agent"))
    repository = Path(grant["repository"])
    workspace = worker_workspace(str(repository), agent)
    if str(repository.resolve()) != str(repository) or not repository.is_dir():
        raise ValueError("verification repository must be an exact existing workspace")
    root = root or grant_root()
    if root.resolve().is_relative_to(Path(str(workspace))):
        raise ValueError("verification grants cannot live in the worker workspace")
    if not re.fullmatch(r"[a-f0-9]{40}", grant.get("baseRevision", "")) \
            or not re.fullmatch(r"\d{4,}", grant.get("pipelineId", "")):
        raise ValueError("verification grant needs exact task and source identities")
    if type(grant.get("maxCalls")) is not int or not 1 <= grant["maxCalls"] <= 5 \
            or type(grant.get("timeoutSeconds")) is not int or not 1 <= grant["timeoutSeconds"] <= 900:
        raise ValueError("verification calls and timeout must be bounded")
    if not grant.get("command") or not grant.get("scope") or not grant.get("leaseId") \
            or type(grant.get("attempt")) is not int or grant["attempt"] < 1:
        raise ValueError("verification grant lacks operator profile or lease")
    if type(grant.get("maxChangedFiles")) is not int or not 1 <= grant["maxChangedFiles"] <= 100 \
            or type(grant.get("maxChangedBytes")) is not int or not 1 <= grant["maxChangedBytes"] <= 10_000_000 \
            or not isinstance(grant.get("deadlineEpoch"), (int, float)) or not time.time() < grant["deadlineEpoch"] <= time.time() + 900:
        raise ValueError("verification grant lacks bounded patch and execution budgets")
    session = canonical_session(agent, grant.get("sessionKey"))
    with locked(root, agent) as file:
        if file.exists():
            info = file.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
                raise ValueError("existing grant is not a private operator file")
            previous = json.loads(file.read_text())
            same = all(previous.get(key) == value for key, value in {**grant, "sessionKey": session}.items()
                       if key != "deadlineEpoch")
            if same:
                return {"prepared": True, "pipelineId": grant["pipelineId"], "attempt": grant["attempt"], "idempotent": True}
            if previous.get("deadlineEpoch", 0) > time.time():
                task = read_task(previous) or {}
                lease = task.get("automationLease") or {}
                if task.get("status") == "in_progress" and lease.get("leaseId") == previous.get("leaseId"):
                    raise ValueError("another worker verification grant is still active")
        save(file, {**grant, "schema": SCHEMA, "sessionKey": session, "calls": 0})
    return {"prepared": True, "pipelineId": grant["pipelineId"], "attempt": grant["attempt"]}


def read_task(grant):
    query = urlencode({"agent": grant["agent"], "leaseId": grant["leaseId"]})
    url = f"{grant['apiBase'].rstrip('/')}/api/pipeline/tasks/{grant['pipelineId']}/worker?{query}"
    with urlopen(url, timeout=10) as response:
        return json.load(response).get("data", {}).get("task")


def assert_active(grant, task_reader, now):
    if now() >= grant["deadlineEpoch"]:
        raise ValueError("verification turn deadline expired")
    task = task_reader(grant) or {}
    lease = task.get("automationLease") or {}
    if task.get("pipelineId") != grant["pipelineId"] or task.get("status") != "in_progress" or task.get("assignee") != grant["agent"] \
            or lease.get("leaseId") != grant["leaseId"] or lease.get("attempt") != grant["attempt"] \
            or datetime.fromisoformat(lease["expiresAt"].replace("Z", "+00:00")).timestamp() <= now():
        raise ValueError("verification task lease is no longer active")
    if sorted((task.get("automation") or {}).get("scope") or []) != sorted(grant["scope"]):
        raise ValueError("verification scope differs from Core authority")


def git_output(repository, argv):
    return subprocess.check_output(["git", "-C", repository, *argv], timeout=10)


def assert_scope(grant):
    repo = grant["repository"]
    if git_output(repo, ["rev-parse", "--show-toplevel"]).decode().strip() != repo \
            or git_output(repo, ["rev-parse", "HEAD"]).decode().strip() != grant["baseRevision"]:
        raise ValueError("verification workspace base changed")
    changed = set(git_output(repo, ["diff", "--name-only", "-z", "HEAD"]).decode().split("\0")) \
        | set(git_output(repo, ["ls-files", "--others", "--exclude-standard", "-z"]).decode().split("\0"))
    changed.discard("")
    if not changed.issubset(set(grant["scope"])) or len(changed) > grant["maxChangedFiles"]:
        raise ValueError("verification patch exceeds task scope")
    for file in changed:
        target = Path(repo) / file
        if target.is_symlink() or not target.is_file():
            raise ValueError("verification changes must be regular files")
    size = len(git_output(repo, ["diff", "HEAD"])) + sum((Path(repo) / file).stat().st_size for file in
        git_output(repo, ["ls-files", "--others", "--exclude-standard", "-z"]).decode().split("\0") if file)
    if size > grant["maxChangedBytes"]:
        raise ValueError("verification patch exceeds the operator byte budget")


def bounded_verifier(argv, *, timeout, **_options):
    import resource
    def limits():
        resource.setrlimit(resource.RLIMIT_FSIZE, (2_000_000, 2_000_000))
    with tempfile.TemporaryFile() as output:
        result = subprocess.run(argv, timeout=timeout, stdout=output, stderr=subprocess.STDOUT,
                                preexec_fn=limits)
        output.seek(0)
        text = output.read(2_000_001).decode("utf-8", errors="replace")
        if len(text.encode()) >= 2_000_000:
            raise ValueError("verification output exceeded its explicit byte budget")
        return subprocess.CompletedProcess(argv, result.returncode, stdout=text)


def run(agent, session_key, *, root=None, task_reader=read_task, now=time.time, executor=bounded_verifier):
    root = root or grant_root()
    with locked(root, agent) as file:
        info = file.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
            raise ValueError("verification grant is not a private operator file")
        grant = json.loads(file.read_text())
        if grant.get("schema") != SCHEMA or grant.get("agent") != agent \
                or grant["sessionKey"] != canonical_session(agent, session_key):
            raise ValueError("verification grant belongs to another worker session")
        assert_active(grant, task_reader, now); assert_scope(grant)
        if grant["calls"] >= grant["maxCalls"]:
            raise ValueError("verification call budget exhausted")
        grant["calls"] += 1
        save(file, grant)  # Reserve the call durably before any verifier runs.
        node = str(Path("/usr/local/bin/node").resolve(strict=True)) if grant["command"].lstrip().startswith("/node/node ") else None
        argv = sandbox_arguments(grant["repository"], grant["command"], node)
        started = now()
        try:
            result = executor(argv, timeout=min(grant["timeoutSeconds"], grant["deadlineEpoch"] - now()),
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            output = str(result.stdout or "")
            code = result.returncode
        except subprocess.TimeoutExpired as error:
            output = str(error.stdout or "") + "\nVerification timed out."
            code = None
        assert_active(grant, task_reader, now); assert_scope(grant)
        receipt = {"schema": "agentx.coding-worker-verification/v1", "pipelineId": grant["pipelineId"],
            "attempt": grant["attempt"], "call": grant["calls"], "passed": code == 0, "exitCode": code,
            "durationMs": round((now() - started) * 1000), "output": output,
            "outputFingerprint": hashlib.sha256(output.encode()).hexdigest()}
        save(root / f"{agent}-last-verification.json", receipt)
        return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "run"])
    parser.add_argument("--grant-base64")
    parser.add_argument("--agent")
    parser.add_argument("--session-key")
    parser.add_argument("--grant-root", type=Path)
    args = parser.parse_args()
    try:
        receipt = prepare(json.loads(base64.b64decode(args.grant_base64)), root=args.grant_root) if args.action == "prepare" else run(args.agent, args.session_key, root=args.grant_root)
        print(json.dumps(receipt))
        return 0
    except (ValueError, OSError, KeyError, subprocess.SubprocessError) as error:
        print(json.dumps({"passed": False, "code": "VERIFICATION_REFUSED", "detail": str(error)}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
