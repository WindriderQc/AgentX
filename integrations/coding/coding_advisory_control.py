#!/usr/bin/env python3
"""Opt-in host tick for one private consultative review, never task acceptance."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid

try:
    from integrations.coding.coding_advisory_packet import packet_for
    from integrations.coding.coding_team_promotion import list_tasks, PromotionError
except ModuleNotFoundError:
    from coding_advisory_packet import packet_for
    from coding_team_promotion import list_tasks, PromotionError

TERMINAL = {"completed", "output_budget_exhausted", "no_visible_review", "refused_before_dispatch", "not_run"}


def command(argv, **kwargs):
    return subprocess.run(argv, check=True, timeout=15, text=True, capture_output=True, **kwargs)


def save(file, value):
    temporary = file.with_suffix(".tmp")
    descriptor = os.open(temporary, os.O_CREAT | os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as out:
        json.dump(value, out, sort_keys=True); out.flush(); os.fsync(out.fileno())
    temporary.replace(file)


def tick(config, root, *, run=command, tasks=list_tasks, build=packet_for, now=time.time):
    settings = config.get("advisoryReview") or {}
    if settings.get("enabled") is not True:
        return {"status": "disabled"}
    container = settings.get("coreContainer")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}", container or "") or not settings.get("model") or not settings.get("hostUrl"):
        raise ValueError("advisory review needs an explicit Core container, local model and host")
    state_file = root / "control.json"
    state = json.loads(state_file.read_text()) if state_file.exists() else {}
    pending = state.get("pending")
    if pending:
        local = root / f"{pending['job']}-receipt.json"
        try:
            run(["docker", "cp", f"{container}:{pending['out']}/receipt.json", str(local)])
            receipt = json.loads(local.read_text())
            local.chmod(0o600)
        except (subprocess.SubprocessError, OSError, ValueError):
            if now() - pending["submittedAt"] > 390:
                return {"status": "unknown", "pipelineId": pending["pipelineId"], "reason": "advisory receipt is unavailable; no second execution"}
            return {"status": "running", "pipelineId": pending["pipelineId"]}
        if receipt.get("schema") != "agentx.coding-advisory-review/v1" or receipt.get("packetFingerprint") != pending["fingerprint"] \
                or receipt.get("pipelineId") != pending["pipelineId"] or receipt.get("attempt") != pending["attempt"] \
                or receipt.get("requestedModel") != settings["model"] or receipt.get("requestedHost") != settings["hostUrl"]:
            raise ValueError("advisory receipt identity changed; pending execution remains fenced")
        status = receipt.get("status")
        if status == "deferred_before_dispatch" and receipt.get("usage", {}).get("modelCalls") != 0:
            raise ValueError("retry requires a proven zero-call refusal; pending execution remains fenced")
        if status in TERMINAL or status == "deferred_before_dispatch":
            state.setdefault("finished", {})[pending["key"]] = {"status": status, "receipt": str(local)}
            state.pop("pending"); save(state_file, state)
        elif status != "running" or now() - pending["submittedAt"] > 390:
            status = "unknown"
        return {"status": status, "pipelineId": pending["pipelineId"], "receipt": str(local)}
    for task in tasks(config["apiBase"], ca_file=None):
        if task.get("status") != "review":
            continue
        try:
            packet = build(task, config)
        except (ValueError, KeyError, PromotionError, subprocess.SubprocessError):
            continue
        if len(json.dumps(packet, sort_keys=True).encode()) > 1024 * 1024:
            raise ValueError("advisory packet exceeds its explicit byte budget")
        key = f"{packet['pipelineId']}-{packet['attempt']}-{packet['workerReceiptFingerprint']}"
        previous = state.get("finished", {}).get(key)
        if previous and previous["status"] != "deferred_before_dispatch":
            continue
        run(["docker", "exec", container, "test", "-f", "/app/scripts/coding-advisory-review.js"])
        job = uuid.uuid4().hex
        local = root / f"{job}-packet.json"
        # Core hashes the exact serialized packet bytes, including indentation.
        save(local, packet)
        fingerprint = hashlib.sha256(local.read_bytes()).hexdigest()
        remote = f"/tmp/agentx-coding-advisory-{job}.json"
        out = f"/tmp/agentx-coding-advisory-{job}"
        run(["docker", "cp", str(local), f"{container}:{remote}"])
        state["pending"] = {"job": job, "key": key, "fingerprint": fingerprint, "pipelineId": packet["pipelineId"],
            "attempt": packet["attempt"], "out": out, "submittedAt": now()}
        save(state_file, state)  # Persist before the only model-process launch.
        try:
            run(["docker", "exec", "--detach", container, "node", "/app/scripts/coding-advisory-review.js",
                "--packet", remote, "--out", out, "--model", settings["model"], "--host-url", settings["hostUrl"],
                "--timeout-ms", "300000", "--output-tokens", "2048"])
        except (subprocess.SubprocessError, OSError):
            return {"status": "unknown", "pipelineId": packet["pipelineId"], "reason": "review launch acknowledgement is unavailable"}
        return {"status": "submitted", "pipelineId": packet["pipelineId"]}
    return {"status": "no_verified_review_task"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--state-root", type=Path, default=Path.home() / ".local/state/agentx/coding-advisory")
    args = parser.parse_args()
    root = args.state_root.resolve()
    if any((parent / ".git").exists() for parent in [root, *root.parents]) \
            or any(parent.name.startswith("workspace-") and parent.parent.name == ".openclaw" for parent in [root, *root.parents]):
        raise ValueError("advisory state must stay outside Git and worker workspaces")
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.stat().st_uid != os.getuid() or root.stat().st_mode & 0o077:
        raise ValueError("advisory state must be private and operator-owned")
    with (root / "control.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        result = tick(json.loads(args.config.read_text()), root)
    print(json.dumps({"schema": "agentx.coding-advisory-control/v1", **result}))


if __name__ == "__main__":
    main()
