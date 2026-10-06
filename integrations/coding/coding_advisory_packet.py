#!/usr/bin/env python3
"""Export one verified coding patch and original authority for private advice."""
from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
import subprocess

try:
    from integrations.coding.coding_team_promotion import api_json, changed_snapshot, worker_snapshot_fingerprint
    from integrations.coding.coding_task_worktree import promotion_workspace, profile_fingerprint
except ModuleNotFoundError:
    from coding_team_promotion import api_json, changed_snapshot, worker_snapshot_fingerprint
    from coding_task_worktree import promotion_workspace, profile_fingerprint


def packet_for(task, config):
    attempts = task.get("automationAttempts") or []
    if task.get("status") not in {"review", "done"} or not attempts:
        raise ValueError("advice requires a completed independently verified attempt")
    attempt = attempts[-1]
    evidence = attempt.get("evidence") or {}
    automation = task.get("automation") or {}
    repository = evidence.get("repository") or {}
    if attempt.get("finalState") != "review" or evidence.get("verification", {}).get("status") != "passed" or not repository:
        raise ValueError("advice requires the original worktree and passing independent receipt")
    profile = config["executionProfiles"][automation["executionProfile"]]
    verification = config["verificationProfiles"][automation["verificationProfile"]]
    args = argparse.Namespace(independent_verification_command=verification["command"],
        independent_verification_timeout=verification["timeoutSeconds"], allowed_path=automation["scope"],
        max_changed_files=verification["maxChangedFiles"], max_changed_bytes=verification["maxChangedBytes"])
    if repository.get("verificationProfileFingerprint") != profile_fingerprint(args, task):
        raise ValueError("original task or verification profile changed")
    repo = Path(promotion_workspace(profile, task, attempt)).resolve(strict=True)
    def git(*parts):
        return subprocess.check_output(["git", "-C", str(repo), *parts], text=True, timeout=10)
    if git("rev-parse", "HEAD").strip() != repository["baseRevision"]:
        raise ValueError("advisory worktree no longer has its original base")
    snapshot = changed_snapshot(repo)
    if not set(snapshot["files"]).issubset(set(automation["scope"])) \
            or snapshot["filesChanged"] > verification["maxChangedFiles"] or snapshot["bytesChanged"] > verification["maxChangedBytes"]:
        raise ValueError("advisory snapshot exceeds its verified scope or budget")
    fingerprint = worker_snapshot_fingerprint(pipeline_id=task["pipelineId"], attempt=attempt["attempt"],
        assignee=attempt["assignee"], base_revision=repository["baseRevision"], files=snapshot["files"])
    if fingerprint != evidence.get("workerReceiptFingerprint"):
        raise ValueError("advisory patch differs from the verified worker receipt")
    authority = []
    for file in automation["sourceFiles"]:
        mode = git("ls-tree", repository["baseRevision"], "--", file).split(" ")[0]
        if mode not in {"100644", "100755"}:
            raise ValueError("advisory authority is not an original regular file")
        authority.append({"path": file, "content": git("show", f"{repository['baseRevision']}:{file}")})
    return {"schema": "agentx.coding-advisory-packet/v1", "pipelineId": task["pipelineId"],
        "attempt": attempt["attempt"], "spec": task["spec"], "baseRevision": repository["baseRevision"],
        "workerReceiptFingerprint": fingerprint, "candidateModel": evidence.get("usage", {}).get("effectiveModel"),
        "scope": automation["scope"], "authority": authority,
        "changes": [{"path": file, "content": content.decode("utf-8")} for file, content in sorted(snapshot["files"].items())],
        "verification": {"profile": automation["verificationProfile"], **evidence["verification"]}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"\d{4,}", args.task_id):
        raise ValueError("invalid advisory task identity")
    config = json.loads(args.config.read_text())
    task = api_json(config["apiBase"], f"/api/pipeline/tasks/{args.task_id}", ca_file=None).get("data", {}).get("task")
    packet = packet_for(task or {}, config)
    target = args.out.resolve()
    if any((parent / ".git").exists() for parent in [target.parent, *target.parents]) \
            or any((parent.name.startswith("workspace-") and parent.parent.name == ".openclaw") for parent in target.parents):
        raise ValueError("advisory packet must stay outside Git and worker workspaces")
    raw = json.dumps(packet, sort_keys=True, separators=(",", ":")).encode()
    if len(raw) > 1024 * 1024:
        raise ValueError("advisory packet exceeds its explicit byte budget")
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as out:
        out.write(raw); out.flush(); os.fsync(out.fileno())
    print(json.dumps({"pipelineId": packet["pipelineId"], "attempt": packet["attempt"], "out": str(target)}))


if __name__ == "__main__":
    main()
