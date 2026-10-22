#!/usr/bin/env python3
"""Isolated Git workspaces and bounded code-step artifacts.

This module deliberately moves only a finished Git commit.  A runner's working
tree, index, checkpoints, and harness state remain on the runner's host.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import stat
import subprocess
import tempfile


SHA1 = re.compile(r"^[0-9a-f]{40}$")
DEFAULT_MAX_BUNDLE_BYTES = 8 * 1024 * 1024
HARD_MAX_BUNDLE_BYTES = 64 * 1024 * 1024
EXPORT_REF_PREFIX = "refs/agentx-code-steps/export/"
IMPORT_REF_PREFIX = "refs/agentx-code-steps/import/"


class WorkspaceError(RuntimeError):
    """The requested isolated workspace operation is not safe."""


class ArtifactError(WorkspaceError):
    """A commit artifact failed identity, size, or scope verification."""


def _git(repository: Path, *args: str, input_bytes: bytes | None = None) -> bytes:
    environment = os.environ.copy()
    environment.update({
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_TERMINAL_PROMPT": "0",
        "LC_ALL": "C",
    })
    command = ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
               "-C", str(repository), *args]
    result = subprocess.run(command, input=input_bytes, capture_output=True, env=environment)
    if result.returncode:
        detail = result.stderr.decode("utf-8", "replace").strip()
        raise WorkspaceError(f"Git command failed ({' '.join(args)}): {detail}")
    return result.stdout


def _commit(value: str, label: str) -> str:
    if not isinstance(value, str) or not SHA1.fullmatch(value):
        raise WorkspaceError(f"{label} must be a full lowercase SHA-1 commit id")
    return value


def _existing_repository(repository: str | os.PathLike[str]) -> Path:
    path = Path(repository).resolve(strict=True)
    if not path.is_dir():
        raise WorkspaceError("repository must be a directory")
    try:
        _git(path, "rev-parse", "--git-dir")
    except WorkspaceError as error:
        raise WorkspaceError(f"not a Git repository: {path}") from error
    return path


def _resolve_commit(repository: Path, value: str, label: str) -> str:
    expected = _commit(value, label)
    try:
        actual = _git(repository, "rev-parse", "--verify", f"{expected}^{{commit}}") \
            .decode().strip()
    except WorkspaceError as error:
        raise WorkspaceError(f"{label} is not available as a commit") from error
    if actual != expected:
        raise WorkspaceError(f"{label} did not resolve exactly")
    return actual


def refresh_public_heads(repository: str | os.PathLike[str]) -> Path:
    """Fetch public branch objects without overwriting private worker refs."""
    repo = _existing_repository(repository)
    _git(repo, "-c", "remote.origin.mirror=false", "fetch", "--prune", "--no-tags", "origin",
         "+refs/heads/*:refs/remotes/origin/*")
    return repo


def _canonical_scope(paths: list[str] | tuple[str, ...]) -> tuple[str, ...]:
    if not isinstance(paths, (list, tuple)) or not paths:
        raise WorkspaceError("allowed_paths must be a non-empty list")
    canonical = []
    for value in paths:
        if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
            raise WorkspaceError("allowed paths must be non-empty repository-relative POSIX paths")
        path = PurePosixPath(value)
        if path.is_absolute() or value.endswith("/") or any(part in {"", ".", ".."} for part in path.parts):
            raise WorkspaceError(f"invalid allowed path: {value!r}")
        canonical.append(str(path))
    if len(set(canonical)) != len(canonical):
        raise WorkspaceError("allowed paths must not contain duplicates")
    return tuple(sorted(canonical))


def _changed_paths(repository: Path, parent: str, commit: str) -> tuple[str, ...]:
    raw = _git(repository, "diff", "--name-only", "-z", parent, commit)
    try:
        paths = tuple(sorted(item.decode("utf-8") for item in raw.split(b"\0") if item))
    except UnicodeDecodeError as error:
        raise ArtifactError("commit paths must be valid UTF-8") from error
    if not paths:
        raise ArtifactError("code-step commit must change at least one path")
    return paths


def _verify_scope(changed: tuple[str, ...], allowed: tuple[str, ...]) -> None:
    outside = [path for path in changed
               if not any(path == root or path.startswith(root + "/") for root in allowed)]
    if outside:
        raise ArtifactError(f"commit changes paths outside its scope: {', '.join(outside)}")


def _verify_single_commit(repository: Path, expected_parent: str, commit: str,
                          allowed_paths: list[str] | tuple[str, ...]) -> tuple[str, ...]:
    parent = _resolve_commit(repository, expected_parent, "expected_parent")
    child = _resolve_commit(repository, commit, "commit")
    row = _git(repository, "rev-list", "--parents", "-n", "1", child).decode().split()
    if row != [child, parent]:
        raise ArtifactError("artifact commit must be one non-merge commit directly above expected_parent")
    changed = _changed_paths(repository, parent, child)
    _verify_scope(changed, _canonical_scope(allowed_paths))
    return changed


def _bounded_limit(value: int) -> int:
    if type(value) is not int or value <= 0 or value > HARD_MAX_BUNDLE_BYTES:
        raise ArtifactError(f"max_bytes must be between 1 and {HARD_MAX_BUNDLE_BYTES}")
    return value


def _regular_file(path: Path) -> os.stat_result:
    try:
        info = path.lstat()
    except OSError as error:
        raise ArtifactError(f"artifact is unavailable: {path}") from error
    if not stat.S_ISREG(info.st_mode):
        raise ArtifactError("artifact must be a regular file, not a symlink or device")
    return info


def _sha256(path: Path, maximum: int) -> tuple[str, int]:
    digest = hashlib.sha256()
    total = 0
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            total += len(block)
            if total > maximum:
                raise ArtifactError(f"artifact exceeds its {maximum}-byte limit")
            digest.update(block)
    return digest.hexdigest(), total


def prepare_worktree(repository: str | os.PathLike[str], worktree: str | os.PathLike[str],
                     base_commit: str, branch: str) -> dict:
    """Create a clean branch worktree whose initial HEAD is exactly ``base_commit``.

    An identical already-created worktree is accepted as a replay of a lost reply.
    """
    repo = _existing_repository(repository)
    base = _resolve_commit(repo, base_commit, "base_commit")
    if not isinstance(branch, str) or not branch or branch.startswith("-"):
        raise WorkspaceError("branch is invalid")
    _git(repo, "check-ref-format", "--branch", branch)
    target = Path(worktree).absolute()
    if target.exists():
        try:
            head = _git(target, "rev-parse", "--verify", "HEAD").decode().strip()
            actual_branch = _git(target, "symbolic-ref", "--short", "HEAD").decode().strip()
            clean = not _git(target, "status", "--porcelain=v1", "-z")
        except WorkspaceError as error:
            raise WorkspaceError("existing worktree cannot be reconciled") from error
        if head != base or actual_branch != branch or not clean:
            raise WorkspaceError("existing worktree does not match the exact clean preparation request")
        return {"schemaVersion": 1, "baseCommit": base, "branch": branch,
                "worktree": str(target), "replayed": True}
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    reference = f"refs/heads/{branch}"
    branch_exists = subprocess.run(
        ["git", "-C", str(repo), "show-ref", "--verify", "--quiet", reference],
        env={**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"},
    ).returncode == 0
    if branch_exists:
        branch_head = _git(repo, "rev-parse", "--verify", reference).decode().strip()
        if branch_head != base:
            raise WorkspaceError("existing branch is not at the requested exact parent")
        _git(repo, "worktree", "add", str(target), branch)
    else:
        _git(repo, "worktree", "add", "-b", branch, str(target), base)
    head = _git(target, "rev-parse", "--verify", "HEAD").decode().strip()
    if head != base or _git(target, "status", "--porcelain=v1", "-z"):
        raise WorkspaceError("prepared worktree did not preserve the exact clean parent")
    return {"schemaVersion": 1, "baseCommit": base, "branch": branch,
            "worktree": str(target), "replayed": False}


def export_commit(worktree: str | os.PathLike[str], artifact_path: str | os.PathLike[str],
                  expected_parent: str, commit: str, allowed_paths: list[str] | tuple[str, ...],
                  max_bytes: int = DEFAULT_MAX_BUNDLE_BYTES) -> dict:
    """Export one verified child commit as a bounded, content-addressed Git bundle."""
    repo = _existing_repository(worktree)
    maximum = _bounded_limit(max_bytes)
    changed = _verify_single_commit(repo, expected_parent, commit, allowed_paths)
    destination = Path(artifact_path).absolute()
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    token = secrets.token_hex(12)
    bundle_ref = f"{EXPORT_REF_PREFIX}{token}"
    temporary = None
    _git(repo, "update-ref", bundle_ref, commit, "0" * 40)
    try:
        with tempfile.NamedTemporaryFile(prefix=".code-step-", suffix=".bundle",
                                         dir=destination.parent, delete=False) as output:
            temporary = Path(output.name)
        temporary.unlink()
        _git(repo, "bundle", "create", str(temporary), bundle_ref, f"^{expected_parent}")
        _regular_file(temporary)
        digest, size = _sha256(temporary, maximum)
        os.chmod(temporary, 0o600)
        with temporary.open("rb") as handle:
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
        temporary = None
        directory = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        _git(repo, "update-ref", "-d", bundle_ref)
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return {"schemaVersion": 1, "kind": "git-bundle", "parentCommit": expected_parent,
            "commit": commit, "changedPaths": list(changed), "allowedPaths": list(_canonical_scope(allowed_paths)),
            "bundleRef": bundle_ref, "sha256": digest, "size": size}


def import_bundle(repository: str | os.PathLike[str], artifact_path: str | os.PathLike[str],
                  *, expected_sha256: str, expected_size: int, expected_parent: str,
                  commit: str, allowed_paths: list[str] | tuple[str, ...],
                  max_bytes: int = DEFAULT_MAX_BUNDLE_BYTES) -> dict:
    """Verify and import exactly the declared commit without checking out runner state."""
    repo = _existing_repository(repository)
    maximum = _bounded_limit(max_bytes)
    parent = _resolve_commit(repo, expected_parent, "expected_parent")
    child = _commit(commit, "commit")
    if not isinstance(expected_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_sha256):
        raise ArtifactError("expected_sha256 must be a lowercase SHA-256 digest")
    if type(expected_size) is not int or expected_size <= 0 or expected_size > maximum:
        raise ArtifactError("expected_size is outside the artifact bound")
    artifact = Path(artifact_path).absolute()
    info = _regular_file(artifact)
    if info.st_size != expected_size:
        raise ArtifactError("artifact size does not match its receipt")
    digest, size = _sha256(artifact, maximum)
    if digest != expected_sha256:
        raise ArtifactError("artifact digest does not match its receipt")
    _git(repo, "bundle", "verify", str(artifact))
    heads = [line.split(maxsplit=1) for line in
             _git(repo, "bundle", "list-heads", str(artifact)).decode().splitlines()]
    if len(heads) != 1 or len(heads[0]) != 2 or heads[0][0] != child \
            or not heads[0][1].startswith(EXPORT_REF_PREFIX):
        raise ArtifactError("bundle does not contain exactly the declared code-step commit")
    import_ref = f"{IMPORT_REF_PREFIX}{secrets.token_hex(12)}"
    try:
        _git(repo, "fetch", "--no-tags", "--no-write-fetch-head", str(artifact),
             f"{heads[0][1]}:{import_ref}")
        imported = _git(repo, "rev-parse", "--verify", f"{import_ref}^{{commit}}").decode().strip()
        if imported != child:
            raise ArtifactError("fetched bundle ref did not resolve to the declared commit")
        row = _git(repo, "rev-list", "--parents", "-n", "1", child).decode().split()
        if row != [child, parent]:
            raise ArtifactError("imported commit is not one direct child of expected_parent")
        changed = _verify_single_commit(repo, parent, child, allowed_paths)
    finally:
        try:
            _git(repo, "update-ref", "-d", import_ref)
        except WorkspaceError:
            pass
    return {"schemaVersion": 1, "kind": "git-bundle", "parentCommit": parent,
            "commit": child, "changedPaths": list(changed),
            "allowedPaths": list(_canonical_scope(allowed_paths)),
            "bundleRef": heads[0][1], "sha256": digest, "size": size}


def commit_paths(repository: str | os.PathLike[str], expected_parent: str, commit: str,
                 allowed_paths: list[str] | tuple[str, ...]) -> tuple[str, ...]:
    """Public verification used immediately before adopting an imported commit."""
    return _verify_single_commit(_existing_repository(repository), expected_parent, commit, allowed_paths)
