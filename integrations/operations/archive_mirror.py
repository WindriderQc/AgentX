#!/usr/bin/env python3
"""Append-only off-host mirror of a private archive directory, pulled over SSH.

Copies new and changed files from a source directory on another host (ideally a
read-only ZFS snapshot) into a local destination, verifying every file by
SHA-256 against the source. Nothing is ever deleted at the destination: a file
that changed at the source keeps its previous local copy under versions/, and a
file that disappeared at the source is only counted. Run it from an existing
scheduler; it installs nothing. Receipts hold counts, never file contents.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import threading
import time


SAFE_PATH = re.compile(r"[A-Za-z0-9._@+=-]+(?:/[A-Za-z0-9._@+=-]+)*")
SAFE_HOST = re.compile(r"[A-Za-z0-9_.@:-]+")
DEFAULT_EXCLUDES = ("downloads/*", "*.tmp", "*.partial", "backfill.lock")
BATCH_FILES = 2000
STATE_NAME = "mirror-state.json"
RUN_NAME = "latest-run.json"


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def load(file, default=None):
    return json.loads(file.read_text(encoding="utf-8")) if file.exists() else default


def save(file, value):
    file.parent.mkdir(parents=True, exist_ok=True)
    temp = file.with_name(file.name + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(file)


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def private_directory(path):
    """Owner-only access: chmod on POSIX, an explicit non-inherited ACL on Windows."""
    path.mkdir(parents=True, exist_ok=True)
    if os.name != "nt":
        path.chmod(0o700)
        return
    user = os.environ.get("USERNAME")
    if not user:
        raise RuntimeError("USERNAME is not set; cannot restrict the destination ACL")
    grants = [f"{user}:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"]
    command = ["icacls", str(path), "/inheritance:r"]
    for grant in grants:
        command += ["/grant:r", grant]
    subprocess.run(command, check=True, capture_output=True)


class Remote:
    """The source side: listing, hashing and streaming files over SSH."""

    def __init__(self, host, root, ssh=("ssh",)):
        if not SAFE_HOST.fullmatch(host) or host.startswith("-"):
            raise ValueError("Invalid source SSH target")
        if not root.startswith("/") or ".." in root or not SAFE_PATH.fullmatch(root.strip("/")):
            raise ValueError("Invalid source root")
        self.host, self.root, self.ssh = host, root.rstrip("/"), list(ssh)

    def command(self, script):
        return [*self.ssh, "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", self.host, script]

    def run(self, script, data=None):
        result = subprocess.run(self.command(script), input=data, capture_output=True, timeout=3600)
        if result.returncode:
            raise RuntimeError(f"Remote command failed (exit {result.returncode})")
        return result.stdout

    def resolve_root(self, latest_snapshot):
        if not latest_snapshot:
            return self.root
        names = self.run(f"ls -1 {shlex.quote(self.root + '/.zfs/snapshot')}").decode().split()
        names = sorted(name for name in names if SAFE_PATH.fullmatch(name))
        if not names:
            raise RuntimeError("No ZFS snapshot found for the source")
        return f"{self.root}/.zfs/snapshot/{names[-1]}"

    def listing(self, root):
        out = self.run(f"cd {shlex.quote(root)} && find . -type f -printf '%s %T@ %P\\0'")
        rows = {}
        for record in out.split(b"\0"):
            if record:
                size, mtime, path = record.decode("utf-8", "replace").split(" ", 2)
                rows[path] = {"bytes": int(size), "mtime": mtime}
        return rows

    def hashes(self, root, paths):
        out = self.run(f"cd {shlex.quote(root)} && xargs -0 sha256sum --", b"\0".join(p.encode() for p in paths))
        result = {}
        for line in out.decode().splitlines():
            digest, path = line.split("  ", 1)
            result[path] = digest
        return result

    def stream(self, root, paths):
        """Popen streaming a tar of the given paths on stdout.

        The path list is written from a thread: the remote tar starts sending
        before it has read the whole list, so writing it all first can block
        both sides once the pipes fill.
        """
        process = subprocess.Popen(self.command(f"cd {shlex.quote(root)} && tar -cf - --null -T -"),
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        data = b"\0".join(p.encode() for p in paths)

        def feed():
            try:
                process.stdin.write(data)
            except OSError:
                pass  # the transfer failed; wait() reports it
            finally:
                process.stdin.close()
        threading.Thread(target=feed, daemon=True).start()
        return process


def excluded(path, patterns):
    return any(PurePosixPath(path).match(pattern) for pattern in patterns)


def mirror(remote, destination, excludes=DEFAULT_EXCLUDES, latest_snapshot=False, batch=BATCH_FILES):
    destination = Path(destination).resolve()
    private_directory(destination)
    data, staging = destination / "current", destination / "staging"
    data.mkdir(exist_ok=True)
    run_id = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    state = load(destination / STATE_NAME, {"files": {}})
    root = remote.resolve_root(latest_snapshot)
    listing = remote.listing(root)
    report = {"startedAt": now(), "source": f"{remote.host}:{root}", "sourceFiles": 0, "copied": 0,
              "versioned": 0, "unchanged": 0, "mismatched": 0, "unsafePaths": 0, "bytesCopied": 0}
    wanted = []
    for path, meta in sorted(listing.items()):
        if excluded(path, excludes):
            continue
        if not SAFE_PATH.fullmatch(path) or ".." in path.split("/"):
            report["unsafePaths"] += 1
            continue
        report["sourceFiles"] += 1
        known = state["files"].get(path)
        if known and known["bytes"] == meta["bytes"] and known["mtime"] == meta["mtime"] and (data / path).is_file():
            report["unchanged"] += 1
        else:
            wanted.append(path)
    for start in range(0, len(wanted), batch):
        chunk = wanted[start:start + batch]
        expected = remote.hashes(root, chunk)
        shutil.rmtree(staging, ignore_errors=True)
        staging.mkdir()
        process = remote.stream(root, chunk)
        with tarfile.open(fileobj=process.stdout, mode="r|") as archive:
            for member in archive:
                # Copy only the requested regular-file bytes. Do not apply tar
                # paths, links, permissions or ownership. This also works on
                # Python versions without tarfile's backported data filter.
                if (member.isfile() and member.name in expected
                        and member.name in listing and SAFE_PATH.fullmatch(member.name)
                        and ".." not in member.name.split("/")
                        and member.size == listing[member.name]["bytes"]):
                    target = staging / member.name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.extractfile(member) as source, open(target, "wb") as output:
                        shutil.copyfileobj(source, output)
        # tarfile stops at the end-of-archive marker, but tar pads its last
        # record and ssh only exits once the whole stream has been read.
        while process.stdout.read(1 << 16):
            pass
        if process.wait():
            raise RuntimeError(f"Remote tar failed (exit {process.returncode})")
        for path in chunk:
            staged = staging / path
            if not staged.is_file() or sha256_file(staged) != expected.get(path):
                report["mismatched"] += 1  # changed while read, or lost in transit: retried next run
                continue
            target = data / path
            if target.exists():
                if sha256_file(target) == expected[path]:
                    staged.unlink()
                else:
                    keep = destination / "versions" / run_id / path
                    keep.parent.mkdir(parents=True, exist_ok=True)
                    target.replace(keep)
                    report["versioned"] += 1
            if staged.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                staged.replace(target)
                report["copied"] += 1
                report["bytesCopied"] += listing[path]["bytes"]
            state["files"][path] = {**listing[path], "sha256": expected[path]}
        save(destination / STATE_NAME, state)
    shutil.rmtree(staging, ignore_errors=True)
    report["missingAtSource"] = sum(1 for path in state["files"] if path not in listing)
    report.update(completedAt=now(), status="verified" if not report["mismatched"] else "partial",
                  mirroredFiles=len(state["files"]))
    save(destination / "runs" / f"{run_id}.json", report)
    save(destination / RUN_NAME, report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-host", required=True)
    parser.add_argument("--source-root", required=True, help="Absolute directory on the source host")
    parser.add_argument("--destination", required=True, type=Path, help="Private local directory")
    parser.add_argument("--latest-zfs-snapshot", action="store_true",
                        help="Read the newest snapshot under <source-root>/.zfs/snapshot for a consistent copy")
    parser.add_argument("--exclude", action="append", help="Extra glob relative to the source root")
    parser.add_argument("--remote-receipt", help="Absolute path on the source host for a sanitized receipt")
    args = parser.parse_args()
    remote = Remote(args.source_host, args.source_root)
    excludes = DEFAULT_EXCLUDES + tuple(args.exclude or ())
    try:
        report = mirror(remote, args.destination, excludes, args.latest_zfs_snapshot)
    except Exception as error:
        failure = {"status": "failed", "at": now(), "error": type(error).__name__, "detail": str(error)[:200]}
        save(Path(args.destination).resolve() / RUN_NAME, failure)
        print(json.dumps(failure))
        return 1
    if args.remote_receipt:
        if not SAFE_PATH.fullmatch(args.remote_receipt.strip("/")) or ".." in args.remote_receipt:
            raise ValueError("Invalid remote receipt path")
        receipt = {key: report[key] for key in ("status", "completedAt", "sourceFiles", "copied",
                                                "versioned", "mismatched", "mirroredFiles")}
        receipt["destinationHost"] = os.environ.get("COMPUTERNAME") or os.uname().nodename
        quoted = shlex.quote(args.remote_receipt)
        remote.run(f"cat > {quoted}.partial && chmod 600 {quoted}.partial && mv -- {quoted}.partial {quoted}",
                   json.dumps(receipt).encode())
    print(json.dumps(report))
    return 0 if report["status"] == "verified" else 2


if __name__ == "__main__":
    sys.exit(main())
