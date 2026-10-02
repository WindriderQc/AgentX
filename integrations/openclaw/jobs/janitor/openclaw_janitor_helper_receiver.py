#!/usr/bin/env python3
"""Forced-command receiver for exactly one OpenClaw janitor helper artifact."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
from typing import BinaryIO, Callable, TextIO


PROTOCOL = "agentx-openclaw-janitor-helper-v2"
DEFAULT_TARGET = pathlib.Path(__file__).resolve().parent / "openclaw_shared_drive_janitor.py"
TARGET_ENV = "AGENTX_JANITOR_HELPER_TARGET"
MAX_HEADER_BYTES = 2048
MAX_PAYLOAD_BYTES = 512 * 1024
HEX_SHA256 = re.compile(r"^[0-9a-f]{64}$")
Runner = Callable[..., subprocess.CompletedProcess]


class ReceiverError(RuntimeError):
    """Raised when a request violates the forced receiver contract."""


def hash_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def hash_file(path: pathlib.Path) -> str | None:
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(128 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_helper(path: pathlib.Path, runner: Runner) -> None:
    try:
        raw = path.read_bytes()
        text = raw.decode("utf-8")
        compile(text, str(path), "exec")
    except (OSError, UnicodeDecodeError, SyntaxError) as exc:
        raise ReceiverError(f"candidate validation failed: {exc}") from exc
    try:
        runner(
            [sys.executable, str(path), "--help"],
            check=True,
            capture_output=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise ReceiverError("candidate --help validation failed") from exc


def read_request(stream: BinaryIO) -> tuple[dict, bytes]:
    header_raw = stream.readline(MAX_HEADER_BYTES + 1)
    if not header_raw or len(header_raw) > MAX_HEADER_BYTES or not header_raw.endswith(b"\n"):
        raise ReceiverError("protocol header is missing or exceeds the limit")
    try:
        header = json.loads(header_raw.decode("ascii"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ReceiverError("protocol header is not valid ASCII JSON") from exc
    if not isinstance(header, dict):
        raise ReceiverError("protocol header must be an object")
    if set(header) != {"protocol", "action", "sha256", "size"}:
        raise ReceiverError("protocol header fields are not allowlisted")
    if header["protocol"] != PROTOCOL:
        raise ReceiverError("unsupported protocol")
    if header["action"] not in {"check", "install"}:
        raise ReceiverError("unsupported action")
    if not isinstance(header["sha256"], str) or not HEX_SHA256.fullmatch(header["sha256"]):
        raise ReceiverError("sha256 must be 64 lowercase hexadecimal characters")
    if isinstance(header["size"], bool) or not isinstance(header["size"], int):
        raise ReceiverError("size must be an integer")
    if not 1 <= header["size"] <= MAX_PAYLOAD_BYTES:
        raise ReceiverError(f"payload size must be 1..{MAX_PAYLOAD_BYTES} bytes")
    payload = stream.read(header["size"])
    if len(payload) != header["size"]:
        raise ReceiverError("payload is shorter than the declared size")
    if stream.read(1):
        raise ReceiverError("payload exceeds the declared size")
    if hash_bytes(payload) != header["sha256"]:
        raise ReceiverError("payload SHA-256 does not match the header")
    return header, payload


def write_response(stream: TextIO, *, status_value: str, sha256: str | None) -> None:
    json.dump({"ok": True, "status": status_value, "sha256": sha256}, stream, separators=(",", ":"))
    stream.write("\n")
    stream.flush()


def install_payload(target: pathlib.Path, payload: bytes, expected_hash: str, runner: Runner) -> str:
    if hash_bytes(payload) != expected_hash:
        raise ReceiverError("payload SHA-256 does not match the header")

    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temp_path: pathlib.Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            prefix=f".{target.name}.candidate-",
            dir=target.parent,
            delete=False,
        ) as handle:
            temp_path = pathlib.Path(handle.name)
            os.chmod(temp_path, 0o700)
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        validate_helper(temp_path, runner)
        os.replace(temp_path, target)
        temp_path = None
        if os.name != "nt":
            directory_fd = os.open(target.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        installed_hash = hash_file(target)
        if installed_hash != expected_hash:
            raise ReceiverError("installed SHA-256 does not match the candidate")
        validate_helper(target, runner)
        return installed_hash
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def serve(
    stdin: BinaryIO,
    stdout: TextIO,
    stderr: TextIO,
    *,
    target: pathlib.Path = DEFAULT_TARGET,
    original_command: str | None = None,
    runner: Runner = subprocess.run,
) -> int:
    try:
        if original_command:
            raise ReceiverError("SSH commands are forbidden; use the bounded stdin protocol")
        header, payload = read_request(stdin)
        current_hash = hash_file(target)

        if header["action"] == "check":
            if current_hash == header["sha256"]:
                validate_helper(target, runner)
                write_response(stdout, status_value="unchanged", sha256=current_hash)
            else:
                write_response(stdout, status_value="drift", sha256=current_hash)
            return 0

        if current_hash == header["sha256"]:
            validate_helper(target, runner)
            write_response(stdout, status_value="unchanged", sha256=current_hash)
            return 0

        installed_hash = install_payload(target, payload, header["sha256"], runner)
        write_response(stdout, status_value="updated", sha256=installed_hash)
        return 0
    except (ReceiverError, OSError) as exc:
        print(f"ERROR: {exc}", file=stderr, flush=True)
        return 1


def resolve_target(argv: list[str] | None = None, environ: dict[str, str] | None = None) -> pathlib.Path:
    environ = os.environ if environ is None else environ
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--target",
        help=f"installed janitor helper path (env {TARGET_ENV}; default: the sibling checkout script)",
    )
    args = parser.parse_args(argv)
    value = args.target or environ.get(TARGET_ENV)
    if not value:
        return DEFAULT_TARGET
    target = pathlib.Path(value).expanduser()
    if not target.is_absolute():
        raise ReceiverError("janitor helper target must be an absolute path")
    return target


def main(argv: list[str] | None = None) -> int:
    try:
        target = resolve_target(argv)
    except ReceiverError as exc:
        print(f"ERROR: {exc}", file=sys.stderr, flush=True)
        return 1
    return serve(
        sys.stdin.buffer,
        sys.stdout,
        sys.stderr,
        target=target,
        original_command=os.environ.get("SSH_ORIGINAL_COMMAND"),
    )


if __name__ == "__main__":
    raise SystemExit(main())
