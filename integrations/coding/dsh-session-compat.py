#!/usr/bin/env python3
"""Explicit, pinned compatibility patch for one upstream DSH package.

This operator tool never discovers sessions, starts DSH or runs during launch.
Apply only while the package is quiescent. The lock coordinates this installer;
an unrelated writer must also be stopped during the final compare/rename.
"""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import secrets
import stat
import sys


PACKAGE = "@deepseek-ai/dsh-session-format-v0-to-v1"
VERSION = "0.2.0-rc.2"
# Both releases publish the same reviewed target bytes; keep the artifact pinned.
SUPPORTED_VERSIONS = (VERSION, "0.2.1-rc.3")
TARGET = "lib/index.js"
ARTIFACT = Path(__file__).with_suffix(".json")
# Updated only together with the reviewed, bundled patch artifact.
ARTIFACT_SHA256 = "aa51cbbe20c94b8e47b876ff03ec256d14082e10c3b90fcf9b3ee708306cebd6"
MAX_SOURCE_BYTES = 2 * 1024 * 1024
MAX_ARTIFACT_BYTES = 64 * 1024


class Refusal(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def digest(data):
    return hashlib.sha256(data).hexdigest()


def _is_sha(value):
    return (isinstance(value, str) and len(value) == 64
            and all(char in "0123456789abcdef" for char in value))


def load_patch():
    """Load only the reviewed adjacent artifact, never an operator-supplied patch."""
    try:
        data = ARTIFACT.read_bytes()
    except OSError as error:
        raise Refusal("ARTIFACT_UNAVAILABLE", "Bundled patch artifact is unavailable.") from error
    if len(data) > MAX_ARTIFACT_BYTES or digest(data) != ARTIFACT_SHA256:
        raise Refusal("ARTIFACT_DRIFT", "Bundled patch artifact differs from its reviewed hash.")
    try:
        patch = json.loads(data)
    except (ValueError, UnicodeError) as error:
        raise Refusal("ARTIFACT_INVALID", "Bundled patch artifact is invalid.") from error
    keys = {"schema", "package", "version", "target", "beforeSha256", "afterSha256", "changes"}
    if (not isinstance(patch, dict) or set(patch) != keys
            or patch["schema"] != "agentx.dsh-session-compat/v1"
            or patch["package"] != PACKAGE or patch["version"] != VERSION
            or patch["target"] != TARGET
            or not _is_sha(patch["beforeSha256"]) or not _is_sha(patch["afterSha256"])
            or patch["beforeSha256"] == patch["afterSha256"]
            or not isinstance(patch["changes"], list) or not 1 <= len(patch["changes"]) <= 8):
        raise Refusal("ARTIFACT_INVALID", "Bundled patch metadata is invalid.")
    for change in patch["changes"]:
        if (not isinstance(change, dict) or set(change) != {"before", "after"}
                or not isinstance(change["before"], str) or not change["before"]
                or not isinstance(change["after"], str) or not change["after"]
                or change["before"] == change["after"]):
            raise Refusal("ARTIFACT_INVALID", "Bundled patch replacement is invalid.")
    return patch


def patched_bytes(source, patch):
    if digest(source) != patch["beforeSha256"]:
        raise Refusal("SOURCE_DRIFT", "Installed source is neither the pinned upstream nor patched source.")
    result = source
    for change in patch["changes"]:
        before, after = change["before"].encode("utf-8"), change["after"].encode("utf-8")
        if result.count(before) != 1:
            raise Refusal("ARTIFACT_INVALID", "Pinned replacement does not occur exactly once.")
        result = result.replace(before, after, 1)
    if digest(result) != patch["afterSha256"]:
        raise Refusal("ARTIFACT_INVALID", "Replacement does not produce the reviewed source hash.")
    return result


def _regular_fd(name, directory_fd):
    try:
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                             dir_fd=directory_fd)
    except OSError as error:
        raise Refusal("PATH_UNAVAILABLE", "A required package file is missing or unsafe.") from error
    if not stat.S_ISREG(os.fstat(descriptor).st_mode):
        os.close(descriptor)
        raise Refusal("PATH_UNSAFE", "A required package file is not regular.")
    return descriptor


def _read_fd(descriptor):
    os.lseek(descriptor, 0, os.SEEK_SET)
    with os.fdopen(os.dup(descriptor), "rb") as stream:
        data = stream.read(MAX_SOURCE_BYTES + 1)
    if len(data) > MAX_SOURCE_BYTES:
        raise Refusal("SOURCE_TOO_LARGE", "Package source exceeds the bounded installer limit.")
    return data


def _identity(metadata):
    return (metadata.st_dev, metadata.st_ino, metadata.st_mode, metadata.st_uid,
            metadata.st_gid, metadata.st_size, metadata.st_mtime_ns, metadata.st_ctime_ns)


def _unchanged(name, directory_fd, descriptor, metadata, original):
    try:
        current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    except OSError as error:
        raise Refusal("CONCURRENT_CHANGE", "Package changed during preparation; nothing was replaced.") from error
    if (_identity(current) != _identity(metadata)
            or _identity(os.fstat(descriptor)) != _identity(metadata)
            or _read_fd(descriptor) != original):
        raise Refusal("CONCURRENT_CHANGE", "Package changed during preparation; nothing was replaced.")


def _package_directories(package_root):
    # Resolve the explicit package root once, allowing pnpm's package-directory link.
    try:
        root = Path(package_root).resolve(strict=True)
    except (OSError, RuntimeError, ValueError) as error:
        raise Refusal("PATH_UNAVAILABLE", "Explicit package root is unavailable.") from error
    if not root.is_dir():
        raise Refusal("PATH_UNSAFE", "Explicit package root must be a directory.")
    root_fd = None
    try:
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        root_fd = os.open(root, flags)
        lib_fd = os.open("lib", flags, dir_fd=root_fd)
    except OSError as error:
        if root_fd is not None:
            os.close(root_fd)
        raise Refusal("PATH_UNSAFE", "Package directories must be real directories.") from error
    return root, root_fd, lib_fd


def _directories_unchanged(root, root_fd, lib_fd):
    try:
        root_now = root.stat(follow_symlinks=False)
        lib_now = os.stat("lib", dir_fd=root_fd, follow_symlinks=False)
        pairs = ((root_now, os.fstat(root_fd)), (lib_now, os.fstat(lib_fd)))
        if any((left.st_dev, left.st_ino, left.st_mode, left.st_uid, left.st_gid)
               != (right.st_dev, right.st_ino, right.st_mode, right.st_uid, right.st_gid)
               for left, right in pairs):
            raise OSError("Directory identity changed")
    except OSError as error:
        raise Refusal("CONCURRENT_CHANGE", "Package directory changed during preparation.") from error


def _check_manifest(descriptor):
    try:
        manifest = json.loads(_read_fd(descriptor))
    except (ValueError, UnicodeError) as error:
        raise Refusal("PACKAGE_INVALID", "Package manifest is invalid.") from error
    if (not isinstance(manifest, dict) or manifest.get("name") != PACKAGE
            or manifest.get("version") not in SUPPORTED_VERSIONS):
        raise Refusal("PACKAGE_MISMATCH", "Only the pinned package name and version are supported.")
    return manifest["version"]


def _atomic_replace(directory_fd, descriptor, metadata, original, replacement, manifest_check):
    staging = None
    staging_created = False
    replaced = False
    try:
        staging = ".dsh-session-compat-" + secrets.token_hex(12)
        staging_fd = os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o600, dir_fd=directory_fd)
        staging_created = True
        with os.fdopen(staging_fd, "wb") as stream:
            stream.write(replacement)
            stream.flush()
            staged = os.fstat(stream.fileno())
            if (staged.st_uid, staged.st_gid) != (metadata.st_uid, metadata.st_gid):
                os.fchown(stream.fileno(), metadata.st_uid, metadata.st_gid)
            os.fchmod(stream.fileno(), stat.S_IMODE(metadata.st_mode))
            os.fsync(stream.fileno())
        manifest_check()
        _unchanged("index.js", directory_fd, descriptor, metadata, original)
        os.replace(staging, "index.js", src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
        replaced = True
        os.fsync(directory_fd)
    except Refusal:
        raise
    except OSError as error:
        code = "APPLY_OUTCOME_UNKNOWN" if replaced else "APPLY_FAILED"
        message = ("Replacement occurred but durability is unconfirmed; run --check to reconcile."
                   if replaced else "Replacement failed before source publication.")
        raise Refusal(code, message) from error
    finally:
        if staging_created and not replaced:
            try:
                os.unlink(staging, dir_fd=directory_fd)
            except FileNotFoundError:
                pass


def install(package_root, apply=False):
    patch = load_patch()
    root, root_fd, lib_fd = _package_directories(package_root)
    manifest_fd = None
    source_fd = None
    try:
        manifest_fd = _regular_fd("package.json", root_fd)
        manifest_metadata = os.fstat(manifest_fd)
        manifest_bytes = _read_fd(manifest_fd)
        installed_version = _check_manifest(manifest_fd)
        source_fd = _regular_fd("index.js", lib_fd)
        if apply:
            try:
                fcntl.flock(source_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise Refusal("INSTALLER_BUSY", "Another installer holds this package source.") from error
        metadata = os.fstat(source_fd)
        source = _read_fd(source_fd)
        installed_sha = digest(source)

        def manifest_check():
            _directories_unchanged(root, root_fd, lib_fd)
            _unchanged("package.json", root_fd, manifest_fd, manifest_metadata, manifest_bytes)

        if installed_sha == patch["afterSha256"]:
            manifest_check()
            _unchanged("index.js", lib_fd, source_fd, metadata, source)
            state, action = "already_applied", "none"
        else:
            replacement = patched_bytes(source, patch)
            state, action = "compatible", "replace_pinned_source"
            if apply:
                _atomic_replace(lib_fd, source_fd, metadata, source, replacement, manifest_check)
                state, action = "applied", "none"
            else:
                manifest_check()
                _unchanged("index.js", lib_fd, source_fd, metadata, source)
        return {"ok": True, "schema": "agentx.dsh-session-compat-plan/v1",
                "mode": "apply" if apply else "check", "state": state, "action": action,
                "package": PACKAGE, "version": installed_version, "target": TARGET,
                "observedSha256": installed_sha,
                "installedSha256": patch["afterSha256"] if state == "applied" else installed_sha,
                "upstreamSha256": patch["beforeSha256"],
                "patchedSha256": patch["afterSha256"]}
    finally:
        if source_fd is not None:
            os.close(source_fd)
        if manifest_fd is not None:
            os.close(manifest_fd)
        os.close(lib_fd)
        os.close(root_fd)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-root", required=True,
                        help="Explicit directory of the pinned upstream package, not a DSH history directory.")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="Print a read-only compatibility plan.")
    mode.add_argument("--apply", action="store_true", help="Apply once while the package is stopped/quiescent.")
    args = parser.parse_args(argv)
    try:
        result = install(args.package_root, apply=args.apply)
    except Refusal as error:
        print(json.dumps({"ok": False, "error": error.code, "message": str(error)}), file=sys.stderr)
        return 1
    except OSError:
        print(json.dumps({"ok": False, "error": "IO_FAILED",
                          "message": "Package verification could not complete."}), file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
