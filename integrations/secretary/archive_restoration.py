"""Qualify one source through an actual private filesystem copy and reread.

The temporary copy is removed before success. This is neither whole-archive
acceptance nor evidence of a separate physical storage failure domain.
The OS account is trusted; private custody is not isolation from a hostile
process with the same UID that can discover and rewrite every custody slot.
"""
from __future__ import annotations

from contextlib import contextmanager
import ctypes
import json
import os
from pathlib import Path
import stat
import sys
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
try:
    RENAME_NOREPLACE = ctypes.CDLL(None, use_errno=True).renameat2 if sys.platform == 'linux' else None
except AttributeError:
    RENAME_NOREPLACE = None
if RENAME_NOREPLACE is not None:
    RENAME_NOREPLACE.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
    RENAME_NOREPLACE.restype = ctypes.c_int


class RestorationError(RuntimeError):
    def __init__(self, code="SECRETARY_RESTORATION_INTEGRITY", status=409):
        super().__init__("The selected native filesystem restoration could not be verified")
        self.code, self.status = code, status


def identity(info):
    return info.st_dev, info.st_ino, info.st_mode, info.st_uid


def inode(info):
    return info.st_dev, info.st_ino


def directory(root_fd, parts):
    """Open every component relative to a retained root, never following links."""
    fd = os.dup(root_fd)
    try:
        for name in parts:
            child = os.open(name, DIRECTORY_FLAGS, dir_fd=fd)
            os.close(fd); fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def inside_source(fd, protected):
    cursor = os.dup(fd)
    try:
        for _ in range(4096):
            current = inode(os.fstat(cursor))
            if current in protected:
                return True
            parent = os.open('..', DIRECTORY_FLAGS, dir_fd=cursor)
            above = inode(os.fstat(parent))
            os.close(cursor); cursor = parent
            if current == above:
                return False
        raise RestorationError()
    finally:
        os.close(cursor)


def source_identities(files):
    directories = {inode(os.fstat(files.fd))}
    prefixes = {tuple(path.split('/')[:index]) for path in files.files
                for index in range(1, len(path.split('/')))}
    for parts in prefixes:
        fd = directory(files.fd, parts)
        try:
            directories.add(inode(os.fstat(fd)))
        finally:
            os.close(fd)
    return directories, {inode(os.fstat(fd)) for fd, _, _ in files.files.values()}


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


def empty(fd):
    with os.scandir(fd) as entries:
        return next(entries, None) is None


def rename_noreplace(source_fd, source, destination_fd, destination):
    """Atomic capture or restitution, with no overwrite or racy fallback."""
    if RENAME_NOREPLACE is None:
        raise RestorationError("SECRETARY_RESTORATION_UNSUPPORTED", 503)
    # ctypes does not emit the standard filesystem audit event itself.
    sys.audit('os.rename', source, destination, source_fd, destination_fd)
    if RENAME_NOREPLACE(source_fd, os.fsencode(source), destination_fd, os.fsencode(destination), 1):
        raise OSError(ctypes.get_errno(), "Atomic private capture failed")


def missing(fd, name):
    try:
        os.stat(name, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        return True
    return False


class OwnedTree:
    """Bounded ownership journal, with open FDs preventing inode reuse.

    Cleanup is never a recursive scan. Unknown or replaced entries survive and
    turn the operation into a closed error instead of being adopted/deleted.
    """
    def __init__(self, root_fd, root_identity, source_dirs, source_files):
        self.root_fd = root_fd
        self.directories = {(): (root_fd, root_identity)}
        self.files = {}
        self.source_dirs, self.source_files = source_dirs, source_files

    def checked(self, record):
        fd, expected = record
        if identity(os.fstat(fd)) != expected or inside_source(fd, self.source_dirs):
            raise RestorationError()
        return fd

    def directory(self, parts, *, create=False):
        self.checked(self.directories[()])
        for index, name in enumerate(parts):
            parent = tuple(parts[:index]); key = tuple(parts[:index + 1])
            parent_fd = self.checked(self.directories[parent])
            if key not in self.directories:
                if not create or len(self.directories) - 1 >= MAX_DIRECTORIES:
                    raise RestorationError()
                os.mkdir(name, mode=0o700, dir_fd=parent_fd)
                before = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
                fd = os.open(name, DIRECTORY_FLAGS, dir_fd=parent_fd)
                accepted = False
                try:
                    info = os.fstat(fd)
                    if identity(info) != identity(before) or inode(info) in self.source_dirs \
                            or inside_source(fd, self.source_dirs) or not empty(fd) \
                            or stat.S_IMODE(info.st_mode) != 0o700 or info.st_uid != os.geteuid():
                        raise RestorationError()
                    self.directories[key] = (fd, identity(info)); accepted = True
                    os.fsync(parent_fd)
                finally:
                    if not accepted:
                        os.close(fd)
            record = self.directories[key]
            if identity(os.stat(name, dir_fd=parent_fd, follow_symlinks=False)) != record[1]:
                raise RestorationError()
            self.checked(record)
        return self.checked(self.directories[tuple(parts)])

    def cleanup(self, parent_fd, name):
        """Capture names before inspecting, never stat then unlink a source name.

        Custody names are private unpredictable slots, reached only by retained
        directory FDs. Unknown captures are restored without overwrite, or kept
        at their custody name. No recursive traversal ever adopts unknown data.
        """
        captured_root, root_moved = None, False
        try:
            root_identity = self.directories[()][1]
            self.checked(self.directories[()])
            if identity(os.stat(name, dir_fd=parent_fd, follow_symlinks=False)) != root_identity \
                    or inside_source(parent_fd, self.source_dirs):
                raise RestorationError()
            captured_root = 'agentx-restoration-captured-' + uuid4().hex
            rename_noreplace(parent_fd, name, parent_fd, captured_root)
            root_moved = True
            if identity(os.stat(captured_root, dir_fd=parent_fd, follow_symlinks=False)) != root_identity:
                raise RestorationError()
            os.fsync(parent_fd)
            for parts, record in self.files.items():
                self.remove_captured(self.directory(parts[:-1]), parts[-1], record, directory_entry=False)
            for parts in sorted((key for key in self.directories if key), key=len, reverse=True):
                directory_fd = self.directory(parts[:-1])
                self.remove_captured(directory_fd, parts[-1], self.directories[parts], directory_entry=True)
            self.checked(self.directories[()])
            if identity(os.stat(captured_root, dir_fd=parent_fd, follow_symlinks=False)) != root_identity \
                    or inside_source(parent_fd, self.source_dirs):
                raise RestorationError()
            os.rmdir(captured_root, dir_fd=parent_fd)
            os.fsync(parent_fd)
            if os.fstat(self.root_fd).st_nlink or not missing(parent_fd, captured_root) or not missing(parent_fd, name):
                raise RestorationError()
            root_moved = False
        except (OSError, RestorationError):
            raise RestorationError("SECRETARY_RESTORATION_CLEANUP", 503) from None
        finally:
            if root_moved:
                # Failed cleanup may retain an unknown directory, never erase
                # it or replace an entry that appeared at the original name.
                try:
                    rename_noreplace(parent_fd, captured_root, parent_fd, name)
                except (OSError, RestorationError):
                    pass

    def remove_captured(self, parent_fd, name, record, *, directory_entry):
        fd, expected = record
        slot = '.agentx-captured-' + uuid4().hex
        captured = False
        try:
            self.checked(self.directories[()])
            if inside_source(parent_fd, self.source_dirs) or identity(os.fstat(fd)) != expected:
                raise RestorationError()
            rename_noreplace(parent_fd, name, self.root_fd, slot)
            captured = True
            info = os.stat(slot, dir_fd=self.root_fd, follow_symlinks=False)
            protected = self.source_dirs if directory_entry else self.source_files
            if identity(info) != expected or inode(info) in protected \
                    or (not directory_entry and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1)):
                raise RestorationError()
            self.checked(self.directories[()])
            if directory_entry:
                os.rmdir(slot, dir_fd=self.root_fd)
            else:
                os.unlink(slot, dir_fd=self.root_fd)
            os.fsync(parent_fd); os.fsync(self.root_fd)
            if os.fstat(fd).st_nlink or not missing(self.root_fd, slot) or not missing(parent_fd, name):
                raise RestorationError()
            captured = False
        finally:
            if captured:
                # Unknown entry or I/O failure: preservation beats tidiness.
                # NOREPLACE also protects a concurrent new original-name entry.
                try:
                    rename_noreplace(self.root_fd, slot, parent_fd, name)
                except (OSError, RestorationError):
                    pass

    def close(self):
        failed = False
        descriptors = [fd for fd, _ in self.files.values()]
        descriptors.extend(fd for parts, (fd, _) in self.directories.items() if parts)
        for fd in descriptors:
            try:
                os.close(fd)
            except OSError:
                failed = True
        if failed:
            raise RestorationError("SECRETARY_RESTORATION_CLEANUP", 503)


def check_tree(owner, children, previous=None):
    stamps = {}
    for parts, names in children.items():
        fd = owner.directory(parts)
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
    if previous is not None and stamps != previous:
        raise RestorationError()
    return stamps


@contextmanager
def scratch(files):
    # Resolve without tempfile's candidate write probes, then open EVERY ancestor
    # from / with NOFOLLOW. O_NOFOLLOW on only the final path is insufficient.
    configured = next((os.environ[key] for key in ('TMPDIR', 'TEMP', 'TMP') if os.environ.get(key)), '/tmp')
    base = Path(configured).resolve(strict=True)
    if base.is_relative_to(files.root):
        raise RestorationError("SECRETARY_RESTORATION_LOCATION", 409)
    system_fd = os.open('/', DIRECTORY_FLAGS)
    parent_fd, root_fd, owner = None, None, None
    name = "agentx-restoration-" + uuid4().hex
    try:
        source_dirs, source_files = source_identities(files)
        parent_fd = directory(system_fd, base.parts[1:])
        parent_identity = identity(os.fstat(parent_fd))
        source_identity = identity(os.fstat(files.fd))

        def mappings():
            source = directory(system_fd, files.root.parts[1:])
            parent = None
            try:
                parent = directory(system_fd, base.parts[1:])
                if identity(os.fstat(source)) != source_identity or identity(os.fstat(parent)) != parent_identity \
                        or files.root.resolve(strict=True) != files.root or base.resolve(strict=True) != base \
                        or inside_source(parent_fd, source_dirs):
                    raise RestorationError("SECRETARY_RESTORATION_LOCATION", 409)
            finally:
                if parent is not None:
                    os.close(parent)
                os.close(source)

        mappings(); files.finish()
        os.mkdir(name, mode=0o700, dir_fd=parent_fd)
        before = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        root_fd = os.open(name, DIRECTORY_FLAGS, dir_fd=parent_fd)
        info = os.fstat(root_fd)
        if identity(info) != identity(before) or inode(info) in source_dirs \
                or inside_source(root_fd, source_dirs) or not empty(root_fd) \
                or stat.S_IMODE(info.st_mode) != 0o700 or info.st_uid != os.geteuid():
            raise RestorationError()
        mappings(); files.finish()
        owner = OwnedTree(root_fd, identity(info), source_dirs, source_files)
        os.fsync(root_fd); os.fsync(parent_fd)
        path = base / name

        def bound():
            mappings()
            if identity(os.stat(name, dir_fd=parent_fd, follow_symlinks=False)) != owner.directories[()][1]:
                raise RestorationError()
            owner.checked(owner.directories[()])

        bound()
        yield path, owner, bound
    finally:
        try:
            # An unqualified initial FD may be a replaced archive. NEVER clean
            # or rmdir it, even when mkdir previously succeeded at this name.
            if owner is not None:
                owner.cleanup(parent_fd, name)
                mappings()
        finally:
            try:
                if owner is not None:
                    owner.close()
            finally:
                if root_fd is not None:
                    os.close(root_fd)
                if parent_fd is not None:
                    os.close(parent_fd)
                os.close(system_fd)


def copy_files(files, owner):
    written = {}
    for path, (_, _, data) in sorted(files.files.items()):
        parts = tuple(path.split('/'))
        parent_fd = owner.directory(parts[:-1], create=True)
        fd = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_NONBLOCK,
                     mode=0o600, dir_fd=parent_fd)
        accepted = False
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or inode(info) in owner.source_files:
                raise RestorationError()
            # Ownership is captured before any data write or fsync can fail.
            owner.files[parts] = (fd, identity(info)); accepted = True
            if info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.geteuid():
                raise RestorationError()
            left = memoryview(data)
            while left:
                if inside_source(parent_fd, owner.source_dirs):
                    raise RestorationError()
                count = os.write(fd, left[:65536])
                if count <= 0:
                    raise RestorationError("SECRETARY_RESTORATION_IO", 503)
                left = left[count:]
            os.fsync(fd)
            if os.fstat(fd).st_size != len(data):
                raise RestorationError()
            written[path] = native.stamp(os.fstat(fd))
            os.fsync(parent_fd)
        finally:
            if not accepted:
                os.close(fd)
    os.fsync(owner.root_fd)
    return written


def verify_written(owner, written):
    for path, before in written.items():
        parts = tuple(path.split('/'))
        parent_fd = owner.directory(parts[:-1])
        current = os.stat(parts[-1], dir_fd=parent_fd, follow_symlinks=False)
        fd, expected = owner.files[parts]
        if identity(current) != expected or native.stamp(os.fstat(fd)) != before or current.st_nlink != 1:
            raise RestorationError()


def restore(files, source_proof):
    rows, children = layout(files, source_proof)
    source_hash, restored_hash = set_hash(rows), None
    comparable = lambda proof: {key: value for key, value in proof.items() if key != "archiveIdSha256"}
    with scratch(files) as (path, owner, bound):
        written = copy_files(files, owner)
        guards = check_tree(owner, children)
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
            check_tree(owner, children, guards); bound()

        native._probe(path, source_proof["messageId"], source_proof["threadId"], source_proof["sourceSha256"],
                      source_proof["requestId"], inspect_files=verified)
        if restored_hash != source_hash:
            raise RestorationError()
        verify_written(owner, written)
        check_tree(owner, children, guards); files.finish(); bound()
    return {"sourceFilesSha256": source_hash, "restoredFilesSha256": restored_hash,
            "filesCopied": len(rows), "bytesCopied": sum(row[1] for row in rows), "temporaryCopyRemoved": True}


def probe(root, message_id, thread_id, source_sha256, request_id):
    if any(not isinstance(value, str) or not pattern.fullmatch(value) for pattern, value in (
            (native.MAIL_ID, message_id), (native.MAIL_ID, thread_id), (native.HASH, source_sha256), (native.UUID, request_id))):
        raise RestorationError("SECRETARY_RESTORATION_INVALID", 400)
    if not NATIVE_PLATFORM or RENAME_NOREPLACE is None:
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
    except (ValueError, TypeError, LookupError, AttributeError, RecursionError, RuntimeError):
        raise RestorationError() from None
