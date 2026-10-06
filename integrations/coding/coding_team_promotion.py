#!/usr/bin/env python3
"""Promote one human-accepted Coding Team snapshot to a guarded pull request."""

from __future__ import annotations

try:
    from integrations.coding.coding_task_worktree import promotion_workspace
except ModuleNotFoundError:
    from coding_task_worktree import promotion_workspace

import argparse
import hashlib
import json
import os
import re
import shutil
import ssl
import stat
import subprocess
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin, urlparse
from urllib.request import Request, urlopen

try:
    from integrations.coding import clawdx_dispatch_remote
except ModuleNotFoundError:  # direct execution from the scripts directory
    import clawdx_dispatch_remote  # type: ignore

PROMOTION_SCHEMA = "agentx.coding-promotion/v1"
WORKER_RECEIPT_SCHEMA = "agentx.coding-worker-snapshot/v1"
PRE_REVIEW_SCHEMA = "agentx.coding-team-pre-review/v1"
PRE_REVIEW_MARKER = f"<!-- {PRE_REVIEW_SCHEMA} -->"
COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")
FINGERPRINT_PATTERN = re.compile(r"^[0-9a-f]{64}$")
PIPELINE_ID_PATTERN = re.compile(r"^[0-9]{4}$")

class PromotionError(RuntimeError):
    """Raised when a promotion cannot be proven safe and exact."""

def canonical_json(value: Mapping[str, Any]) -> bytes:
    return json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8")

def safe_relative_path(value: str) -> str:
    text = str(value or "").strip()
    parsed = PurePosixPath(text)
    if (
        not text
        or len(text) > 300
        or parsed.is_absolute()
        or "\\" in text
        or any(part in {"", ".", ".."} for part in parsed.parts)
    ):
        raise PromotionError("repository path is not a safe relative path")
    return text

def worker_snapshot_payload(
    *,
    pipeline_id: str,
    attempt: int,
    assignee: str,
    base_revision: str,
    files: Mapping[str, bytes],
) -> dict[str, Any]:
    if not PIPELINE_ID_PATTERN.fullmatch(str(pipeline_id or "")):
        raise PromotionError("worker receipt pipeline id is invalid")
    if not isinstance(attempt, int) or isinstance(attempt, bool) or attempt < 1:
        raise PromotionError("worker receipt attempt is invalid")
    worker = str(assignee or "").strip()
    if not worker or len(worker) > 120:
        raise PromotionError("worker receipt assignee is invalid")
    if not COMMIT_PATTERN.fullmatch(str(base_revision or "")):
        raise PromotionError("worker receipt base revision is invalid")
    records = []
    for raw_path in sorted(files):
        path = safe_relative_path(raw_path)
        content = files[raw_path]
        if not isinstance(content, bytes):
            raise PromotionError("worker receipt file content must be bytes")
        records.append({
            "path": path,
            "bytes": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
        })
    if not records:
        raise PromotionError("worker receipt requires at least one changed file")
    return {
        "schema": WORKER_RECEIPT_SCHEMA,
        "pipelineId": pipeline_id,
        "attempt": attempt,
        "assignee": worker,
        "baseRevision": base_revision,
        "files": records,
    }

def worker_snapshot_fingerprint(**values: Any) -> str:
    payload = worker_snapshot_payload(**values)
    return hashlib.sha256(canonical_json(payload)).hexdigest()


def run_command(
    args: list[str],
    *,
    cwd: Path | None = None,
    env: Mapping[str, str] | None = None,
    timeout: int = 120,
    input_text: str | None = None,
) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        args,
        cwd=str(cwd) if cwd else None,
        env=dict(env) if env else None,
        text=True,
        encoding="utf-8",
        errors="replace",
        input=input_text,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
    )
    if completed.returncode != 0:
        command = Path(args[0]).name
        raise PromotionError(f"{command} command failed with exit {completed.returncode}")
    return completed


def git_output(repo: Path, args: list[str], *, env: Mapping[str, str] | None = None) -> str:
    return run_command(["git", "-C", str(repo), *args], env=env).stdout.strip()


def git_zpaths(repo: Path, args: list[str]) -> set[str]:
    completed = subprocess.run(
        ["git", "-C", str(repo), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=60,
        check=False,
    )
    if completed.returncode != 0:
        raise PromotionError("git path inventory failed")
    return {
        item.decode("utf-8", errors="strict")
        for item in completed.stdout.split(b"\0")
        if item
    }


def verify_accepted_snapshot(host: str, worker_repo: Path, command: str,
                             base_revision: str, timeout: int) -> str:
    if not host:
        raise PromotionError("reviewed verifier host is unavailable")
    code, output = clawdx_dispatch_remote.run_independent_verification(
        host, str(worker_repo), command, expected_revision=base_revision,
        timeout=timeout,
    )
    if code != 0:
        raise PromotionError(f"sandboxed promotion verification failed with exit {code}")
    return output


def changed_snapshot(repo: Path) -> dict[str, Any]:
    repo = repo.resolve()
    paths = (
        git_zpaths(repo, ["diff", "--name-only", "-z"])
        | git_zpaths(repo, ["diff", "--cached", "--name-only", "-z"])
        | git_zpaths(repo, ["ls-files", "--others", "--exclude-standard", "-z"])
    )
    if not paths:
        raise PromotionError("worker checkout has no changed files")
    files: dict[str, bytes] = {}
    for raw_path in sorted(paths):
        relative = safe_relative_path(raw_path)
        candidate = repo.joinpath(*PurePosixPath(relative).parts)
        if not candidate.is_file() or candidate.is_symlink():
            raise PromotionError("worker snapshot contains a deletion, symlink, or non-file")
        resolved = candidate.resolve()
        if repo not in resolved.parents:
            raise PromotionError("worker snapshot path escapes the repository")
        files[relative] = candidate.read_bytes()
    diff = subprocess.run(
        ["git", "-C", str(repo), "diff", "--binary"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=60,
        check=False,
    )
    cached = subprocess.run(
        ["git", "-C", str(repo), "diff", "--cached", "--binary"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=60,
        check=False,
    )
    if diff.returncode != 0 or cached.returncode != 0:
        raise PromotionError("worker diff byte inventory failed")
    untracked = git_zpaths(repo, ["ls-files", "--others", "--exclude-standard", "-z"])
    return {
        "files": files,
        "filesChanged": len(paths),
        "bytesChanged": len(diff.stdout) + len(cached.stdout) + sum(len(files[path]) for path in untracked),
    }


def path_matches_prefix(path: str, prefix: str) -> bool:
    normalized = prefix.rstrip("/")
    return path == normalized or path.startswith(normalized + "/")


def latest_accepted_attempt(task: Mapping[str, Any]) -> Mapping[str, Any] | None:
    attempts = task.get("automationAttempts")
    if not isinstance(attempts, list):
        return None
    for attempt in reversed(attempts):
        if not isinstance(attempt, dict) or attempt.get("reviewOutcome") != "accepted":
            continue
        evidence = attempt.get("evidence")
        verification = evidence.get("verification") if isinstance(evidence, dict) else None
        fingerprint = evidence.get("workerReceiptFingerprint") if isinstance(evidence, dict) else None
        if (
            attempt.get("finalState") == "review"
            and attempt.get("reviewedAt")
            and isinstance(verification, dict)
            and verification.get("status") == "passed"
            and FINGERPRINT_PATTERN.fullmatch(str(fingerprint or ""))
            and not (evidence.get("failureCodes") or [])
        ):
            return attempt
    return None


def eligible_candidates(tasks: Iterable[Mapping[str, Any]]) -> list[tuple[Mapping[str, Any], Mapping[str, Any]]]:
    candidates = []
    for task in tasks:
        automation = task.get("automation")
        if (
            task.get("status") != "done"
            or task.get("service") in {"personal", "family"}
            or not isinstance(automation, dict)
            or automation.get("mode") != "review_only"
            or automation.get("policyRef") != "agentx.reviewed-code/v1"
            or not {"merge", "review"}.issubset(automation.get("humanGates") or [])
        ):
            continue
        attempt = latest_accepted_attempt(task)
        if attempt:
            candidates.append((task, attempt))
    candidates.sort(key=lambda pair: str(pair[1].get("reviewedAt") or ""))
    return candidates


def validate_candidate_snapshot(
    task: Mapping[str, Any],
    attempt: Mapping[str, Any],
    snapshot: Mapping[str, Any],
    config: Mapping[str, Any],
    *,
    base_revision: str,
) -> str:
    automation = task.get("automation") or {}
    policy = (config.get("policies") or {}).get(automation.get("policyRef"))
    if not isinstance(policy, dict) or policy.get("repository") != "agentx":
        raise PromotionError("accepted task policy is unavailable or targets another repository")
    scope = [safe_relative_path(path) for path in automation.get("scope") or []]
    allowed = [safe_relative_path(path.rstrip("/")) + "/" for path in policy.get("allowedPathPrefixes") or []]
    protected = [safe_relative_path(path.rstrip("/")) + "/" for path in policy.get("protectedPathPrefixes") or []]
    files = snapshot.get("files") or {}
    for path in files:
        if not any(path == item or (item.endswith("/") and path_matches_prefix(path, item)) for item in scope):
            raise PromotionError("worker snapshot exceeds the human-accepted task scope")
        if not any(path_matches_prefix(path, prefix) for prefix in allowed):
            raise PromotionError("worker snapshot exceeds the promotion policy path allowlist")
        if any(path_matches_prefix(path, prefix) for prefix in protected):
            raise PromotionError("worker snapshot touches a protected path")
    evidence = attempt.get("evidence") or {}
    changes = evidence.get("changes") or {}
    if snapshot.get("filesChanged") != changes.get("filesChanged"):
        raise PromotionError("worker snapshot file count differs from accepted evidence")
    if snapshot.get("bytesChanged") != changes.get("bytesChanged"):
        raise PromotionError("worker snapshot byte count differs from accepted evidence")
    actual = worker_snapshot_fingerprint(
        pipeline_id=str(task.get("pipelineId") or ""),
        attempt=int(attempt.get("attempt") or 0),
        assignee=str(attempt.get("assignee") or ""),
        base_revision=base_revision,
        files=files,
    )
    if actual != evidence.get("workerReceiptFingerprint"):
        raise PromotionError("worker snapshot fingerprint differs from accepted evidence")
    return actual


def load_config(path: Path) -> dict[str, Any]:
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PromotionError("promotion configuration is unavailable") from exc
    promotion = config.get("promotion") if isinstance(config, dict) else None
    if not isinstance(promotion, dict) or promotion.get("enabled") is not True:
        raise PromotionError("accepted-result promotion is disabled")
    if promotion.get("mode") != "accepted-review-to-pr":
        raise PromotionError("accepted-result promotion mode is unsupported")
    if promotion.get("maxPerRun") != 1:
        raise PromotionError("accepted-result promotion must remain single-item")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/AgentX", str(promotion.get("repository") or ""), re.I) or promotion.get("baseBranch") != "main":
        raise PromotionError("accepted-result promotion repository identity is invalid")
    if promotion.get("branchPrefix") != "agentx/coding-task-":
        raise PromotionError("accepted-result promotion branch prefix is invalid")
    if not PurePosixPath(str(promotion.get("receiptRoot") or "")).is_absolute() or ".." in PurePosixPath(str(promotion.get("receiptRoot") or "")).parts:
        raise PromotionError("accepted-result promotion receipt root is invalid")
    return config


def api_json(
    api_base: str,
    path: str,
    *,
    ca_file: str | None,
    method: str = "GET",
    payload: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    base = api_base.rstrip("/") + "/"
    parsed = urlparse(base)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise PromotionError("pipeline API base is invalid")
    origin = f"{parsed.scheme}://{parsed.netloc}"
    body = canonical_json(payload) if payload is not None else None
    headers = {
        "Accept": "application/json",
        "Origin": origin,
        "Referer": origin + "/pipeline",
        "Sec-Fetch-Site": "same-origin",
    }
    if body is not None:
        headers["Content-Type"] = "application/json"
    context = ssl.create_default_context(cafile=ca_file) if parsed.scheme == "https" else None
    try:
        with urlopen(
            Request(urljoin(base, path.lstrip("/")), data=body, headers=headers, method=method),
            timeout=30,
            context=context,
        ) as response:
            result = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        raise PromotionError("pipeline API request failed") from exc
    if not isinstance(result, dict) or result.get("ok") is not True:
        raise PromotionError("pipeline API returned an unsuccessful envelope")
    return result


def list_tasks(api_base: str, *, ca_file: str | None) -> list[dict[str, Any]]:
    query = urlencode({"includeDone": "true", "limit": "1000"})
    result = api_json(api_base, f"/api/pipeline/tasks?{query}", ca_file=ca_file)
    tasks = (result.get("data") or {}).get("tasks")
    if not isinstance(tasks, list):
        raise PromotionError("pipeline task list is unavailable")
    return [task for task in tasks if isinstance(task, dict)]


def promotion_marker(pipeline_id: str, attempt: int) -> str:
    return f"{PROMOTION_SCHEMA} task={pipeline_id} attempt={attempt}"


def feedback_already_recorded(task: Mapping[str, Any], marker: str) -> bool:
    return any(
        marker in str(entry.get("text") or "")
        for entry in (task.get("feedback") or [])
        if isinstance(entry, dict)
    )


def post_promotion_feedback(
    api_base: str,
    pipeline_id: str,
    attempt: int,
    *,
    pr_url: str,
    ca_file: str | None,
) -> None:
    marker = promotion_marker(pipeline_id, attempt)
    text = (
        f"{marker}\n"
        f"Verified worker snapshot published as {pr_url}. Full PR CI was dispatched. "
        "Deployment uses the same AgentX launcher after merge and keeps its own runtime receipt."
    )
    api_json(
        api_base,
        f"/api/pipeline/tasks/{pipeline_id}/feedback",
        ca_file=ca_file,
        method="POST",
        payload={"by": "coding-promotion", "text": text},
    )


def receipt_path(root: Path, pipeline_id: str, attempt: int) -> Path:
    return root / f"{pipeline_id}-attempt-{attempt}.json"


def write_receipt(path: Path, receipt: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path.parent, 0o700)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(receipt, handle, separators=(",", ":"), sort_keys=True)
            handle.write("\n")
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        if temporary.exists():
            temporary.unlink()


def read_receipt(path: Path, pipeline_id: str, attempt: int) -> dict[str, Any]:
    try:
        metadata = path.stat()
        if hasattr(os, "geteuid") and metadata.st_uid != os.geteuid():
            raise PromotionError("promotion receipt has an unexpected owner")
        if stat.S_IMODE(metadata.st_mode) & 0o077:
            raise PromotionError("promotion receipt permissions are too broad")
        receipt = json.loads(path.read_text(encoding="utf-8"))
    except PromotionError:
        raise
    except (OSError, json.JSONDecodeError) as exc:
        raise PromotionError("promotion receipt is unreadable") from exc
    if (
        not isinstance(receipt, dict)
        or receipt.get("schema") != PROMOTION_SCHEMA
        or receipt.get("pipelineId") != pipeline_id
        or receipt.get("attempt") != attempt
        or receipt.get("state") not in {"prepared", "complete"}
    ):
        raise PromotionError("promotion receipt identity is invalid")
    return receipt


@contextmanager
def git_credentials(token: str):
    if len(token) < 20:
        raise PromotionError("GitHub workflow credential is unavailable")
    descriptor, raw_path = tempfile.mkstemp(prefix="agentx-git-askpass-")
    helper = Path(raw_path)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(
                "#!/bin/sh\n"
                "case \"$1\" in\n"
                "  *Username*) printf '%s\\n' 'x-access-token' ;;\n"
                "  *Password*) printf '%s\\n' \"$GH_TOKEN\" ;;\n"
                "  *) exit 1 ;;\n"
                "esac\n"
            )
        helper.chmod(stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
        environment = dict(os.environ)
        environment.update({
            "GH_TOKEN": token,
            "GIT_ASKPASS": str(helper),
            "GIT_TERMINAL_PROMPT": "0",
        })
        yield environment
    finally:
        helper.unlink(missing_ok=True)


def github_api(
    repository: str,
    path: str,
    *,
    env: Mapping[str, str],
    method: str = "GET",
    payload: Mapping[str, Any] | None = None,
    expected_status: int = 200,
) -> Any:
    token = str(env.get("GH_TOKEN") or "").strip()
    if len(token) < 20:
        raise PromotionError("GitHub token is unavailable")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise PromotionError("GitHub repository identity is invalid")

    data = canonical_json(payload) if payload is not None else None
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "User-Agent": "agentx-coding-team-promotion",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = Request(
        f"https://api.github.com/repos/{repository}/{path.lstrip('/')}",
        data=data,
        headers=headers,
        method=method,
    )
    try:
        with urlopen(request, timeout=30) as response:
            status = int(getattr(response, "status", response.getcode()))
            raw = response.read()
    except HTTPError as exc:
        raise PromotionError(f"GitHub API {method} returned HTTP {exc.code}") from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise PromotionError(f"GitHub API {method} request failed") from exc
    if status != expected_status:
        raise PromotionError(
            f"GitHub API {method} returned unexpected HTTP {status}"
        )
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise PromotionError("GitHub API returned invalid JSON") from exc


def normalize_pr(row: Mapping[str, Any]) -> dict[str, Any]:
    number = row.get("number")
    url = str(row.get("html_url") or "")
    state = str(row.get("state") or "").upper()
    head = row.get("head") if isinstance(row.get("head"), Mapping) else {}
    head_sha = str(head.get("sha") or "")
    body = str(row.get("body") or "")
    if (
        not isinstance(number, int)
        or isinstance(number, bool)
        or number < 1
        or not re.fullmatch(r"https://github\.com/[^/]+/[^/]+/pull/[0-9]+", url)
        or state not in {"OPEN", "CLOSED"}
        or not COMMIT_PATTERN.fullmatch(head_sha)
    ):
        raise PromotionError("GitHub returned an invalid pull request identity")
    return {
        "number": number,
        "url": url,
        "state": state,
        "headRefOid": head_sha,
        "body": body,
    }


def existing_pr(repository: str, branch: str, *, env: Mapping[str, str]) -> dict[str, Any] | None:
    owner = repository.split("/", 1)[0]
    query = urlencode({"state": "all", "head": f"{owner}:{branch}", "per_page": "2"})
    rows = github_api(repository, f"pulls?{query}", env=env)
    if not isinstance(rows, list):
        raise PromotionError("GitHub returned an invalid pull request list")
    if len(rows) > 1:
        raise PromotionError("multiple pull requests exist for the deterministic promotion branch")
    return normalize_pr(rows[0]) if rows else None


def remote_branch_sha(repo: Path, branch: str, *, env: Mapping[str, str]) -> str | None:
    output = run_command(
        ["git", "-C", str(repo), "ls-remote", "--heads", "origin", f"refs/heads/{branch}"],
        env=env,
    ).stdout.strip()
    if not output:
        return None
    sha = output.split()[0]
    if not COMMIT_PATTERN.fullmatch(sha):
        raise PromotionError("remote promotion branch identity is invalid")
    return sha


def commit_has_receipt(repo: Path, sha: str, fingerprint: str, *, env: Mapping[str, str]) -> bool:
    run_command(
        ["git", "-C", str(repo), "fetch", "--quiet", "origin", sha],
        env=env,
    )
    body = git_output(repo, ["show", "-s", "--format=%B", sha])
    return f"AgentX-Worker-Receipt: {fingerprint}" in body


def create_commit(
    repo: Path,
    files: Mapping[str, bytes],
    *,
    branch: str,
    base_revision: str,
    pipeline_id: str,
    attempt: int,
    fingerprint: str,
    env: Mapping[str, str],
) -> str:
    temp_root = Path(tempfile.mkdtemp(prefix="agentx-coding-promotion-"))
    added = False
    try:
        run_command(
            ["git", "-C", str(repo), "worktree", "add", "--detach", str(temp_root), base_revision],
            env=env,
        )
        added = True
        run_command(["git", "-C", str(temp_root), "switch", "-c", branch], env=env)
        for relative, content in files.items():
            target = temp_root.joinpath(*PurePosixPath(relative).parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        run_command(["git", "-C", str(temp_root), "add", "--all", "--", *sorted(files)], env=env)
        run_command(["git", "-C", str(temp_root), "diff", "--cached", "--check"], env=env)
        run_command(["git", "-C", str(temp_root), "config", "user.name", "AgentX Coding Team"], env=env)
        run_command(
            ["git", "-C", str(temp_root), "config", "user.email", "coding-team@users.noreply.github.com"],
            env=env,
        )
        message = (
            f"chore(coding-team): promote task {pipeline_id} attempt {attempt}\n\n"
            f"AgentX-Pipeline-Task: {pipeline_id}\n"
            f"AgentX-Attempt: {attempt}\n"
            f"AgentX-Worker-Receipt: {fingerprint}"
        )
        run_command(["git", "-C", str(temp_root), "commit", "-m", message], env=env)
        sha = git_output(temp_root, ["rev-parse", "HEAD"])
        run_command(
            ["git", "-C", str(temp_root), "push", "origin", f"HEAD:refs/heads/{branch}"],
            env=env,
        )
        return sha
    finally:
        if added:
            subprocess.run(
                ["git", "-C", str(repo), "worktree", "remove", "--force", str(temp_root)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=60,
                check=False,
            )
        if temp_root.exists():
            shutil.rmtree(temp_root)
        subprocess.run(
            ["git", "-C", str(repo), "branch", "-D", branch],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
            check=False,
        )


def build_agentic_pre_review(
    *,
    pipeline_id: str,
    attempt: int,
    fingerprint: str,
    files_changed: int,
    policy_ref: str,
) -> str:
    if not PIPELINE_ID_PATTERN.fullmatch(pipeline_id):
        raise PromotionError("pre-review pipeline id is invalid")
    if not isinstance(attempt, int) or isinstance(attempt, bool) or attempt < 1:
        raise PromotionError("pre-review attempt is invalid")
    if not FINGERPRINT_PATTERN.fullmatch(fingerprint):
        raise PromotionError("pre-review worker receipt is invalid")
    if not isinstance(files_changed, int) or isinstance(files_changed, bool) or files_changed < 1:
        raise PromotionError("pre-review file count is invalid")
    if policy_ref != "agentx.reviewed-code/v1":
        raise PromotionError("pre-review policy is unsupported")
    noun = "file" if files_changed == 1 else "files"
    return (
        f"{PRE_REVIEW_MARKER}\n"
        "## Agentic pre-review (advisory)\n\n"
        f"- **Summary:** Human-accepted task `{pipeline_id}` attempt `{attempt}` changes "
        f"`{files_changed}` {noun} within its approved scope.\n"
        "- **Tests / evidence:** The independent verifier passed; sealed worker receipt "
        f"`{fingerprint}` binds the accepted snapshot. Exact-branch PR CI is dispatched separately.\n"
        f"- **Risks:** Constrained by reviewed low-risk policy `{policy_ref}`; a human must still "
        "inspect the diff and CI result.\n"
        "- **Recommendation:** **MERGE** only when exact-branch PR CI is fully green and the human "
        "accepts the diff; otherwise **CORRECT**.\n\n"
        "**Human action:** review the diff and CI, then choose merge or correction. This pre-review "
        "cannot approve, merge, deploy, or start another worker."
    )


def create_pr(
    repository: str,
    branch: str,
    pipeline_id: str,
    attempt: int,
    fingerprint: str,
    *,
    files_changed: int,
    policy_ref: str,
    env: Mapping[str, str],
) -> dict[str, Any]:
    pre_review = build_agentic_pre_review(
        pipeline_id=pipeline_id,
        attempt=attempt,
        fingerprint=fingerprint,
        files_changed=files_changed,
        policy_ref=policy_ref,
    )
    body = (
        "Automated promotion of one independently verified and human-accepted "
        "Coding Team result.\n\n"
        f"- Pipeline task: `{pipeline_id}`\n"
        f"- Attempt: `{attempt}`\n"
        f"- Worker receipt: `{fingerprint}`\n"
        "- Validation: the existing AgentX PR CI runs on this branch\n\n"
        "No task prompt, model transcript, tool payload, credential, or host identity is included. "
        "Deployment uses the same AgentX launcher after merge and keeps its own runtime receipt.\n\n"
        f"{pre_review}"
    )
    row = github_api(
        repository,
        "pulls",
        env=env,
        method="POST",
        payload={
            "title": f"chore(coding-team): promote task {pipeline_id} attempt {attempt}",
            "head": branch,
            "base": "main",
            "body": body,
            "draft": True,
        },
        expected_status=201,
    )
    if not isinstance(row, Mapping):
        raise PromotionError("GitHub returned an invalid pull request")
    pr = normalize_pr(row)
    if PRE_REVIEW_MARKER not in pr["body"]:
        raise PromotionError("GitHub pull request omitted the agentic pre-review")
    return pr


def stash_worker_snapshot(repo: Path, paths: Iterable[str], pipeline_id: str, attempt: int) -> None:
    if not git_output(repo, ["status", "--porcelain"]):
        return
    run_command([
        "git", "-C", str(repo), "stash", "push", "--include-untracked",
        "-m", f"accepted-promoted-{pipeline_id}-attempt-{attempt}", "--", *sorted(paths),
    ])
    if git_output(repo, ["status", "--porcelain"]):
        raise PromotionError("worker checkout is not clean after preserving the promoted snapshot")


def validate_prepared_publication(
    receipt: Mapping[str, Any],
    task: Mapping[str, Any],
    attempt: Mapping[str, Any],
    worker_repo: Path,
    repository: str,
    branch: str,
    *,
    env: Mapping[str, str],
) -> dict[str, Any]:
    fingerprint = str((attempt.get("evidence") or {}).get("workerReceiptFingerprint") or "")
    pre_review = receipt.get("preReview")
    if pre_review is not None and (
        not isinstance(pre_review, Mapping)
        or pre_review.get("schema") != PRE_REVIEW_SCHEMA
    ):
        raise PromotionError("prepared promotion pre-review identity is invalid")
    expected_pr = receipt.get("pullRequest")
    commit_sha = str(receipt.get("commit") or "")
    if (
        receipt.get("workerReceiptFingerprint") != fingerprint
        or receipt.get("branch") != branch
        or not COMMIT_PATTERN.fullmatch(commit_sha)
        or not isinstance(expected_pr, dict)
    ):
        raise PromotionError("prepared promotion receipt differs from accepted evidence")
    remote_sha = remote_branch_sha(worker_repo, branch, env=env)
    pr = existing_pr(repository, branch, env=env)
    if remote_sha != commit_sha or pr is None:
        raise PromotionError("prepared promotion publication is incomplete")
    if (
        pr.get("number") != expected_pr.get("number")
        or pr.get("url") != expected_pr.get("url")
        or pr.get("headRefOid") != commit_sha
        or fingerprint not in str(pr.get("body") or "")
        or (pre_review is not None and PRE_REVIEW_MARKER not in str(pr.get("body") or ""))
        or not commit_has_receipt(worker_repo, commit_sha, fingerprint, env=env)
    ):
        raise PromotionError("prepared promotion publication failed identity validation")
    return pr


def promote(args: argparse.Namespace) -> dict[str, Any]:
    config = load_config(args.config.resolve())
    promotion = config["promotion"]
    repository = promotion["repository"]
    if args.repository and args.repository != repository:
        raise PromotionError("workflow repository differs from reviewed promotion configuration")
    profile = (config.get("executionProfiles") or {}).get("clawdx-file-tools/v1")
    verification = (config.get("verificationProfiles") or {}).get("agentx-dispatcher-tests/v1")
    if not isinstance(profile, dict) or not isinstance(verification, dict):
        raise PromotionError("reviewed worker or verification profile is unavailable")
    worker_repo = Path(profile.get("remoteRepo") or "").resolve()
    expected_name = "workspace-" + str(profile.get("agent") or "")
    if not any(parent.name == expected_name and parent.parent.name == ".openclaw" for parent in worker_repo.parents):
        raise PromotionError("worker repository is outside the reviewed workspace")
    tasks = list_tasks(config["apiBase"], ca_file=args.ca_file)
    candidates = eligible_candidates(tasks)
    if args.task_id:
        if not PIPELINE_ID_PATTERN.fullmatch(args.task_id):
            raise PromotionError("requested promotion task id is invalid")
        candidates = [pair for pair in candidates if pair[0].get("pipelineId") == args.task_id]
    receipt_root = Path(promotion["receiptRoot"]).resolve()
    pending = []
    for task, attempt in candidates:
        pipeline_id = str(task["pipelineId"])
        attempt_number = int(attempt["attempt"])
        path = receipt_path(receipt_root, pipeline_id, attempt_number)
        existing_receipt = read_receipt(path, pipeline_id, attempt_number) if path.exists() else None
        if existing_receipt is None or existing_receipt.get("state") != "complete":
            pending.append((task, attempt, path, existing_receipt))
    if not pending:
        return {"schema": PROMOTION_SCHEMA, "status": "no_eligible_accepted_result"}
    if len(pending) > promotion["maxPerRun"] and not all(item[1].get("evidence", {}).get("repository") for item in pending):
        raise PromotionError("multiple accepted results await one shared worker checkout")
    task, attempt, receipt_file, prepared_receipt = pending[0]
    pipeline_id = str(task["pipelineId"])
    attempt_number = int(attempt["attempt"])
    branch = f"{promotion['branchPrefix']}{pipeline_id}-attempt-{attempt_number}"
    worker_repo = Path(promotion_workspace(profile, task, attempt, PromotionError)).resolve()
    token = os.environ.get(args.github_token_env, "").strip()
    worker_clean = not git_output(worker_repo, ["status", "--porcelain"])
    if prepared_receipt is not None and worker_clean:
        with git_credentials(token) as environment:
            pr = validate_prepared_publication(
                prepared_receipt,
                task,
                attempt,
                worker_repo,
                repository,
                branch,
                env=environment,
            )
        if not feedback_already_recorded(task, promotion_marker(pipeline_id, attempt_number)):
            post_promotion_feedback(
                config["apiBase"],
                pipeline_id,
                attempt_number,
                pr_url=pr["url"],
                ca_file=args.ca_file,
            )
        complete_receipt = {**prepared_receipt, "state": "complete"}
        write_receipt(receipt_file, complete_receipt)
        return {**complete_receipt, "status": "reconciled"}
    if worker_clean:
        raise PromotionError("accepted worker snapshot is unavailable")
    base_revision = git_output(worker_repo, ["rev-parse", "HEAD"])
    if not COMMIT_PATTERN.fullmatch(base_revision):
        raise PromotionError("worker checkout base revision is invalid")
    snapshot = changed_snapshot(worker_repo)
    fingerprint = validate_candidate_snapshot(
        task, attempt, snapshot, config, base_revision=base_revision
    )
    with git_credentials(token) as environment:
        origin = git_output(worker_repo, ["remote", "get-url", "origin"])
        repository_slug = repository.lower()
        if repository_slug not in origin.lower().replace(".git", ""):
            raise PromotionError("worker Git origin differs from reviewed repository")
        run_command(
            ["git", "-C", str(worker_repo), "fetch", "--quiet", "origin", promotion["baseBranch"]],
            env=environment,
        )
        run_command(
            ["git", "-C", str(worker_repo), "merge-base", "--is-ancestor", base_revision, "origin/main"],
            env=environment,
        )
        verify_output = verify_accepted_snapshot(
            str(profile.get("host") or ""), worker_repo,
            str(verification["command"]), base_revision,
            int(verification.get("timeoutSeconds") or 900),
        )
        remote_sha = remote_branch_sha(worker_repo, branch, env=environment)
        pr = existing_pr(repository, branch, env=environment)
        if remote_sha:
            if not commit_has_receipt(worker_repo, remote_sha, fingerprint, env=environment):
                raise PromotionError("existing promotion branch does not match the accepted worker receipt")
            commit_sha = remote_sha
        else:
            if pr:
                raise PromotionError("pull request exists without its deterministic remote branch")
            commit_sha = create_commit(
                worker_repo,
                snapshot["files"],
                branch=branch,
                base_revision=base_revision,
                pipeline_id=pipeline_id,
                attempt=attempt_number,
                fingerprint=fingerprint,
                env=environment,
            )
        if pr:
            if (
                pr.get("headRefOid") != commit_sha
                or fingerprint not in str(pr.get("body") or "")
                or PRE_REVIEW_MARKER not in str(pr.get("body") or "")
            ):
                raise PromotionError("existing pull request differs from the accepted worker receipt")
        else:
            pr = create_pr(
                repository,
                branch,
                pipeline_id,
                attempt_number,
                fingerprint,
                files_changed=int(snapshot["filesChanged"]),
                policy_ref=str((task.get("automation") or {}).get("policyRef") or ""),
                env=environment,
            )
    receipt = {
        "schema": PROMOTION_SCHEMA,
        "state": "prepared",
        "pipelineId": pipeline_id,
        "attempt": attempt_number,
        "workerReceiptFingerprint": fingerprint,
        "baseRevision": base_revision,
        "commit": commit_sha,
        "branch": branch,
        "pullRequest": {"number": pr["number"], "url": pr["url"]},
        "verification": {
            "status": "passed",
            "commandFingerprint": hashlib.sha256(str(verification["command"]).encode("utf-8")).hexdigest(),
            "outputFingerprint": hashlib.sha256(verify_output.encode("utf-8")).hexdigest(),
        },
        "preReview": {
            "schema": PRE_REVIEW_SCHEMA,
            "recommendation": "merge_after_green_ci_and_human_review_otherwise_correct",
        },
        "ci": {"workflow": "ci.yml", "trigger": "pull_request", "observed": False},
        "humanGatesRemaining": ["merge"],
    }
    write_receipt(receipt_file, receipt)
    stash_worker_snapshot(worker_repo, snapshot["files"].keys(), pipeline_id, attempt_number)
    if not feedback_already_recorded(task, promotion_marker(pipeline_id, attempt_number)):
        post_promotion_feedback(
            config["apiBase"],
            pipeline_id,
            attempt_number,
            pr_url=pr["url"],
            ca_file=args.ca_file,
        )
    receipt["state"] = "complete"
    write_receipt(receipt_file, receipt)
    return {**receipt, "status": "pr_created"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Promote one accepted Coding Team result to a PR")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--ca-file")
    parser.add_argument("--task-id")
    parser.add_argument("--repository")
    parser.add_argument("--github-token-env", default="GH_TOKEN")
    return parser.parse_args()


def main() -> int:
    try:
        print(json.dumps(promote(parse_args()), separators=(",", ":"), sort_keys=True))
        return 0
    except (PromotionError, subprocess.TimeoutExpired) as exc:
        print(json.dumps({
            "schema": PROMOTION_SCHEMA,
            "status": "blocked",
            "reason": str(exc),
        }, separators=(",", ":"), sort_keys=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
