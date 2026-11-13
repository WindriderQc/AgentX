"""Qualify one source through an actual private filesystem copy and reread.

The temporary copy is removed before success. This is neither whole-archive
acceptance nor evidence of a separate physical storage failure domain.
"""
from __future__ import annotations

from contextlib import contextmanager
import json
import os
from pathlib import Path
import stat
from uuid import uuid4

import archive_preservation as native

CONTRACT = "secretary.archive-restoration/v1"
MAX_FILES = 131
MAX_DEPTH = 32
MAX_DIRECTORIES = 512
NATIVE_PLATFORM = all(hasattr(os, name) for name in ('O_DIRECTORY', 'O_NOFOLLOW')) \
    and all(function in os.supports_dir_fd for function in (os.open, os.mkdir, os.stat, os.unlink, os.rmdir)) \
    and os.scandir in os.supports_fd
DIRECTORY_FLAGS = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0)


class RestorationError(RuntimeError):
    def __init__(self, code="SECRETARY_RESTORATION_INTEGRITY", status=409):
        super().__init__("The selected native filesystem restoration could not be verified")
        self.code, self.status = code, status


def identity(info):
    return info.st_dev, info.st_ino, info.st_mode, info.st_uid


def directory(root_fd, parts, *, create=False):
    fd = os.dup(root_fd)
    try:
        for name in parts:
            if create:
                try:
                    os.mkdir(name, mode=0o700, dir_fd=fd)
                    os.fsync(fd)
                except FileExistsError:
                    pass
            child = os.open(name, DIRECTORY_FLAGS, dir_fd=fd)
            os.close(fd); fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def file_set(files):
    return [[path, len(data), native.digest(data)] for path, (_, _, data) in sorted(files.files.items())]


def set_hash(rows):
    return native.digest(json.dumps(rows, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode())


def layout(files, proof):
    rows = file_set(files)
    if not 3 <= len(rows) <= min(MAX_FILES, 3 + len(proof["attachments"])) \
            or not 1 <= sum(row[1] for row in rows) <= native.MAX_BYTES:
        raise RestorationError("SECRETARY_RESTORATION_TOO_LARGE", 413)
    children = {(): {}}
    for path, _, _ in rows:
        parts = path.split("/")
        if len(parts) > MAX_DEPTH:
            raise RestorationError("SECRETARY_RESTORATION_TOO_LARGE", 413)
        if not path or any(part in ("", ".", "..") for part in parts) or "\\" in path:
            raise RestorationError()
        for index, name in enumerate(parts):
            parent = tuple(parts[:index])
            kind = "file" if index == len(parts) - 1 else "directory"
            prior = children.setdefault(parent, {}).setdefault(name, kind)
            if prior != kind:
                raise RestorationError()
            if kind == "directory":
                children.setdefault(tuple(parts[:index + 1]), {})
        if len(children) - 1 > MAX_DIRECTORIES:
            raise RestorationError("SECRETARY_RESTORATION_TOO_LARGE", 413)
    return rows, children


def check_tree(root_fd, children, previous=None):
    stamps = {}
    for parts, names in children.items():
        fd = directory(root_fd, parts)
        try:
            stamps[parts] = native.stamp(os.fstat(fd))
            found = {}
            with os.scandir(fd) as entries:
                for item in entries:
                    if len(found) >= len(names):
                        raise RestorationError()
                    info = item.stat(follow_symlinks=False)
                    if stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o700:
                        kind = "directory"
                    elif stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1:
                        kind = "file"
                    else:
                        raise RestorationError()
                    found[item.name] = kind
            if found != names:
                raise RestorationError()
        finally:
            os.close(fd)
    if previous is not None and stamps != previous:
        raise RestorationError()
    return stamps


def remove_contents(fd, *, depth=0, visited=None):
    # Cleanup stays anchored to the originally opened private directory. It
    # unlinks symlinks themselves and never follows them outside that tree.
    visited = [0] if visited is None else visited
    if depth > MAX_DEPTH:
        raise RestorationError("SECRETARY_RESTORATION_CLEANUP", 503)
    with os.scandir(fd) as entries:
        for item in entries:
            visited[0] += 1
            if visited[0] > MAX_FILES + MAX_DIRECTORIES:
                raise RestorationError("SECRETARY_RESTORATION_CLEANUP", 503)
            info = item.stat(follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                child = os.open(item.name, DIRECTORY_FLAGS, dir_fd=fd)
                try:
                    if identity(os.fstat(child)) != identity(info):
                        raise RestorationError("SECRETARY_RESTORATION_CLEANUP", 503)
                    remove_contents(child, depth=depth + 1, visited=visited)
                finally:
                    os.close(child)
                current = os.stat(item.name, dir_fd=fd, follow_symlinks=False)
                if identity(current) != identity(info):
                    raise RestorationError("SECRETARY_RESTORATION_CLEANUP", 503)
                os.rmdir(item.name, dir_fd=fd)
            else:
                os.unlink(item.name, dir_fd=fd)
    os.fsync(fd)


@contextmanager
def scratch(source_root):
    # tempfile.gettempdir() probes candidate directories by writing a file.
    # Select and validate the configured location without that preflight write.
    configured = next((os.environ[key] for key in ('TMPDIR', 'TEMP', 'TMP') if os.environ.get(key)), '/tmp')
    base = Path(configured).resolve(strict=True)
    if base.is_relative_to(source_root):
        raise RestorationError("SECRETARY_RESTORATION_LOCATION", 409)
    parent_fd = os.open(base, DIRECTORY_FLAGS)
    root_fd, name, created = None, "agentx-restoration-" + uuid4().hex, False
    try:
        parent_identity = identity(os.fstat(parent_fd))
        os.mkdir(name, mode=0o700, dir_fd=parent_fd); created = True
        root_fd = os.open(name, DIRECTORY_FLAGS, dir_fd=parent_fd)
        root_identity = identity(os.fstat(root_fd))
        if stat.S_IMODE(root_identity[2]) != 0o700 or root_identity[3] != os.geteuid():
            raise RestorationError()
        os.fsync(root_fd); os.fsync(parent_fd)
        path = base / name

        def bound():
            if identity(os.stat(base, follow_symlinks=False)) != parent_identity \
                    or identity(os.stat(path, follow_symlinks=False)) != root_identity \
                    or identity(os.stat(name, dir_fd=parent_fd, follow_symlinks=False)) != root_identity:
                raise RestorationError()

        bound()
        yield path, root_fd, bound
    finally:
        try:
            if created:
                if root_fd is not None:
                    remove_contents(root_fd)
                    if identity(os.stat(name, dir_fd=parent_fd, follow_symlinks=False)) != identity(os.fstat(root_fd)):
                        raise RestorationError("SECRETARY_RESTORATION_CLEANUP", 503)
                os.rmdir(name, dir_fd=parent_fd)
                os.fsync(parent_fd)
                try:
                    os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
                except FileNotFoundError:
                    pass
                else:
                    raise RestorationError("SECRETARY_RESTORATION_CLEANUP", 503)
                if identity(os.stat(base, follow_symlinks=False)) != parent_identity:
                    raise RestorationError("SECRETARY_RESTORATION_CLEANUP", 503)
        except (OSError, RestorationError):
            raise RestorationError("SECRETARY_RESTORATION_CLEANUP", 503) from None
        finally:
            if root_fd is not None:
                os.close(root_fd)
            os.close(parent_fd)


def copy_files(files, root_fd):
    written = {}
    for path, (_, _, data) in sorted(files.files.items()):
        parts = path.split("/")
        parent_fd = directory(root_fd, parts[:-1], create=True)
        fd = None
        try:
            fd = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_NONBLOCK,
                         mode=0o600, dir_fd=parent_fd)
            left = memoryview(data)
            while left:
                count = os.write(fd, left[:65536])
                if count <= 0:
                    raise RestorationError("SECRETARY_RESTORATION_IO", 503)
                left = left[count:]
            os.fsync(fd)
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600 \
                    or info.st_size != len(data):
                raise RestorationError()
            written[path] = native.stamp(info)
            os.fsync(parent_fd)
        finally:
            if fd is not None:
                os.close(fd)
            os.close(parent_fd)
    os.fsync(root_fd)
    return written


def verify_written(root_fd, written):
    for path, before in written.items():
        parts = path.split("/")
        parent_fd = directory(root_fd, parts[:-1])
        fd = None
        try:
            fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent_fd)
            if native.stamp(os.fstat(fd)) != before or os.fstat(fd).st_nlink != 1:
                raise RestorationError()
        finally:
            if fd is not None:
                os.close(fd)
            os.close(parent_fd)


def restore(files, source_proof):
    rows, children = layout(files, source_proof)
    source_hash, restored_hash = set_hash(rows), None
    comparable = lambda proof: {key: value for key, value in proof.items() if key != "archiveIdSha256"}
    with scratch(files.root) as (path, root_fd, bound):
        written = copy_files(files, root_fd)
        guards = check_tree(root_fd, children)
        files.finish(); bound()

        def verified(restored_files, restored_proof):
            nonlocal restored_hash
            if comparable(restored_proof) != comparable(source_proof) \
                    or set(restored_files.files) != set(written) \
                    or any(before != written[name] for name, (_, before, _) in restored_files.files.items()):
                raise RestorationError()
            restored_hash = set_hash(file_set(restored_files))
            if restored_hash != source_hash:
                raise RestorationError()
            check_tree(root_fd, children, guards); bound()

        native._probe(path, source_proof["messageId"], source_proof["threadId"], source_proof["sourceSha256"],
                      source_proof["requestId"], inspect_files=verified)
        if restored_hash != source_hash:
            raise RestorationError()
        verify_written(root_fd, written)
        check_tree(root_fd, children, guards); files.finish(); bound()
    return {"sourceFilesSha256": source_hash, "restoredFilesSha256": restored_hash,
            "filesCopied": len(rows), "bytesCopied": sum(row[1] for row in rows), "temporaryCopyRemoved": True}


def probe(root, message_id, thread_id, source_sha256, request_id):
    if any(not isinstance(value, str) or not pattern.fullmatch(value) for pattern, value in (
            (native.MAIL_ID, message_id), (native.MAIL_ID, thread_id), (native.HASH, source_sha256), (native.UUID, request_id))):
        raise RestorationError("SECRETARY_RESTORATION_INVALID", 400)
    if not NATIVE_PLATFORM:
        raise RestorationError("SECRETARY_RESTORATION_UNSUPPORTED", 503)
    restored = None

    def verified(files, source_proof):
        nonlocal restored
        restored = restore(files, source_proof)

    try:
        proof = native._probe(root, message_id, thread_id, source_sha256, request_id, inspect_files=verified)
        if restored is None:
            raise RestorationError()
        return {**proof, "contract": CONTRACT, "restoration": restored}
    except RestorationError:
        raise
    except native.PreservationError as error:
        code = "SECRETARY_RESTORATION_TOO_LARGE" if error.status == 413 else "SECRETARY_RESTORATION_INTEGRITY"
        raise RestorationError(code, error.status) from None
    except OSError:
        raise RestorationError("SECRETARY_RESTORATION_IO", 503) from None
    except (ValueError, TypeError, LookupError, AttributeError, RecursionError):
        raise RestorationError() from None
