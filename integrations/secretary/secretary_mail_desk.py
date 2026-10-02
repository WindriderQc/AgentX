#!/usr/bin/env python3
"""Dad desk view of the Secretary's actionable Gmail labels.

Runs on the OpenClaw host with the Secretary's existing gog authorization; Core
calls it over the same SSH boundary as the other host controls. It lists the
threads the triage labelled Urgent or Needs Reply, removes that one label when
Dad has handled a thread, counts recent Inbox mail the triage has not labelled
yet, and ranks the senders it most often leaves in Review so Dad can turn them
into rules. It never reads a body, sends, archives or trashes.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from typing import Any

LABELS = {"urgent": "Secretary/Urgent", "needs-reply": "Secretary/Needs Reply"}
PROCESSED_LABEL = "Secretary/Processed"
THREAD_ID = re.compile(r"^[0-9a-f]{10,32}$")
BACKLOG_CAP = 100
REVIEW_LABEL = "Secretary/Review"
SENDER_SAMPLE = 300
SENDER_TOP = 25
ADDRESS = re.compile(r"[^\s<>\"',;]+@[^\s<>\"',;]+")
EVIDENCE_ROOT = Path(os.environ.get("GMAIL_SECRETARY_ROOT") or Path.home() / ".local/share/agentx/secretary-evidence")
CATCHUP_FIELDS = ("phase", "startedAt", "updatedAt", "finishedAt", "pending", "reviewed", "failed",
                  "remaining", "pagesPerHour", "etaHours", "lane")
CATCHUP_LOCK_FRESH_SECONDS = 1800


class MailDeskError(RuntimeError):
    def __init__(self, message: str, code: str = "SECRETARY_MAIL_FAILED", status: int = 503):
        super().__init__(message)
        self.code = code
        self.status = status


def native_settings() -> dict[str, Any]:
    """Reuse the Gmail owner's existing native settings without copying secrets."""
    config_path = Path(os.environ.get("OPENCLAW_CONFIG_PATH") or Path.home() / ".openclaw/openclaw.json")
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
        settings = config.get("plugins", {}).get("entries", {}).get("gmail-secretary", {}).get("config", {})
        return settings if isinstance(settings, dict) else {}
    except (OSError, ValueError, AttributeError):
        return {}


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    settings = native_settings()
    parser = argparse.ArgumentParser()
    parser.add_argument("--account", default=os.environ.get("GMAIL_SECRETARY_ACCOUNT") or settings.get("account"))
    parser.add_argument("--gog", default=os.environ.get("GMAIL_SECRETARY_GOG") or settings.get("gogPath") or "gog")
    parser.add_argument("--keyring-password-file", default=os.environ.get("GMAIL_SECRETARY_KEYRING_FILE") or settings.get("keyringPasswordFile"))
    parser.add_argument("--timezone", default=os.environ.get("GMAIL_SECRETARY_TIMEZONE") or settings.get("timezone") or "UTC")
    parser.add_argument("--timeout-seconds", type=int, default=25)
    commands = parser.add_subparsers(dest="command", required=True)
    threads = commands.add_parser("threads")
    threads.add_argument("--label", choices=sorted(LABELS), required=True)
    threads.add_argument("--max", type=int, default=50)
    handled = commands.add_parser("handled")
    handled.add_argument("--label", choices=sorted(LABELS), required=True)
    handled.add_argument("--thread", required=True)
    backlog = commands.add_parser("backlog")
    backlog.add_argument("--days", type=int, default=7)
    senders = commands.add_parser("senders")
    senders.add_argument("--max", type=int, default=SENDER_SAMPLE)
    commands.add_parser("catchup")
    return parser.parse_args(argv)


def gmail_environment(password_file: Path) -> dict[str, str]:
    try:
        password = password_file.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise MailDeskError("cannot read the Gmail keyring password", "SECRETARY_MAIL_KEYRING") from exc
    if not password:
        raise MailDeskError("the Gmail keyring password is empty", "SECRETARY_MAIL_KEYRING")
    env = os.environ.copy()
    env["GOG_KEYRING_BACKEND"] = "file"
    env["GOG_KEYRING_PASSWORD"] = password
    return env


def failure(stdout: str, stderr: str, returncode: int) -> MailDeskError:
    lowered = " ".join((stderr or stdout).split()).lower()
    if "no auth for" in lowered or "invalid_grant" in lowered or "expired or revoked" in lowered:
        return MailDeskError(
            "Gmail authorization is missing or revoked; the owner must run gog auth add",
            "SECRETARY_MAIL_AUTH",
        )
    if "timeout" in lowered or "timed out" in lowered:
        return MailDeskError("the Gmail request timed out", "SECRETARY_MAIL_TIMEOUT")
    return MailDeskError(f"the Gmail request exited {returncode}")


def run_gog(args: argparse.Namespace, exact: str, command: list[str], *, readonly: bool = True) -> Any:
    base = [
        args.gog,
        *(["--readonly"] if readonly else []),
        "--gmail-no-send",
        "--no-input",
        "--json",
        f"--enable-commands-exact={exact}",
        f"--account={args.account}",
    ]
    try:
        result = subprocess.run(
            [*base, *command],
            env=gmail_environment(Path(args.keyring_password_file)),
            text=True,
            capture_output=True,
            check=False,
            timeout=max(1, args.timeout_seconds),
        )
    except subprocess.TimeoutExpired as exc:
        raise MailDeskError("the Gmail request timed out", "SECRETARY_MAIL_TIMEOUT") from exc
    if result.returncode != 0:
        raise failure(result.stdout, result.stderr, result.returncode)
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise MailDeskError("Gmail returned invalid JSON") from exc


def public_thread(row: dict[str, Any]) -> dict[str, Any]:
    thread_id = str(row.get("id") or "")
    labels = row.get("labels") if isinstance(row.get("labels"), list) else []
    return {
        "threadId": thread_id,
        "from": str(row.get("from") or "")[:200],
        "subject": str(row.get("subject") or "")[:300],
        "date": str(row.get("date") or "")[:40],
        "unread": "UNREAD" in labels,
        "inbox": "INBOX" in labels,
        "messageCount": int(row.get("messageCount") or 0),
        "gmailUrl": f"https://mail.google.com/mail/#all/{thread_id}",
    }


def list_threads(args: argparse.Namespace) -> dict[str, Any]:
    label = LABELS[args.label]
    limit = min(50, max(1, args.max))
    payload = run_gog(args, "gmail.search", [
        "gmail", "search", f'label:"{label}"', f"--max={limit}", f"--timezone={args.timezone}",
    ])
    rows = payload.get("threads") if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        raise MailDeskError("Gmail returned an unexpected thread list")
    threads = [public_thread(row) for row in rows if isinstance(row, dict) and THREAD_ID.match(str(row.get("id") or ""))]
    return {
        "label": args.label,
        "gmailLabel": label,
        "count": len(threads),
        "more": bool(isinstance(payload, dict) and payload.get("nextPageToken")),
        "threads": threads,
    }


def thread_label_ids(args: argparse.Namespace, thread_id: str) -> set[str]:
    payload = run_gog(args, "gmail.thread.get", ["gmail", "thread", "get", thread_id])
    thread = payload.get("thread") if isinstance(payload, dict) and isinstance(payload.get("thread"), dict) else payload
    messages = thread.get("messages") if isinstance(thread, dict) else None
    if not isinstance(messages, list) or not messages:
        raise MailDeskError("the Gmail thread was not found", "SECRETARY_MAIL_THREAD_NOT_FOUND", 404)
    found: set[str] = set()
    for message in messages:
        found.update(str(label) for label in (message.get("labelIds") or []))
    return found


def label_id(args: argparse.Namespace, name: str) -> str:
    payload = run_gog(args, "gmail.labels.list", ["gmail", "labels", "list"])
    rows = payload if isinstance(payload, list) else (payload.get("labels") if isinstance(payload, dict) else None)
    for row in rows or []:
        if isinstance(row, dict) and row.get("name") == name:
            return str(row.get("id"))
    raise MailDeskError(f"the Gmail label {name} does not exist", "SECRETARY_MAIL_LABEL_MISSING", 409)


def mark_handled(args: argparse.Namespace) -> dict[str, Any]:
    thread_id = str(args.thread or "").strip().lower()
    if not THREAD_ID.match(thread_id):
        raise MailDeskError("thread must be a Gmail thread id", "SECRETARY_MAIL_BAD_THREAD", 400)
    label = LABELS[args.label]
    wanted = label_id(args, label)
    if wanted not in thread_label_ids(args, thread_id):
        return {"threadId": thread_id, "label": args.label, "removed": False, "verified": True}
    run_gog(args, "gmail.labels.modify", ["gmail", "labels", "modify", thread_id, f"--remove={label}"], readonly=False)
    # The acknowledgement is not the evidence: read the thread back.
    if wanted in thread_label_ids(args, thread_id):
        raise MailDeskError("Gmail still shows the label on this thread", "SECRETARY_MAIL_NOT_APPLIED", 502)
    return {"threadId": thread_id, "label": args.label, "removed": True, "verified": True}


def backlog(args: argparse.Namespace) -> dict[str, Any]:
    days = min(30, max(1, args.days))
    query = f'in:inbox -label:"{PROCESSED_LABEL}" newer_than:{days}d'
    # --results-only drops the page token, so reaching the cap is the only
    # signal that more exist; the desk shows it as "100+".
    rows = run_gog(args, "gmail.messages.search", [
        "--results-only", "--select=id",
        "gmail", "messages", "search", query, f"--max={BACKLOG_CAP}", f"--timezone={args.timezone}",
    ])
    if not isinstance(rows, list):
        raise MailDeskError("Gmail returned an unexpected message list")
    return {"query": query, "days": days, "unlabelled": len(rows), "capped": len(rows) >= BACKLOG_CAP}


def sender_address(value: str) -> str:
    text = str(value or "").lower()
    bracket = re.search(r"<([^<>\s]+@[^<>\s]+)>", text)
    if bracket:
        return bracket.group(1)
    bare = ADDRESS.search(text)
    return bare.group(0) if bare else ""


def review_senders(args: argparse.Namespace) -> dict[str, Any]:
    """Rank recent Review messages by sender; metadata only, never bodies."""
    limit = min(500, max(1, args.max))
    payload = run_gog(args, "gmail.messages.search", [
        "gmail", "messages", "search", f'label:"{REVIEW_LABEL}"', f"--max={limit}", f"--timezone={args.timezone}",
    ])
    rows = payload.get("messages") if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        raise MailDeskError("Gmail returned an unexpected message list")
    counts: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        address = sender_address(row.get("from"))
        if not address:
            continue
        entry = counts.setdefault(address, {"address": address, "domain": address.rsplit("@", 1)[1],
                                            "name": str(row.get("from") or "").split("<")[0].strip().strip('"')[:80],
                                            "count": 0, "sampleSubject": str(row.get("subject") or "")[:160]})
        entry["count"] += 1
    ranked = sorted(counts.values(), key=lambda entry: (-entry["count"], entry["address"]))
    return {"label": REVIEW_LABEL, "sampled": len(rows),
            "more": bool(isinstance(payload, dict) and payload.get("nextPageToken")), "senders": ranked[:SENDER_TOP]}


def catchup(_args: argparse.Namespace, root: Path | None = None) -> dict[str, Any]:
    """Counts of the archive catch-up job (mail_catchup.py): no Gmail call, no content."""
    root = root or EVIDENCE_ROOT

    def read(name: str, default: Any) -> Any:
        try:
            return json.loads((root / name).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return default
    status = read("catchup-status.json", {})
    proposals = read("catchup-proposals.json", [])
    proposals = proposals if isinstance(proposals, list) else []
    lock = root / "catchup.lock"
    try:
        running = time.time() - lock.stat().st_mtime < CATCHUP_LOCK_FRESH_SECONDS
    except OSError:
        running = False
    paused = status.get("paused") if isinstance(status.get("paused"), dict) else None
    return {"known": bool(status), "running": running, **{key: status.get(key) for key in CATCHUP_FIELDS},
            "paused": {"reason": str(paused.get("reason"))[:120], "since": paused.get("since")} if paused else None,
            "proposalsPending": sum(1 for p in proposals if isinstance(p, dict) and p.get("state") == "pending"),
            "proposalsQueued": sum(1 for p in proposals if isinstance(p, dict) and p.get("state") == "queued")}


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(argv)
    except SystemExit:
        # argparse already explained itself on stderr; the caller still gets an envelope.
        print(json.dumps({"status": "error", "code": "SECRETARY_MAIL_BAD_REQUEST", "statusCode": 400,
                          "message": "the Secretary mail request is not valid"}))
        return 0
    try:
        if args.command == "catchup":
            # Reads the private archive status only; no Gmail account is involved.
            print(json.dumps({"status": "success", "data": catchup(args)}, ensure_ascii=False))
            return 0
        if not args.account or not args.keyring_password_file:
            raise MailDeskError("Configure the Secretary account and keyring password file", "SECRETARY_MAIL_CONFIGURATION_INVALID")
        data = {"threads": list_threads, "handled": mark_handled, "backlog": backlog, "senders": review_senders}[args.command](args)
        print(json.dumps({"status": "success", "data": data}, ensure_ascii=False))
    except MailDeskError as exc:
        # Exit 0 with an error envelope: the SSH caller parses stdout either way.
        print(json.dumps({"status": "error", "code": exc.code, "statusCode": exc.status, "message": str(exc)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
