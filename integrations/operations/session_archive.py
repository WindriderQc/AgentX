#!/usr/bin/env python3
"""Append-only archive of local agent session transcripts, pushed over SSH.

Runs on the host where the transcripts live (Windows or Linux) and copies new
and changed files from named source paths to a private directory on an archive
host. The archive host verifies every file by SHA-256 on arrival. Nothing is
ever deleted there: a file that grew (a session still being written) replaces
its shorter copy, any other change keeps the previous copy under versions/, and
a file removed at the source, for example by a client's own retention, stays
archived and is only counted. Credential files are never read. Receipts hold
counts, never file contents.

The receiving side is this same file, sent with each call and run by the
archive host's python3, so both sides always speak the same protocol. With
`collect`, the archive host starts the sending side on a source host over SSH,
also from this file, so nothing is installed or scheduled on that host.
"""
from __future__ import annotations

import argparse
import base64
import fnmatch
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import subprocess
import sys
import time
import zlib


CONTRACT = "agentx.session-archive/v1"
LABEL = re.compile(r"[a-z0-9][a-z0-9-]{0,39}")
RUN_ID = re.compile(r"\d{8}T\d{6}Z")
SSH_TARGET = re.compile(r"[A-Za-z0-9_.@:-]+")
REMOTE_ROOT = re.compile(r"/[A-Za-z0-9._@+=/ -]+")
# Never read, whatever directory a source names.
CREDENTIAL_NAMES = {".credentials.json", "credentials.json", "auth.json"}
DEFAULT_EXCLUDES = ("*.tmp", "*.partial", "*.lock")
STATE_NAME = "session-archive-state.json"
RUN_NAME = "latest-run.json"
LOCK_NAME = "session-archive.lock"
LOCK_STALE_SECONDS = 6 * 3600
BATCH_FILES = 500
BATCH_BYTES = 512 * 1024 * 1024
CHUNK = 1 << 20
TRANSFERRED = {"new", "grown", "versioned", "unchanged"}


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def load(file, default=None):
    try:
        return json.loads(Path(file).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def save(file, value):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    temp = file.with_name(file.name + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if os.name != "nt":
        temp.chmod(0o600)
    temp.replace(file)


def safe_relative(path):
    """A relative POSIX path that cannot leave its directory."""
    if not isinstance(path, str) or not path or len(path) > 1024 or path.startswith("/"):
        return False
    parts = path.split("/")
    return all(part not in ("", ".", "..") and len(part) <= 255
               and not re.search(r"[\x00-\x1f\\]", part) for part in parts)


# --------------------------------------------------------------------------
# Receiving side (archive host)
# --------------------------------------------------------------------------

def private_dir(path):
    path.mkdir(parents=True, exist_ok=True)
    path.chmod(0o700)
    return path


def same_prefix(shorter, longer):
    """True when every byte of `shorter` starts `longer`."""
    with open(shorter, "rb") as a, open(longer, "rb") as b:
        while True:
            block = a.read(CHUNK)
            if not block:
                return True
            if b.read(len(block)) != block:
                return False


def read_line(stream):
    line = stream.readline(4096)
    if not line.endswith(b"\n"):
        raise ValueError("Truncated session archive stream")
    return line[:-1]


def receive(stream, root, host, run_id):
    """Read framed files from `stream` into root/live/<host>; never delete."""
    os.umask(0o077)
    live = private_dir(root / "live" / host)
    staging = root / "staging" / host / run_id
    shutil.rmtree(staging, ignore_errors=True)
    private_dir(staging)
    results = {}
    try:
        while True:
            line = read_line(stream)
            if line == b"E":
                break
            if not line.startswith(b"F "):
                raise ValueError("Unexpected session archive frame")
            path = json.loads(line[2:].decode("utf-8"))["path"]
            unsafe = not safe_relative(path)
            staged = staging / "file"
            digest, total = hashlib.sha256(), 0
            with open(os.devnull if unsafe else staged, "wb") as output:
                while True:
                    frame = read_line(stream)
                    if frame.startswith(b"C "):
                        size = int(frame[2:])
                        data = stream.read(size)
                        if len(data) != size:
                            raise ValueError("Truncated session archive chunk")
                        digest.update(data)
                        output.write(data)
                        total += size
                    elif frame.startswith(b"D "):
                        expected, expected_bytes = frame[2:].decode().split(" ")
                        break
                    elif frame == b"X":
                        expected = None  # the sender could not finish reading it
                        break
                    else:
                        raise ValueError("Unexpected session archive chunk")
            if unsafe:
                results[path] = "unsafe"
                continue
            if expected is None or digest.hexdigest() != expected or total != int(expected_bytes):
                staged.unlink(missing_ok=True)
                results[path] = "mismatch"
                continue
            target = live / path
            if target.is_file():
                current = target.stat().st_size
                if current == total and same_prefix(target, staged):
                    staged.unlink()
                    results[path] = "unchanged"
                    continue
                if current < total and same_prefix(target, staged):
                    results[path] = "grown"
                else:
                    keep = root / "versions" / host / run_id / path
                    keep.parent.mkdir(parents=True, exist_ok=True)
                    target.replace(keep)
                    results[path] = "versioned"
            else:
                results[path] = "new"
            target.parent.mkdir(parents=True, exist_ok=True)
            staged.replace(target)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    return results


def record(root, host, run_id, report):
    receipts = private_dir(root / "receipts" / host)
    save(receipts / f"{run_id}.json", report)
    save(receipts / RUN_NAME, report)


def remote_main(argv):
    parser = argparse.ArgumentParser(prog="session_archive receive")
    parser.add_argument("verb", choices=["receive", "record"])
    parser.add_argument("--root", required=True)
    parser.add_argument("--host", required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args(argv)
    if not REMOTE_ROOT.fullmatch(args.root) or ".." in args.root.split("/"):
        raise SystemExit("Invalid archive root")
    if not LABEL.fullmatch(args.host) or not RUN_ID.fullmatch(args.run_id):
        raise SystemExit("Invalid host label or run id")
    root = Path(args.root)
    if not root.is_dir():
        raise SystemExit("Archive root does not exist")
    if args.verb == "receive":
        results = receive(sys.stdin.buffer, root, args.host, args.run_id)
        sys.stdout.write(json.dumps({"contract": CONTRACT, "results": results}) + "\n")
    else:
        record(root, args.host, args.run_id, json.loads(sys.stdin.buffer.read().decode("utf-8")))
        sys.stdout.write(json.dumps({"contract": CONTRACT, "recorded": True}) + "\n")
    return 0


# --------------------------------------------------------------------------
# Sending side (source host)
# --------------------------------------------------------------------------

def own_source():
    """This file's code, also when it was itself started from a bootstrap."""
    source = globals().get("__source__")
    return source if source else Path(__file__).read_bytes()


def packed():
    return base64.b64encode(zlib.compress(own_source(), 9)).decode()


class SshArchive:
    """The archive host, reached over SSH; the receiver code travels with each call."""

    def __init__(self, target, root, ssh=("ssh",), python="python3"):
        if not SSH_TARGET.fullmatch(target) or target.startswith("-"):
            raise ValueError("Invalid destination SSH target")
        if not REMOTE_ROOT.fullmatch(root) or ".." in root.split("/"):
            raise ValueError("Invalid destination root")
        self.target, self.root, self.ssh, self.python = target, root.rstrip("/"), list(ssh), python
        self.bootstrap = ("import base64,sys,zlib;ns={'__name__':'session_archive_remote'};"
                          f"exec(zlib.decompress(base64.b64decode('{packed()}')),ns);"
                          "sys.exit(ns['remote_main'](sys.argv[1:]))")

    def call(self, verb, host, run_id, write_input, timeout=3600):
        script = " ".join([self.python, "-c", shlex.quote(self.bootstrap), verb,
                           "--root", shlex.quote(self.root), "--host", host, "--run-id", run_id])
        process = subprocess.Popen([*self.ssh, "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", self.target, script],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        # The receiver answers only after reading its whole input, so writing
        # everything first cannot fill the answer pipe.
        try:
            write_input(process.stdin)
            process.stdin.close()
        except OSError:
            pass  # the receiver stopped reading; its exit status explains why
        process.stdin = None
        out, err = process.communicate(timeout=timeout)
        if process.returncode:
            detail = err.decode("utf-8", "replace").strip().splitlines()[-1:] or [""]
            raise RuntimeError(f"Archive host call failed (exit {process.returncode}): {detail[0][:160]}")
        body = json.loads(out.decode("utf-8").strip().splitlines()[-1])
        if body.get("contract") != CONTRACT:
            raise RuntimeError("Archive host answered with another contract")
        return body


def parse_source(value):
    label, separator, path = value.partition("=")
    if not separator or not LABEL.fullmatch(label) or not path:
        raise argparse.ArgumentTypeError("A source is label=path, with a lowercase label")
    return label, Path(path)


def excluded(name, patterns):
    return name in CREDENTIAL_NAMES or any(fnmatch.fnmatch(name, pattern) for pattern in patterns)


def listing(sources, patterns):
    """Archive path -> (local path, bytes, mtime) for every regular file of every source."""
    rows, present = {}, {}
    for label, base in sources:
        if base.is_file():
            present[label] = True
            if not excluded(base.name, patterns):
                stat = base.stat()
                rows[f"{label}/{base.name}"] = (base, stat.st_size, stat.st_mtime_ns)
            continue
        present[label] = base.is_dir()
        for directory, subdirs, files in os.walk(base):  # symlinks are not followed
            subdirs.sort()
            for name in sorted(files):
                local = Path(directory) / name
                if excluded(name, patterns) or local.is_symlink() or not local.is_file():
                    continue
                relative = local.relative_to(base).as_posix()
                stat = local.stat()
                rows[f"{label}/{relative}"] = (local, stat.st_size, stat.st_mtime_ns)
    return rows, present


def frames(paths, rows, sent):
    """Write the framed files to `stream`, hashing what is actually read."""
    def write(stream):
        for path in paths:
            stream.write(b"F " + json.dumps({"path": path}).encode("utf-8") + b"\n")
            digest, total = hashlib.sha256(), 0
            try:
                with open(rows[path][0], "rb") as source:
                    for block in iter(lambda: source.read(CHUNK), b""):
                        stream.write(b"C %d\n" % len(block) + block)
                        digest.update(block)
                        total += len(block)
            except OSError:
                stream.write(b"X\n")
                continue
            stream.write(f"D {digest.hexdigest()} {total}\n".encode())
            sent[path] = (digest.hexdigest(), total)
        stream.write(b"E\n")
    return write


def acquire(state_dir):
    lock = state_dir / LOCK_NAME
    try:
        if time.time() - lock.stat().st_mtime > LOCK_STALE_SECONDS:
            lock.unlink()
    except FileNotFoundError:
        pass
    try:
        descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        raise RuntimeError("Another session archive run holds the lock")
    os.write(descriptor, str(os.getpid()).encode())
    os.close(descriptor)
    return lock


def archive(sources, archive_host, host, state_dir, excludes=DEFAULT_EXCLUDES, dry_run=False,
            batch_files=BATCH_FILES, batch_bytes=BATCH_BYTES):
    state_dir = Path(state_dir)
    state_dir.mkdir(parents=True, exist_ok=True)
    if os.name != "nt":
        state_dir.chmod(0o700)
    lock = acquire(state_dir)
    try:
        run_id = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        state = load(state_dir / STATE_NAME, {"files": {}})
        rows, present = listing(sources, excludes)
        report = {"contract": CONTRACT, "host": host, "runId": run_id, "startedAt": now(), "dryRun": dry_run,
                  "sources": present, "sourceFiles": len(rows), "unchanged": 0, "sent": 0, "new": 0, "grown": 0,
                  "versioned": 0, "mismatched": 0, "unreadable": 0, "unsafe": 0, "bytesSent": 0}
        wanted = []
        for path, (_, size, mtime) in sorted(rows.items()):
            known = state["files"].get(path)
            if known and known["bytes"] == size and known["mtime"] == mtime:
                report["unchanged"] += 1
            else:
                wanted.append(path)
        report["pending"] = len(wanted)
        batches, current, current_bytes = [], [], 0
        for path in wanted:
            if current and (len(current) >= batch_files or current_bytes + rows[path][1] > batch_bytes):
                batches.append(current)
                current, current_bytes = [], 0
            current.append(path)
            current_bytes += rows[path][1]
        if current:
            batches.append(current)
        for chunk in ([] if dry_run else batches):
            sent = {}
            results = archive_host.call("receive", host, run_id, frames(chunk, rows, sent))["results"]
            for path in chunk:
                outcome = results.get(path, "mismatch" if path in sent else "unreadable")
                if outcome in TRANSFERRED and path in sent:
                    report["sent"] += 1
                    report["bytesSent"] += sent[path][1]
                    if outcome != "unchanged":
                        report[outcome] += 1
                    _, size, mtime = rows[path]
                    # A file that grew while read is retried at the next run.
                    if sent[path][1] == size:
                        state["files"][path] = {"bytes": size, "mtime": mtime, "sha256": sent[path][0]}
                elif outcome == "unsafe":
                    report["unsafe"] += 1
                elif outcome == "unreadable" or path not in sent:
                    report["unreadable"] += 1
                else:
                    report["mismatched"] += 1
            save(state_dir / STATE_NAME, state)
        report["missingAtSource"] = sum(1 for path in state["files"] if path not in rows)
        report["archivedFiles"] = len(state["files"])
        problems = report["mismatched"] + report["unreadable"] + report["unsafe"]
        report.update(completedAt=now(), status="dry-run" if dry_run else ("verified" if not problems else "partial"))
        if not dry_run:
            body = json.dumps(report).encode("utf-8")
            archive_host.call("record", host, run_id, lambda stream: stream.write(body))
        save(state_dir / RUN_NAME, report)
        return report
    finally:
        lock.unlink(missing_ok=True)


def collect(args, ssh=("ssh",)):
    """Run `send` on the source host over SSH, from this file, back to this archive host."""
    for target in (args.source_host, args.return_host):
        if not SSH_TARGET.fullmatch(target) or target.startswith("-"):
            raise ValueError("Invalid SSH target")
    bootstrap = ("import base64,sys,zlib;s=zlib.decompress(base64.b64decode('" + packed() + "'));"
                 "exec(compile(s,'session_archive.py','exec'),{'__name__':'__main__','__source__':s})")
    words = ["python3", "-c", bootstrap, "send", "--host-label", args.host_label,
             "--destination-host", args.return_host, "--destination-root", args.destination_root,
             "--state-dir", str(args.state_dir)]
    for label, path in args.source:
        words += ["--source", f"{label}={path.as_posix()}"]
    for pattern in args.exclude or ():
        words += ["--exclude", pattern]
    if args.dry_run:
        words.append("--dry-run")
    command = [*ssh, "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", args.source_host,
               " ".join(shlex.quote(word) for word in words)]
    result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, timeout=4 * 3600)
    output = result.stdout.decode("utf-8", "replace").strip()
    if not output:
        detail = result.stderr.decode("utf-8", "replace").strip().splitlines()[-1:] or [""]
        output = json.dumps({"contract": CONTRACT, "status": "failed", "at": now(), "error": "SourceHostUnavailable",
                             "detail": f"exit {result.returncode}: {detail[0][:160]}"})
        print(output)
        return 1
    print(output.splitlines()[-1])
    return result.returncode


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("verb", choices=["send", "collect"],
                        help="send: from this host; collect: from --source-host, run on the archive host")
    parser.add_argument("--host-label", required=True, help="Lowercase name of the source host, e.g. devx")
    parser.add_argument("--source", action="append", required=True, type=parse_source,
                        help="label=path of a directory or file to archive; repeat for each source")
    parser.add_argument("--destination-host", help="send: SSH target of the archive host")
    parser.add_argument("--destination-root", required=True, help="Existing absolute directory on the archive host")
    parser.add_argument("--state-dir", required=True, type=Path,
                        help="Private directory for state and receipts, on the source host")
    parser.add_argument("--source-host", help="collect: SSH target of the source host")
    parser.add_argument("--return-host", help="collect: SSH target of this archive host as seen from the source host")
    parser.add_argument("--exclude", action="append", help="Extra file-name glob to skip")
    parser.add_argument("--dry-run", action="store_true", help="Count what would be sent; send nothing")
    args = parser.parse_args(argv)
    if not LABEL.fullmatch(args.host_label):
        parser.error("--host-label must be lowercase letters, digits and dashes")
    labels = [label for label, _ in args.source]
    if len(set(labels)) != len(labels):
        parser.error("Each source needs its own label")
    if args.verb == "collect":
        if not args.source_host or not args.return_host:
            parser.error("collect needs --source-host and --return-host")
        try:
            return collect(args)
        except (ValueError, OSError, subprocess.TimeoutExpired) as error:
            print(json.dumps({"contract": CONTRACT, "status": "failed", "at": now(), "error": type(error).__name__,
                              "detail": str(error)[:200]}))
            return 1
    if not args.destination_host:
        parser.error("send needs --destination-host")
    excludes = DEFAULT_EXCLUDES + tuple(args.exclude or ())
    try:
        destination = SshArchive(args.destination_host, args.destination_root)
        report = archive(args.source, destination, args.host_label, args.state_dir, excludes, args.dry_run)
    except Exception as error:
        failure = {"contract": CONTRACT, "status": "failed", "at": now(), "error": type(error).__name__,
                   "detail": str(error)[:200]}
        try:
            save(args.state_dir / RUN_NAME, failure)
        except OSError:
            pass
        print(json.dumps(failure))
        return 1
    print(json.dumps(report))
    return 0 if report["status"] in ("verified", "dry-run") else 2


if __name__ == "__main__":
    sys.exit(main())
