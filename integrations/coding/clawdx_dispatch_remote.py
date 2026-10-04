"""SSH side of the guarded ClawdX dispatch: remote checkout sync and validation,
worker repository checks, authority sources, worker feedback files and the
independent verification run.
"""

from __future__ import annotations

import os
import re
import shlex
import subprocess
from pathlib import Path, PurePosixPath
from typing import Any

try:
    from integrations.coding.coding_dispatch_evidence import (
        PipelineApiError,
        repository_snapshot_validation_errors,
        worker_workspace,
    )
except ModuleNotFoundError:  # direct execution from the scripts directory
    from coding_dispatch_evidence import (  # type: ignore
        PipelineApiError,
        repository_snapshot_validation_errors,
        worker_workspace,
    )


DEFAULT_REMOTE_SOURCE_REPO = os.environ.get("AGENTX_CODING_SOURCE_REPO", "/srv/agentx/AgentX")
SSH_OPTIONS = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=10",
    "-o",
    "ServerAliveCountMax=3",
]
COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")
REMOTE_PROJECT_MARKERS = (
    "integrations/coding/clawdx-guarded-dispatch.py",
    "integrations/coding/tests/test_coding_dispatcher.py",
)


def synchronize_remote_checkout(
    host: str,
    remote_repo: str,
    revision: str,
    *,
    source_repo: str = DEFAULT_REMOTE_SOURCE_REPO,
) -> None:
    """Advance a clean worker checkout to the exact dispatcher revision.

    This is deliberately non-destructive: dirty or missing workspaces stop
    before the Pipeline claim. A clean checkout may only move to the exact
    commit the clean production checkout is at. The worker never needs a
    GitHub credential for this local transfer.
    """
    if not COMMIT_PATTERN.fullmatch(str(revision or "")):
        raise PipelineApiError("worker checkout target revision is invalid")
    repository = shlex.quote(remote_repo)
    source = shlex.quote(source_repo)
    clean = ssh_run(
        host,
        (
            f'test "$(git -C {repository} rev-parse --is-inside-work-tree 2>/dev/null)" = true && '
            f'test "$(git -C {repository} rev-parse --show-toplevel 2>/dev/null)" = {repository} && '
            f'test -z "$(git -C {repository} status --porcelain=v1)"'
        ),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=30,
    )
    if clean.returncode != 0:
        raise PipelineApiError(
            "remote worker checkout is missing or dirty; refusing source synchronization"
        )

    target = shlex.quote(revision)
    commit_object = shlex.quote(f"{revision}^{{commit}}")
    source_ready = ssh_run(
        host,
        (
            f'test "$(git -C {source} rev-parse --is-inside-work-tree 2>/dev/null)" = true && '
            f'test "$(git -C {source} rev-parse HEAD)" = {target} && '
            f'test -z "$(git -C {source} status --porcelain --untracked-files=no)"'
        ),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=30,
    )
    if source_ready is not None and source_ready.returncode != 0:
        raise PipelineApiError(
            "remote source checkout is not at the exact clean deployed revision"
        )

    synced = ssh_run(
        host,
        (
            f"git -C {repository} fetch --quiet --no-tags {source} {target} && "
            f"git -C {repository} cat-file -e {commit_object} && "
            f"git -C {repository} checkout --quiet --detach {target} && "
            f'test "$(git -C {repository} rev-parse --show-toplevel)" = {repository} && '
            f'test "$(git -C {repository} rev-parse HEAD)" = {target} && '
            f'test -z "$(git -C {repository} status --porcelain=v1)"'
        ),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=120,
    )
    if synced.returncode != 0:
        raise PipelineApiError(
            "remote worker checkout could not reach the exact dispatcher revision"
        )
    print(f"worker_checkout_revision={revision}")


def validate_remote_project_checkout(host: str, remote_repo: str, revision: str, *, repository: str = "agentx") -> None:
    """Prove the worker path is the exact selected project root before claiming."""
    if not COMMIT_PATTERN.fullmatch(str(revision or "")):
        raise PipelineApiError("worker checkout validation revision is invalid")
    if repository != "agentx":
        raise PipelineApiError("Select the canonical AgentX repository")
    markers = (*REMOTE_PROJECT_MARKERS, "core/package.json")
    project = "AgentX"
    repository = shlex.quote(remote_repo)
    target = shlex.quote(revision)
    marker_checks = " && ".join(
        f"git -C {repository} ls-files --error-unmatch {shlex.quote(path)} >/dev/null"
        for path in markers
    )
    proc = ssh_run(
        host,
        (
            f'test "$(git -C {repository} rev-parse --show-toplevel 2>/dev/null)" = {repository} && '
            f'test "$(git -C {repository} rev-parse HEAD 2>/dev/null)" = {target} && '
            f"{marker_checks}"
        ),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=30,
    )
    if proc.returncode != 0:
        raise PipelineApiError(
            f"remote worker project preflight failed: expected exact {project} checkout "
            f"root={remote_repo},revision={revision},markers={','.join(markers)}"
        )
    print(f"worker_project_root={remote_repo}")


def ssh_run(
    host: str,
    command: str,
    *,
    timeout: int = 60,
    **kwargs: Any,
) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["ssh", *SSH_OPTIONS, host, command],
        timeout=timeout,
        **kwargs,
    )


def remote_git_paths(host: str, remote_repo: str, git_args: list[str]) -> set[str]:
    command = " ".join(
        ["git", "-C", shlex.quote(remote_repo)]
        + [shlex.quote(argument) for argument in git_args]
    )
    proc = ssh_run(
        host,
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).decode("utf-8", errors="replace")
        raise PipelineApiError(f"remote git path scan failed: {detail.strip()}")
    return {
        entry.decode("utf-8", errors="strict")
        for entry in proc.stdout.split(b"\0")
        if entry
    }


def remote_git_diff_bytes(host: str, remote_repo: str, git_args: list[str]) -> int:
    command = " ".join(
        ["git", "-C", shlex.quote(remote_repo), "diff", "--binary"]
        + [shlex.quote(argument) for argument in git_args]
    )
    proc = ssh_run(
        host,
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).decode("utf-8", errors="replace")
        raise PipelineApiError(f"remote git diff byte scan failed: {detail.strip()}")
    return len(proc.stdout)


def validate_remote_repo(
    host: str,
    remote_repo: str,
    task: dict[str, Any],
    *,
    max_changed_files: int,
    max_changed_bytes: int,
    exact_scope: set[str] | None = None,
    metrics: dict[str, int] | None = None,
    snapshot: dict[str, Any] | None = None,
    allow_incomplete: bool = False,
) -> list[str]:
    unstaged_paths = remote_git_paths(
        host, remote_repo, ["diff", "--name-only", "-z"]
    )
    staged_paths = remote_git_paths(
        host, remote_repo, ["diff", "--cached", "--name-only", "-z"]
    )
    untracked_paths = remote_git_paths(
        host,
        remote_repo,
        ["ls-files", "--others", "--exclude-standard", "-z"],
    )
    paths = unstaged_paths | staged_paths | untracked_paths

    files: dict[str, bytes] = {}
    for path in sorted(paths):
        parsed = PurePosixPath(path)
        if parsed.is_absolute() or ".." in parsed.parts:
            raise PipelineApiError(f"unsafe changed path reported by git: {path!r}")
        remote_path = f"{remote_repo.rstrip('/')}/{path}"
        proc = ssh_run(
            host,
            f"cat -- {shlex.quote(remote_path)}",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout).decode("utf-8", errors="replace")
            raise PipelineApiError(
                f"could not read changed file {path!r}: {detail.strip()}"
            )
        files[path] = proc.stdout

    diff_check = ssh_run(
        host,
        (
            f"git -C {shlex.quote(remote_repo)} diff --check && "
            f"git -C {shlex.quote(remote_repo)} diff --cached --check"
        ),
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    diff_output = (diff_check.stdout or "") + (diff_check.stderr or "")
    changed_byte_count = (
        remote_git_diff_bytes(host, remote_repo, [])
        + remote_git_diff_bytes(host, remote_repo, ["--cached"])
        + sum(len(files[path]) for path in untracked_paths)
    )
    if metrics is not None:
        metrics.update(
            {
                "filesChanged": len(paths),
                "bytesChanged": changed_byte_count,
            }
        )
    if snapshot is not None:
        snapshot.update(
            {
                "files": files,
                "filesChanged": len(paths),
                "bytesChanged": changed_byte_count,
            }
        )
    return repository_snapshot_validation_errors(
        str(task.get("spec") or ""),
        files,
        max_changed_files=max_changed_files,
        max_changed_bytes=max_changed_bytes,
        exact_scope=exact_scope,
        changed_byte_count=changed_byte_count,
        tracked_diff_check_output=diff_output if diff_check.returncode else "",
        allow_incomplete=allow_incomplete,
    )


def validate_remote_authority_sources(
    host: str,
    remote_repo: str,
    source_files: list[str],
) -> None:
    command = (
        f"git -C {shlex.quote(remote_repo)} ls-files --error-unmatch -- "
        + " ".join(shlex.quote(path) for path in source_files)
    )
    completed = ssh_run(
        host,
        command,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if completed.returncode != 0:
        detail = ((completed.stdout or "") + (completed.stderr or "")).strip()
        raise PipelineApiError(
            "one or more declared authority source files are not tracked in the worker checkout"
            + (f": {detail[-300:]}" if detail else "")
        )


def ensure_remote_repo_clean(host: str, remote_repo: str) -> None:
    proc = ssh_run(
        host,
        f"git -C {shlex.quote(remote_repo)} status --porcelain=v1",
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if proc.returncode != 0:
        raise PipelineApiError(
            f"remote git status failed: {(proc.stderr or proc.stdout).strip()}"
        )
    if proc.stdout.strip():
        raise PipelineApiError(
            "remote worker checkout is dirty; refusing dispatch:\n" + proc.stdout.strip()
        )


def ensure_repo_inside_worker_workspace(remote_repo: str, agent: str) -> None:
    worker_workspace(remote_repo, agent)


def ensure_remote_feedback_absent(host: str, path: str) -> None:
    proc = ssh_run(host, f"test ! -e {shlex.quote(path)}")
    if proc.returncode != 0:
        raise PipelineApiError(
            f"stale worker feedback already exists at {path}; archive it before dispatch"
        )


def archive_remote_feedback(host: str, path: str, stamp: str) -> str:
    archive = f"{path}.attempt-{stamp}"
    proc = ssh_run(
        host,
        (
            f"if test -f {shlex.quote(path)}; then "
            f"mv -- {shlex.quote(path)} {shlex.quote(archive)}; fi"
        ),
    )
    if proc.returncode != 0:
        raise PipelineApiError(
            f"could not archive prior worker feedback from {path}"
        )
    print(f"feedback_archive_if_present={archive}")
    return archive


def read_remote_feedback(host: str, path: str) -> str:
    proc = ssh_run(
        host,
        f"test -f {shlex.quote(path)} && cat {shlex.quote(path)}",
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if proc.returncode != 0 or not proc.stdout.strip():
        raise PipelineApiError(
            f"worker did not produce non-empty structured feedback at {path}"
        )
    return proc.stdout


def run_independent_verification(
    host: str,
    remote_repo: str,
    command: str,
    *,
    expected_revision: str,
    timeout: int,
    output_path: Path | None = None,
) -> tuple[int, str]:
    """Run the operator-selected verifier after the worker stops."""
    if not command.strip():
        raise PipelineApiError(
            "an independent verification command is required for live dispatch"
        )
    if not COMMIT_PATTERN.fullmatch(str(expected_revision or "")):
        raise PipelineApiError("independent verification revision is invalid")
    repository = shlex.quote(remote_repo)
    revision = shlex.quote(expected_revision)
    # The verifier executes worker-controlled source code. Give it the checkout
    # read-only, a disposable /tmp, no network, and no host home or instance
    # mounts. A missing bwrap fails verification instead of falling back.
    node_verifier = command.lstrip().startswith("/node/node ")
    sandbox = [
        "/usr/bin/bwrap", "--die-with-parent", "--unshare-net", "--unshare-pid",
        "--ro-bind", "/usr", "/usr",
        "--ro-bind-try", "/lib", "/lib",
        "--ro-bind-try", "/lib64", "/lib64",
        "--symlink", "usr/bin", "/bin",
        "--symlink", "usr/sbin", "/sbin",
        "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
        "--dir", "/workspace", "--ro-bind", remote_repo, "/workspace",
        "--chdir", "/workspace", "--clearenv",
        "--setenv", "PATH", "/usr/bin:/bin",
        "--setenv", "HOME", "/tmp",
        "--setenv", "PYTHONDONTWRITEBYTECODE", "1",
    ]
    if node_verifier:
        # Bind only the resolved executable. The host's /usr/local/bin/node is
        # a symlink into the operator's home, which must not enter the sandbox.
        sandbox.extend(["--dir", "/node", "--ro-bind", "__HOST_NODE_BIN__", "/node/node"])
    sandbox.extend(["/usr/bin/bash", "-e", "-c", command])
    sandbox_command = " ".join(
        '"$node_bin"' if part == "__HOST_NODE_BIN__" else shlex.quote(part)
        for part in sandbox
    )
    node_prefix = ('node_bin="$(readlink -f /usr/local/bin/node)" && '
                   'test -f "$node_bin" && ') if node_verifier else ''
    proc = ssh_run(
        host,
        (
            f'repository_root="$(git -C {repository} rev-parse --show-toplevel 2>/dev/null)" && '
            f'test "$repository_root" = {repository} && '
            f'test "$(git -C "$repository_root" rev-parse HEAD 2>/dev/null)" = {revision} && '
            f'{node_prefix}{sandbox_command}'
        ),
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
    )
    output = (proc.stdout or "") + (proc.stderr or "")
    if output_path:
        output_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        descriptor = os.open(output_path, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            if hasattr(os, "fchmod"):
                os.fchmod(handle.fileno(), 0o600)
            handle.write(output)
        print(f"verification_output={output_path}")
    return proc.returncode, output


def validate_independent_verification_baseline(
    host: str,
    remote_repo: str,
    command: str,
    *,
    expected_revision: str,
    timeout: int,
) -> None:
    """Prove the exact synchronized checkout can run its verifier pre-claim."""
    returncode, output = run_independent_verification(
        host,
        remote_repo,
        command,
        expected_revision=expected_revision,
        timeout=timeout,
    )
    if returncode != 0:
        summary = output.strip().replace("\n", " ")[-500:]
        raise PipelineApiError(
            "independent verification baseline failed before claim"
            + (f": {summary}" if summary else "")
        )
    print("independent_verification_preflight=pass")
