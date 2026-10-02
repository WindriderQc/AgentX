#!/usr/bin/env python3
"""Original RFC 822 copies of every archived Gmail message, plus a completeness report.

The evidence archive keeps Gmail's parsed rendering of each thread. This adds
the message exactly as Gmail stores it (`format=raw`), saved as a
content-addressed `.eml` that any mail client can open. A copy is accepted only
when its decoded size equals Gmail's `sizeEstimate` and its Message-ID equals
the one already archived. Read-only on the mailbox; reports hold counts and
identifiers, never content.
"""
from __future__ import annotations

import argparse
import email
from email import policy
import json
import os
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mailbox_backfill import MAX_CONSECUTIVE_FAILURES, Lock, Pacer  # noqa: E402
from secretary_evidence import DEFAULT_ROOT, QUERIES, Archive, decode, identifier, load, now, save, sha  # noqa: E402


LOCK_NAME = "raw-sync.lock"
STATUS_NAME = "raw-status.json"
ERRORS_NAME = "raw-errors.json"
REPORT_NAME = "completeness-report.json"
RECEIPTS = "raw-receipts"


def folded(value):
    """A header value with folding whitespace collapsed, as Gmail's parsed view shows it."""
    return " ".join(str(value).split())


def archived_messages(archive):
    """Every message of every archived thread, newest first."""
    rows = []
    for manifest in archive.manifests():
        for message in manifest["messages"]:
            rows.append({"id": message["id"], "threadId": manifest["threadId"],
                         "internalDate": message.get("internalDate"),
                         "messageIdHeader": folded((message.get("headers") or {}).get("message-id", ""))})
    return sorted(rows, key=lambda row: int(row["internalDate"] or 0), reverse=True)


def receipt_file(root, message_id):
    return root / RECEIPTS / f"{identifier(message_id)}.json"


def verified(root, receipt, rehash=False):
    """The receipt's file exists with its recorded size (and hash when asked)."""
    if not receipt or not receipt.get("path"):
        return False
    file = root / receipt["path"]
    if not file.is_file() or file.stat().st_size != receipt["bytes"]:
        return False
    return not rehash or sha(file.read_bytes()) == receipt["sha256"]


def fetch(archive, row):
    """Store one raw message after checking it against Gmail and the archive."""
    payload = archive.run(["gmail", "get", row["id"], "--format=raw"])
    message = payload.get("message", payload)
    if message.get("id") != row["id"] or not message.get("raw"):
        raise ValueError("Gmail returned no raw copy of this message")
    data = decode(message["raw"])
    size = message.get("sizeEstimate")
    if size is not None and len(data) != int(size):
        raise ValueError("Raw size does not match Gmail sizeEstimate")
    parsed = email.message_from_bytes(data, policy=policy.compat32)
    header = folded(parsed.get("Message-ID") or "")
    if row["messageIdHeader"] and header != row["messageIdHeader"]:
        raise ValueError("Raw Message-ID does not match the archived message")
    digest = sha(data)
    relative = Path("raw") / digest[:2] / f"{digest}.eml"
    target = archive.root / relative
    if not (target.is_file() and sha(target.read_bytes()) == digest):
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        staged = target.with_name(target.name + ".tmp")
        staged.write_bytes(data)
        staged.chmod(0o600)
        staged.replace(target)
    receipt = {"messageId": row["id"], "threadId": row["threadId"], "sha256": digest, "bytes": len(data),
               "path": relative.as_posix(), "internalDate": message.get("internalDate"),
               "historyId": message.get("historyId"), "labelIds": message.get("labelIds", []),
               "messageIdMatched": bool(row["messageIdHeader"]), "fetchedAt": now()}
    save(receipt_file(archive.root, row["id"]), receipt)
    return receipt


def sync(archive, lock, max_messages=None, rehash=False, clock=time.monotonic):
    root = archive.root
    errors = load(root / ERRORS_NAME, {})
    status = {"phase": "collecting", "startedAt": now(), "fetched": 0, "failed": 0}
    queue = [row for row in archived_messages(archive)
             if not verified(root, load(receipt_file(root, row["id"])), rehash)]
    started, consecutive = clock(), 0
    status.update(pendingAtStart=len(queue), remaining=len(queue))

    def report(**changes):
        status.update(changes, updatedAt=now())
        save(root / STATUS_NAME, status)
        lock.touch()

    report()
    for row in queue[:max_messages]:
        try:
            fetch(archive, row)
            errors.pop(row["id"], None)
            status["fetched"] += 1
            consecutive = 0
        except Exception as error:  # one bad message never stops the copy
            errors[row["id"]] = {"threadId": row["threadId"], "error": type(error).__name__,
                                 "detail": str(error)[:200], "at": now()}
            status["failed"] += 1
            consecutive += 1
        save(root / ERRORS_NAME, errors)
        done = status["fetched"] + status["failed"]
        rate = done / max(clock() - started, 1e-9) * 60
        report(remaining=len(queue) - done, messagesPerMinute=round(rate, 1),
               etaMinutes=round((len(queue) - done) / rate) if rate else None,
               providerCalls=archive.run.calls, providerRetries=archive.run.retries)
        if consecutive >= MAX_CONSECUTIVE_FAILURES:
            report(phase="stopped", reason="consecutive_failures")
            return status
    left = sum(1 for row in archived_messages(archive) if not verified(root, load(receipt_file(root, row["id"]))))
    report(phase="done" if left == 0 else "partial", remaining=left)
    return status


def completeness(archive, rehash=False):
    """Per scope: discovered messages, archived in a thread, and with a verified original."""
    root = archive.root
    archived = {row["id"] for row in archived_messages(archive)}
    report = {"at": now(), "rehashed": rehash, "scopes": {}}
    raw_ok = {}
    for scope in QUERIES:
        inventory = load(root / f"inventory-{scope}.json", {})
        discovered = set(inventory.get("messages", {}))
        missing_thread = sorted(discovered - archived)
        for mid in discovered & archived:
            if mid not in raw_ok:
                raw_ok[mid] = verified(root, load(receipt_file(root, mid)), rehash)
        missing_raw = sorted(mid for mid in discovered & archived if not raw_ok[mid])
        report["scopes"][scope] = {
            "discoveryComplete": bool(inventory.get("complete")), "discovered": len(discovered),
            "archived": len(discovered) - len(missing_thread),
            "rawVerified": len(discovered) - len(missing_thread) - len(missing_raw),
            "missingThread": missing_thread, "missingRaw": missing_raw}
    in_threads = [verified(root, load(receipt_file(root, mid)), rehash) for mid in archived]
    report["allArchivedMessages"] = {"messages": len(archived), "rawVerified": sum(in_threads)}
    report["complete"] = all(s["discoveryComplete"] and not s["missingThread"] and not s["missingRaw"]
                             for s in report["scopes"].values()) and all(in_threads)
    save(root / REPORT_NAME, report)
    return report


def summary(report):
    """The report without identifier lists, for printing."""
    return {**report, "scopes": {scope: {k: (len(v) if isinstance(v, list) else v) for k, v in row.items()}
                                 for scope, row in report["scopes"].items()}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("sync", help="Fetch the original of every archived message that lacks one")
    run.add_argument("--max-messages", type=int)
    run.add_argument("--min-interval", type=float, default=0.2)
    run.add_argument("--rehash", action="store_true", help="Also refetch originals whose SHA-256 no longer matches")
    sub.add_parser("completeness").add_argument("--rehash", action="store_true",
                                                help="Re-read every original and compare its SHA-256")
    sub.add_parser("status")
    args = parser.parse_args()
    archive = Archive(args.root)
    if args.command == "status":
        print(json.dumps(load(archive.root / STATUS_NAME, {"phase": "never_run"})))
        return 0
    if args.command == "completeness":
        report = completeness(archive, args.rehash)
        print(json.dumps(summary(report)))
        return 0 if report["complete"] else 2
    if args.max_messages is not None and args.max_messages < 1:
        parser.error("--max-messages must be positive")
    archive.run = Pacer(archive.run, args.min_interval)
    lock = Lock(archive.root, LOCK_NAME)
    if not lock.acquire():
        print(json.dumps({"phase": "busy", "lock": load(lock.file, {})}))
        return 3
    try:
        result = sync(archive, lock, args.max_messages, args.rehash)
    finally:
        lock.release()
    print(json.dumps(result))
    return 0 if result["phase"] in ("done", "partial") else 2


if __name__ == "__main__":
    sys.exit(main())
