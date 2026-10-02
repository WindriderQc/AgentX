#!/usr/bin/env python3
"""One-time catch-up of the private Secretary evidence archive.

Copies every discovered but uncollected Gmail thread into the existing archive,
back to back and without a model, then stops. It reuses the read-only collector
of secretary_evidence.py: no mailbox writes, no sending, no task or memory store.
Progress is counts and identifiers only, never message content.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from secretary_evidence import DEFAULT_ROOT, QUERIES, Archive, identifier, load, now, save  # noqa: E402


LOCK_NAME = "backfill.lock"
STATUS_NAME = "backfill-status.json"
ERRORS_NAME = "backfill-errors.json"
# secretary_evidence.native_next skips its own collection while the lock is this fresh.
LOCK_FRESH_SECONDS = 1800
RETRY_DELAYS = (5, 15, 45, 135, 300)
MAX_CONSECUTIVE_FAILURES = 5
HEAD_PAGES = 20


class Pacer:
    """Spaces provider calls and retries transient failures with backoff."""

    def __init__(self, run, min_interval=0.2, delays=RETRY_DELAYS, sleep=time.sleep, clock=time.monotonic):
        self.run, self.min_interval, self.delays = run, min_interval, delays
        self.sleep, self.clock = sleep, clock
        self.last = None
        self.calls = self.retries = 0

    def __call__(self, command):
        for attempt in range(len(self.delays) + 1):
            if self.last is not None:
                self.sleep(max(0.0, self.min_interval - (self.clock() - self.last)))
            self.last = self.clock()
            self.calls += 1
            try:
                return self.run(command)
            except (RuntimeError, subprocess.TimeoutExpired):
                # gog failures carry only an exit code; quota and network errors look alike.
                if attempt == len(self.delays):
                    raise
                self.retries += 1
                self.sleep(self.delays[attempt])


class Lock:
    """Single runner per archive; a crashed runner's lock is taken over."""

    def __init__(self, root, name=LOCK_NAME):
        self.file = Path(root) / name
        self.owner = {"pid": os.getpid(), "host": socket.gethostname(), "startedAt": now()}

    def stale(self):
        if not self.file.exists():
            return True
        held = load(self.file, {})
        if held.get("host") != self.owner["host"]:
            return time.time() - self.file.stat().st_mtime >= LOCK_FRESH_SECONDS
        try:
            os.kill(int(held.get("pid", 0)), 0)
        except (OSError, ValueError):
            return True
        return False

    def acquire(self):
        for _ in range(2):
            try:
                descriptor = os.open(self.file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            except FileExistsError:
                if not self.stale():
                    return False
                self.file.unlink(missing_ok=True)
                continue
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(self.owner, handle)
            return True
        return False

    def touch(self):
        os.utime(self.file)

    def release(self):
        if load(self.file, {}).get("pid") == self.owner["pid"]:
            self.file.unlink(missing_ok=True)


def refresh_heads(archive, pages=HEAD_PAGES):
    """Add mail newer than the completed discovery without restarting its pagination."""
    for scope, query in QUERIES.items():
        file = archive.root / f"inventory-{scope}.json"
        inventory = load(file)
        if not inventory or not inventory.get("complete"):
            while not archive.discover(scope)["complete"]:
                pass  # each call advances one resumable page
            continue
        token = None
        for _ in range(pages):
            command = ["gmail", "messages", "search", query, "--max=100"] + (["--page=" + token] if token else [])
            result = archive.run(command)
            rows = result.get("messages") or []
            fresh = [row for row in rows if identifier(row["id"]) not in inventory["messages"]]
            inventory["messages"].update({row["id"]: row for row in fresh})
            token = result.get("nextPageToken")
            if not fresh or not token:
                break
        inventory["headCheckedEpoch"] = time.time()
        save(file, inventory)


def pending_threads(archive):
    """Uncollected thread ids, newest first, across every discovered scope."""
    known = {m["threadId"]: {r["id"] for r in m["messages"]} for m in archive.manifests()}
    newest = {}
    for scope in QUERIES:
        for row in load(archive.root / f"inventory-{scope}.json", {}).get("messages", {}).values():
            if row["id"] not in known.get(row["threadId"], set()):
                newest[row["threadId"]] = max(newest.get(row["threadId"], ""), row.get("date", ""))
    return sorted(newest, key=newest.get, reverse=True)


def backfill(archive, lock, max_threads=None, clock=time.monotonic):
    root = archive.root
    errors = load(root / ERRORS_NAME, {})
    status = {"phase": "refreshing", "startedAt": now(), "collected": 0, "failed": 0}

    def report(**changes):
        status.update(changes, updatedAt=now())
        save(root / STATUS_NAME, status)
        lock.touch()

    report()
    refresh_heads(archive)
    queue = pending_threads(archive)
    started, consecutive = clock(), 0
    report(phase="collecting", pendingAtStart=len(queue), remaining=len(queue))
    for thread_id in queue[:max_threads]:
        try:
            archive.collect_thread(thread_id)
            errors.pop(thread_id, None)
            status["collected"] += 1
            consecutive = 0
        except Exception as error:  # one bad thread never stops the catch-up
            errors[thread_id] = {"error": type(error).__name__, "detail": str(error)[:200], "at": now()}
            status["failed"] += 1
            consecutive += 1
        save(root / ERRORS_NAME, errors)
        done = status["collected"] + status["failed"]
        rate = done / max(clock() - started, 1e-9) * 60
        remaining = len(queue) - done
        report(remaining=remaining, threadsPerMinute=round(rate, 1),
               etaMinutes=round(remaining / rate) if rate else None,
               providerCalls=archive.run.calls, providerRetries=archive.run.retries)
        if consecutive >= MAX_CONSECUTIVE_FAILURES:
            # Several threads in a row means quota, credentials or network, not one bad message.
            report(phase="stopped", reason="consecutive_failures")
            return status
    left = len(pending_threads(archive))
    report(phase="done" if left == 0 else "partial", remaining=left)
    return status


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--max-threads", type=int, help="Stop after this many threads (a measured trial run)")
    parser.add_argument("--min-interval", type=float, default=0.2, help="Seconds between provider calls")
    parser.add_argument("--status", action="store_true", help="Print the last progress report and exit")
    args = parser.parse_args()
    if args.status:
        print(json.dumps(load(args.root / STATUS_NAME, {"phase": "never_run"}), ensure_ascii=False))
        return 0
    if args.max_threads is not None and args.max_threads < 1:
        parser.error("--max-threads must be positive")
    archive = Archive(args.root)
    archive.run = Pacer(archive.run, args.min_interval)
    lock = Lock(archive.root)
    if not lock.acquire():
        print(json.dumps({"phase": "busy", "lock": load(lock.file, {})}))
        return 3
    try:
        result = backfill(archive, lock, args.max_threads)
    finally:
        lock.release()
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["phase"] in ("done", "partial") else 2


if __name__ == "__main__":
    sys.exit(main())
