"""Filesystem-only episodic memory transfer and honest runtime observations."""
from __future__ import annotations

import json
import datetime as dt
import os
import re
import stat
import subprocess
import time
from pathlib import Path

REQUIRED_CHECKS = {"world", "llm-auth-required", "llm-authorized", "core-health", "core-queue",
                   "core-config", "llm-method", "encoded-path", "llm-query", "netcheck-no-inference",
                   "inference-route-exclusive", "docker-socket", "owner-home", "owner-auth", "host-processes",
                   "operator-token", "world-internal-url"}
# DSH and pi read a generated provider config: it must name only the local relay and no secret.
HARNESS_CHECKS = {"codex": set(), "dsh": {"harness-config"}, "pi": {"harness-config"}}

MEMORY = ("SOUL.md", "EPISODIC_MEMORY.md", "SEMANTIC_MEMORY.md", "EPISODIC_MEMORY.jsonl")


def read_regular(path: Path, limit: int, *, tail=False):
    """Read a bounded regular file without following a replaced symlink or blocking on a FIFO."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError as error:
        raise ValueError("memory/log must be a readable regular file: " + path.name) from error
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or (not tail and info.st_size > limit):
            raise ValueError("memory/log must be a bounded regular file: " + path.name)
        if tail:
            stream.seek(max(0, info.st_size - limit))
        data = stream.read(limit if tail else limit + 1)
        if len(data) > limit:
            raise ValueError("memory/log grew beyond its bound: " + path.name)
        return data, info


def atomic_json(path, value):
    temp = path.with_suffix(path.suffix + ".tmp")
    with open(temp, "w") as output:
        json.dump(value, output, indent=2)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    os.replace(temp, path)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(directory)
    finally: os.close(directory)


def seed_workspace(workspace: Path, templates: Path, previous: Path | None = None):
    """Transfer only named memory from a terminated episode, never its session/tools."""
    source = templates
    if previous:
        receipt = json.loads((previous / "receipt.json").read_text())
        if receipt.get("outcome") not in ("completed", "stopped") or not receipt.get("ended_at"):
            raise ValueError("memory source must have a terminal episode receipt")
        source = previous / "agents" / receipt["agent"].lower() / "workspace"
    copy_memory_files(source, workspace, require_all=previous is not None)


def copy_memory_files(source: Path, workspace: Path, require_all=True):
    workspace.mkdir(parents=True, exist_ok=True)
    for name in MEMORY:
        path = source / name
        if name == "EPISODIC_MEMORY.jsonl" and not require_all and not path.exists():
            (workspace / name).touch()
            continue
        data, _info = read_regular(path, 8 * 1024 * 1024)
        if name.endswith(".jsonl"):
            for line in data.decode("utf-8").splitlines():
                if line.strip() and not isinstance(json.loads(line), dict):
                    raise ValueError("invalid episodic memory record")
        (workspace / name).write_bytes(data)
    os.chmod(workspace / "SOUL.md", 0o444)


def latest_activity(sessions: Path, since: float | None = None):
    files = [p for p in sessions.rglob("*.jsonl") if p.is_file() and not p.is_symlink()] if sessions.is_dir() else []
    if since is not None:
        files = [path for path in files if path.stat().st_mtime >= since]
    if not files: return None
    newest = max(files, key=lambda p: p.stat().st_mtime)
    try:
        data, info = read_regular(newest, 65536, tail=True)
    except ValueError:
        return None
    lines = data.splitlines()
    records = []
    for line in lines:
        try: value = json.loads(line)
        except ValueError: continue
        if isinstance(value, dict): records.append(value)
    last = records[-1] if records else {}
    meaningful = [value for value in records if value.get("type") == "response_item" and
                  isinstance(value.get("payload"), dict) and
                  value["payload"].get("type") in ("message", "reasoning", "function_call") and
                  value["payload"].get("role", "assistant") == "assistant"]
    # Errors, user prompts and session metadata must not refresh model activity:
    # a failed turn loop keeps writing these while no inference succeeds.
    at = None
    if meaningful:
        try:
            at = dt.datetime.fromisoformat(meaningful[-1]["timestamp"].replace("Z", "+00:00")).timestamp()
        except (KeyError, TypeError, ValueError, AttributeError):
            at = info.st_mtime  # Older/synthetic rollouts without timestamps.
    age = max(0, time.time() - at) if at is not None else float("inf")
    return {"age": age, "payload": last.get("payload") or {}, "modelActivity": bool(meaningful)}


def pane_alive(started):
    pane = getattr(started, "tmux_pane_id", None)
    if not isinstance(pane, str) or not re.fullmatch(r"%\d+", pane):
        raise RuntimeError("agent returned no exact tmux pane identity")
    result = subprocess.run(["tmux", "display-message", "-p", "-t", pane, "#{pane_dead}"],
                            capture_output=True, text=True, timeout=5)
    if result.returncode not in (0, 1): raise RuntimeError("tmux observation failed")
    return result.returncode == 0 and result.stdout.strip() == "0"


def netcheck_result(workspace: Path, harness: str = "codex"):
    path = workspace / "netcheck.json"
    if not path.is_file(): raise RuntimeError("netcheck has no terminal result")
    value = json.loads(path.read_text())
    checks = value.get("checks")
    required = REQUIRED_CHECKS | HARNESS_CHECKS[harness]
    if (value.get("schema") != "agentx.island-netcheck/v1" or not isinstance(checks, list)
            or not checks or any(not isinstance(item, dict) or item.get("passed") is not True for item in checks)
            or not required.issubset({item.get("name") for item in checks})
            or value.get("harness", "codex") != harness):
        raise RuntimeError("netcheck failed or incomplete")
    return value
