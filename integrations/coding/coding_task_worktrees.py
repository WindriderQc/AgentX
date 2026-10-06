"""Task-bound worker paths; no reset, cleanup or publication authority."""

from pathlib import PurePosixPath
import re
import shlex
import subprocess

try:
    from integrations.coding.coding_dispatch_evidence import PipelineApiError, worker_workspace
except ModuleNotFoundError:
    from coding_dispatch_evidence import PipelineApiError, worker_workspace


def reviewed_profile(profile, error=PipelineApiError):
    repository, agent = str(profile["remoteRepo"]), str(profile["agent"])
    try:
        worker_workspace(repository, agent)
    except PipelineApiError as exc:
        raise error(str(exc)) from exc
    if type(profile.get("taskWorktree", False)) is not bool:
        raise error("taskWorktree must be a boolean")
    return repository, agent


def task_worktree_path(base, task_id):
    if not re.fullmatch(r"[0-9]{1,16}", str(task_id)):
        raise PipelineApiError("task worktree requires an exact numeric pipeline id")
    root = PurePosixPath(base)
    if not root.is_absolute() or ".." in root.parts:
        raise PipelineApiError("task worktree base must be an absolute native path")
    return str(root.parent / "coding-tasks" / f"{root.name}-task-{task_id}")


def task_worktree_base(repository):
    root = PurePosixPath(repository)
    match = re.fullmatch(r"(.+)-task-([0-9]{1,16})", root.name)
    if root.parent.name == "coding-tasks" and match:
        return str(root.parent.parent / match[1])
    return None


def prepare_remote_worktree(ssh_run, host, base, task_id, revision, agent, *, allow_create=True):
    target = task_worktree_path(base, task_id)
    worker_workspace(target, agent)
    if not re.fullmatch(r"[0-9a-f]{40}", str(revision)):
        raise PipelineApiError("task worktree revision is invalid")
    repository, destination = shlex.quote(base), shlex.quote(target)
    parent = shlex.quote(str(PurePosixPath(target).parent))
    create = (f"mkdir -p {parent} && git -C {repository} worktree add --quiet --detach {destination} {shlex.quote(revision)}"
        if allow_create else "false")
    command = (
        f"test ! -L {parent} && test ! -L {destination} && "
        f"if test -e {destination}; then "
        f'test -f {destination}/.git && '
        f'test "$(git -C {destination} rev-parse --show-toplevel)" = {destination} && '
        f'test "$(git -C {destination} rev-parse --path-format=absolute --git-common-dir)" = '
        f'"$(git -C {repository} rev-parse --path-format=absolute --git-common-dir)" && '
        f'test "$(git -C {destination} rev-parse HEAD)" = {shlex.quote(revision)}; '
        f"else {create}; fi && "
        f"if test -d {repository}/core/node_modules; then "
        f"test ! -L {destination}/core && test ! -L {destination}/core/node_modules && mkdir -p {destination}/core/node_modules; fi"
    )
    result = ssh_run(host, command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
    if result.returncode:
        raise PipelineApiError("task worktree is missing, foreign or at another base; no checkout was reset")
    return target


def node_dependency_mount(repository):
    base = task_worktree_base(repository)
    if not base:
        return "", []
    quoted_base, quoted_repo = shlex.quote(base), shlex.quote(repository)
    # Use the operator installation, never worker-controlled dependency files.
    # Its tracked lock must match the task base. bwrap mounts it read-only.
    prefix = (
        f'test -z "$(git -C {quoted_base} status --porcelain=v1)" && '
        f'test -d {quoted_base}/core/node_modules && test ! -L {quoted_repo}/core/node_modules && '
        f'git -C {quoted_base} cat-file -e HEAD:core/package-lock.json && '
        f'git -C {quoted_repo} cat-file -e HEAD:core/package-lock.json && '
        f'test "$(git -C {quoted_base} show HEAD:core/package-lock.json | sha256sum)" = '
        f'"$(git -C {quoted_repo} show HEAD:core/package-lock.json | sha256sum)" && '
    )
    return prefix, ["--ro-bind", f"{base}/core/node_modules", "/workspace/core/node_modules"]
