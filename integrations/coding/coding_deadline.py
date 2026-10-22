"""Bound runner-owned local work and source observation by monotonic deadlines."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import signal
import stat
import subprocess
import tempfile
import time


class CodingDeadlineExceeded(RuntimeError):
    """A runner-owned subprocess exhausted its caller's monotonic deadline."""


class SourceDeadlineExceeded(RuntimeError):
    """Source hashing exhausted its caller-owned monotonic deadline."""


def deadline_timeout(deadline, maximum: float) -> float:
    if deadline is None:
        return maximum
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise CodingDeadlineExceeded("Runner-owned deadline exhausted")
    return min(maximum, remaining)


def _source_timeout(deadline) -> float:
    if deadline is None:
        return 30
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise SourceDeadlineExceeded("Source observation deadline exhausted")
    return min(30, remaining)


def git(workspace: Path, *args: str, deadline=None) -> str:
    env = {**os.environ, "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"}
    timeout = _source_timeout(deadline)
    try:
        result = subprocess.run(["git", "-C", str(workspace), "-c", "core.hooksPath=/dev/null",
                                 "-c", "core.fsmonitor=false", *args], env=env, capture_output=True,
                                text=True, check=True, timeout=timeout).stdout
        _source_timeout(deadline)
        return result
    except subprocess.TimeoutExpired as error:
        if deadline is not None and (timeout < 30 or time.monotonic() >= deadline):
            raise SourceDeadlineExceeded("Git source observation exhausted its deadline") from error
        raise


def source_state(workspace: Path, ignored, *, deadline=None) -> str:
    """Hash source content, ignoring mtimes, generated caches and external links."""
    paths = git(workspace, "ls-files", "-z", "--cached", "--others", "--exclude-standard",
                deadline=deadline).split("\0")
    digest = hashlib.sha256()
    for name in sorted(set(paths)):
        _source_timeout(deadline)
        if not name or ignored(name):
            continue
        path = workspace / name
        try:
            info = path.lstat()
            if stat.S_ISREG(info.st_mode) and info.st_size <= 32 * 1024 * 1024:
                kind = b"regular-executable" if info.st_mode & stat.S_IXUSR else b"regular"
                file_digest = hashlib.sha256()
                with path.open("rb") as stream:
                    for block in iter(lambda: stream.read(1024 * 1024), b""):
                        _source_timeout(deadline)
                        file_digest.update(block)
                _source_timeout(deadline)
                content = kind + b"\0" + file_digest.digest()
            elif stat.S_ISLNK(info.st_mode):
                content = b"symlink\0" + os.readlink(path).encode()
            else:
                continue
        except FileNotFoundError:
            content = b"deleted\0"
        digest.update(name.encode() + b"\0" + content)
    _source_timeout(deadline)
    return digest.hexdigest()


def _tail(path: Path, size: int = 6000) -> str:
    with path.open("rb") as stream:
        stream.seek(0, os.SEEK_END)
        stream.seek(max(0, stream.tell() - size))
        return stream.read().decode(errors="replace")


def terminate(process, grace_seconds=30):
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    if grace_seconds <= 0:
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        process.wait()
        return
    try:
        process.wait(timeout=grace_seconds)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()


def supervise(command: list[str], progress=None, home=None, workspace=None, on_stop=None,
              deadline=None) -> subprocess.CompletedProcess:
    """Poll a child within its deadline while retaining raw output outside Git."""
    if progress and progress.path:
        output_root = progress.path.parent / f"{progress.request_id}.output"
        output_root.mkdir(mode=0o700, exist_ok=True)
        directory = Path(tempfile.mkdtemp(prefix=f"{progress.stage}-", dir=output_root))
    else:
        directory = Path(tempfile.mkdtemp(prefix="agentx-coding-output-"))
    stdout, stderr = directory / "stdout", directory / "stderr"
    with stdout.open("wb") as out, stderr.open("wb") as err:
        process = subprocess.Popen(command, stdout=out, stderr=err, start_new_session=True)
        deadline_exhausted = False
        try:
            while process.poll() is None:
                if deadline is not None and time.monotonic() >= deadline:
                    deadline_exhausted = True
                    terminate(process, grace_seconds=0)
                    break
                if progress and progress.tick(home, workspace):
                    if on_stop:
                        on_stop()
                    terminate(process)
                    break
                delay = 2 if deadline is None else min(2, max(0, deadline - time.monotonic()))
                if delay:
                    time.sleep(delay)
        finally:
            if process.poll() is None:
                if on_stop:
                    on_stop()
                terminate(process)
    if deadline_exhausted:
        raise CodingDeadlineExceeded("Supervised command exhausted its runner-owned deadline")
    if progress and home and workspace:
        progress.observe(home, workspace)
    return subprocess.CompletedProcess(command, process.wait(), _tail(stdout), _tail(stderr))
