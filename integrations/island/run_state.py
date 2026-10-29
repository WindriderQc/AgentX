"""Filesystem-only episodic memory transfer and honest runtime observations."""
from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
import time
from pathlib import Path

REQUIRED_CHECKS = {"world", "llm-auth-required", "llm-authorized", "core-health", "core-queue",
                   "core-config", "llm-method", "encoded-path", "llm-query", "netcheck-no-inference",
                   "docker-socket", "owner-home", "owner-auth", "host-processes", "operator-token",
                   "world-internal-url"}

MEMORY = ("SOUL.md", "EPISODIC_MEMORY.md", "SEMANTIC_MEMORY.md", "EPISODIC_MEMORY.jsonl")


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
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > 8 * 1024 * 1024:
            raise ValueError("memory must be a bounded regular file: " + name)
        if name.endswith(".jsonl"):
            for line in path.read_text().splitlines():
                if line.strip() and not isinstance(json.loads(line), dict):
                    raise ValueError("invalid episodic memory record")
        shutil.copyfile(path, workspace / name)
    os.chmod(workspace / "SOUL.md", 0o444)


def latest_activity(sessions: Path):
    files = list(sessions.rglob("*.jsonl")) if sessions.is_dir() else []
    if not files: return None
    newest = max(files, key=lambda p: p.stat().st_mtime)
    age = max(0, time.time() - newest.stat().st_mtime)
    with open(newest, "rb") as stream:
        stream.seek(0, os.SEEK_END)
        stream.seek(max(0, stream.tell() - 65536))
        lines = stream.read().splitlines()
    records = []
    for line in lines:
        try: value = json.loads(line)
        except ValueError: continue
        if isinstance(value, dict): records.append(value)
    last = records[-1] if records else {}
    meaningful = any(value.get("type") == "response_item" and
                     (value.get("payload") or {}).get("type") in ("message", "reasoning", "function_call") and
                     (value.get("payload") or {}).get("role", "assistant") == "assistant"
                     for value in records)
    return {"age": age, "payload": last.get("payload") or {}, "modelActivity": meaningful}


def pane_alive(started):
    pane = getattr(started, "tmux_pane_id", None)
    if not isinstance(pane, str) or not re.fullmatch(r"%\d+", pane):
        raise RuntimeError("agent returned no exact tmux pane identity")
    result = subprocess.run(["tmux", "display-message", "-p", "-t", pane, "#{pane_dead}"],
                            capture_output=True, text=True, timeout=5)
    if result.returncode not in (0, 1): raise RuntimeError("tmux observation failed")
    return result.returncode == 0 and result.stdout.strip() == "0"


def netcheck_result(workspace: Path):
    path = workspace / "netcheck.json"
    if not path.is_file(): raise RuntimeError("netcheck has no terminal result")
    value = json.loads(path.read_text())
    checks = value.get("checks")
    if (value.get("schema") != "agentx.island-netcheck/v1" or not isinstance(checks, list)
            or not checks or any(not isinstance(item, dict) or item.get("passed") is not True for item in checks)
            or not REQUIRED_CHECKS.issubset({item.get("name") for item in checks})):
        raise RuntimeError("netcheck failed or incomplete")
    return value
