"""Task-bound worker worktrees and original-base evidence."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import PurePosixPath
import re
import shlex


def task_workspace(seed_repo: str, pipeline_id: str) -> str:
    if not re.fullmatch(r"\d{4,}", str(pipeline_id)):
        raise ValueError("invalid worktree task identity")
    return str(PurePosixPath(seed_repo).parent / "tasks" / pipeline_id)


def configure_execution(command: list[str], execution: dict, verification: dict) -> None:
    if execution.get("taskWorktrees") is True:
        command.append("--task-worktrees")
    calls = verification.get("workerVerificationCalls", 0)
    if type(calls) is not int or not 0 <= calls <= 5:
        raise ValueError("workerVerificationCalls must be from zero to five")
    if execution.get("taskWorktrees") is True and not calls:
        raise ValueError("taskWorktrees requires workerVerificationCalls and its scoped file plugin")
    if calls:
        command.extend(["--worker-verification-calls", str(calls)])


def profile_fingerprint(args: argparse.Namespace, task=None) -> str:
    return hashlib.sha256(json.dumps({"command": args.independent_verification_command,
        "timeout": args.independent_verification_timeout, "scope": sorted(args.allowed_path or []),
        "maxFiles": args.max_changed_files, "maxBytes": args.max_changed_bytes,
        "taskSpec": (task or {}).get("spec"), "automationFingerprint": (task or {}).get("automation", {}).get("fingerprint"),
    }, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def prepare_task_worktree(args, task, revision, remote):
    if not getattr(args, "task_worktrees", False):
        return revision
    seed = args.remote_repo
    workspace = task_workspace(seed, args.task_id)
    previous = ((task.get("automationAttempts") or [{}])[-1].get("evidence") or {}).get("repository")
    if args.repair_attempt:
        if not previous or previous.get("workspaceRef") != f"tasks/{args.task_id}" \
                or previous.get("verificationProfileFingerprint") != profile_fingerprint(args, task):
            raise remote.PipelineApiError("repair worktree has no matching original task/profile receipt")
        revision = previous.get("baseRevision")
    if not remote.COMMIT_PATTERN.fullmatch(str(revision or "")):
        raise remote.PipelineApiError("task worktree original revision is invalid")
    source = getattr(args, "source_repo", remote.DEFAULT_REMOTE_SOURCE_REPO)
    qseed, qsource, qworkspace, qrevision = map(shlex.quote, (seed, source, workspace, revision))
    # Fetch objects without changing the shared seed's HEAD, index or dirty files.
    script = (f"git -C {qseed} fetch --quiet --no-tags {qsource} {qrevision} && "
              f"git -C {qseed} cat-file -e {qrevision} && ")
    if args.repair_attempt:
        script += f"test -d {qworkspace}"
    else:
        if task.get("automationAttempts"):
            raise remote.PipelineApiError("existing attempts require their original repair worktree receipt")
        script += (f"if test -e {qworkspace}; then "
                   f'test "$(git -C {qworkspace} rev-parse --show-toplevel)" = {qworkspace} && '
                   f'test "$(git -C {qworkspace} rev-parse HEAD)" = {qrevision} && '
                   f'test -z "$(git -C {qworkspace} status --porcelain)"; '
                   f"else git -C {qseed} worktree add --quiet --detach {qworkspace} {qrevision}; fi")
    proc = remote.ssh_run(args.host, script, timeout=120)
    if proc.returncode:
        raise remote.PipelineApiError("task worktree is missing, already occupied or cannot be prepared")
    # Operator-provisioned dependencies are copied, never linked to another task.
    # The worker file hook refuses ignored files as well as tracked out-of-scope paths.
    if not args.repair_attempt:
        dependency = remote.ssh_run(args.host,
            f"if test -d {qseed}/core/node_modules && ! test -d {qworkspace}/core/node_modules; then cp -a -- {qseed}/core/node_modules {qworkspace}/core/node_modules; fi",
            timeout=120)
        if dependency.returncode:
            raise remote.PipelineApiError("task dependency snapshot could not be prepared")
    args.remote_repo = workspace
    args.repository_evidence = {"baseRevision": revision, "workspaceRef": f"tasks/{args.task_id}",
        "verificationProfileFingerprint": profile_fingerprint(args, task)}
    return revision


def promotion_workspace(profile, task, attempt, error_type=ValueError):
    seed = str(profile.get("remoteRepo") or "")
    repository = attempt.get("evidence", {}).get("repository")
    if not repository:
        return seed
    if repository.get("workspaceRef") != f"tasks/{task['pipelineId']}" \
            or not re.fullmatch(r"[a-f0-9]{40}", repository.get("baseRevision", "")):
        raise error_type("accepted task worktree receipt is invalid")
    return task_workspace(seed, str(task["pipelineId"]))
