#!/usr/bin/env python3
"""Dad desk view of the Secretary's actionable Gmail labels.

Runs on the OpenClaw host with the Secretary's existing gog authorization; Core
calls it over the same SSH boundary as the other host controls. It lists the
threads the triage labelled Urgent or Needs Reply, removes that one label when
Dad has handled a thread, counts recent Inbox mail the triage has not labelled
yet, and ranks the senders it most often leaves in Review so Dad can turn them
into rules. Archived-source reading and preservation commands open bounded
native archive bytes without Gmail authorization. It never sends, archives or
trashes.
"""

from __future__ import annotations

import argparse
import base64
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
                  "remaining", "pagesPerHour", "etaHours", "lane", "unresolvedInferenceAttempts")
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
    parser.add_argument("--evidence-root", type=Path, default=os.environ.get("GMAIL_SECRETARY_ROOT") or settings.get("evidenceRoot") or EVIDENCE_ROOT)
    parser.add_argument("--timeout-seconds", type=int, default=25)
    commands = parser.add_subparsers(dest="command", required=True)
    threads = commands.add_parser("threads")
    threads.add_argument("--label", choices=sorted(LABELS), required=True)
    threads.add_argument("--max", type=int, default=50)
    threads.add_argument("--page-token-b64", default="")
    handled = commands.add_parser("handled")
    handled.add_argument("--label", choices=sorted(LABELS), required=True)
    handled.add_argument("--thread", required=True)
    handled.add_argument("--messages", default="")
    backlog = commands.add_parser("backlog")
    backlog.add_argument("--days", type=int, default=7)
    senders = commands.add_parser("senders")
    senders.add_argument("--max", type=int, default=SENDER_SAMPLE)
    commands.add_parser("catchup")
    dossier = commands.add_parser("dossier")
    dossier.add_argument("--thread", required=True)
    dossier.add_argument("--reader-contract", choices=("secretary.dossier-sources/v1", "secretary.dossier-sources/v2"), default="secretary.dossier-sources/v2")
    archived = commands.add_parser("archived")
    archived.add_argument("--message", required=True)
    archived.add_argument("--sha256", required=True)
    archived.add_argument("--offset", type=int, default=0)
    archived.add_argument("--part", type=int)
    preservation = commands.add_parser("preservation")
    preservation.add_argument("--message", required=True)
    preservation.add_argument("--thread", required=True)
    preservation.add_argument("--sha256", required=True)
    preservation.add_argument("--request-id", required=True)
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
    page = ""
    token = getattr(args, "page_token_b64", "")
    if token:
        try:
            if len(token) > 5500 or not re.fullmatch(r"[A-Za-z0-9_-]+", token):
                raise ValueError()
            page = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)).decode("utf-8")
            if len(page.encode()) > 4096:
                raise ValueError()
        except (ValueError, UnicodeError):
            raise MailDeskError("Invalid Gmail continuation", "SECRETARY_MAIL_BAD_PAGE", 400) from None
    payload = run_gog(args, "gmail.messages.search", [
        "gmail", "messages", "search", f'label:"{label}"', f"--max={limit}", f"--timezone={args.timezone}",
        *([f"--page={page}"] if page else []),
    ])
    rows = payload.get("messages") if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        raise MailDeskError("Gmail returned an unexpected thread list")
    groups = {}
    for row in rows:
        if not isinstance(row, dict) or not all(THREAD_ID.fullmatch(str(row.get(key) or "")) for key in ("id", "threadId")):
            continue
        tid = row["threadId"]
        if tid not in groups:
            groups[tid] = {**public_thread({**row, "id": tid}), "messageIds": []}
        entry = groups[tid]
        if row["id"] not in entry["messageIds"]:
            entry["messageIds"].append(row["id"])
        entry["unread"] = entry["unread"] or "UNREAD" in (row.get("labels") or [])
        entry["messageCount"] = len(entry["messageIds"])
    threads = list(groups.values())
    next_page = payload.get("nextPageToken") if isinstance(payload, dict) else None
    if next_page is not None and (not isinstance(next_page, str) or len(next_page.encode()) > 4096):
        raise MailDeskError("Gmail returned an invalid continuation")
    return {
        "label": args.label,
        "gmailLabel": label,
        "count": len(threads),
        "more": bool(next_page),
        "nextPageToken": next_page or None,
        "scope": "messages",
        "threads": threads,
    }


def thread_messages(args: argparse.Namespace, thread_id: str) -> list[dict[str, Any]]:
    payload = run_gog(args, "gmail.thread.get", ["gmail", "thread", "get", thread_id])
    thread = payload.get("thread") if isinstance(payload, dict) and isinstance(payload.get("thread"), dict) else payload
    messages = thread.get("messages") if isinstance(thread, dict) else None
    if not isinstance(messages, list) or not messages:
        raise MailDeskError("the Gmail thread was not found", "SECRETARY_MAIL_THREAD_NOT_FOUND", 404)
    return messages


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
    selected = str(getattr(args, "messages", "")).lower().split(",")
    if not 1 <= len(selected) <= 50 or len(set(selected)) != len(selected) or not all(THREAD_ID.fullmatch(mid) for mid in selected):
        raise MailDeskError("Refresh the mailbox and select exact messages before marking them handled", "SECRETARY_MAIL_BAD_MESSAGES", 400)
    label = LABELS[args.label]
    wanted = label_id(args, label)
    before = {row.get("id"): row for row in thread_messages(args, thread_id)}
    if not all(mid in before for mid in selected):
        raise MailDeskError("The selected messages changed; refresh before handling them", "SECRETARY_MAIL_SELECTION_CHANGED", 409)
    active = [mid for mid in selected if wanted in (before[mid].get("labelIds") or [])]
    if active:
        run_gog(args, "gmail.batch.modify", ["gmail", "batch", "modify", *active, f"--remove={label}"], readonly=False)
        after = {row.get("id"): row for row in thread_messages(args, thread_id)}
        if any(mid not in after or wanted in (after[mid].get("labelIds") or []) for mid in selected):
            raise MailDeskError("Gmail did not confirm the selected message changes", "SECRETARY_MAIL_NOT_APPLIED", 502)
    return {"threadId": thread_id, "messageIds": selected, "scope": "messages", "label": args.label,
            "removed": bool(active), "verified": True}


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


def catchup(args: argparse.Namespace, root: Path | None = None) -> dict[str, Any]:
    """Counts of the archive catch-up job (mail_catchup.py): no Gmail call, no content."""
    root = Path(root or getattr(args, "evidence_root", None) or EVIDENCE_ROOT)

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
    from objective_status import projection
    pending_journal = sum(1 for file in (root / "transport-state/gmail-journal-outbox").glob("*.json")
                          if re.fullmatch(r"[a-f0-9]{64}\.json", file.name))
    return {"known": bool(status), "running": running, **{key: status.get(key) for key in CATCHUP_FIELDS},
            **projection(root),
            **({"journalPending": pending_journal} if pending_journal else {}),
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
        if args.command == "preservation":
            from archive_preservation import PreservationError, probe
            try:
                data = probe(args.evidence_root, args.message, args.thread, args.sha256, args.request_id)
            except PreservationError as error:
                raise MailDeskError(str(error), error.code, error.status) from None
            print(json.dumps({"status": "success", "data": data}, ensure_ascii=False))
            return 0
        if args.command == "archived":
            from archive_read import ArchiveReadError, read_original
            try:
                data = read_original(args.evidence_root, args.message, args.sha256, args.offset, part_index=args.part)
            except ArchiveReadError as error:
                raise MailDeskError(str(error), error.code, error.status) from error
            except (OSError, ValueError, LookupError):
                raise MailDeskError("The archived original could not be read", "SECRETARY_ARCHIVE_UNAVAILABLE")
            print(json.dumps({"status": "success", "data": data}, ensure_ascii=False))
            return 0
        if args.command == "catchup":
            # Reads the private archive status only; no Gmail account is involved.
            print(json.dumps({"status": "success", "data": catchup(args)}, ensure_ascii=False))
            return 0
        if not args.account or not args.keyring_password_file:
            raise MailDeskError("Configure the Secretary account and keyring password file", "SECRETARY_MAIL_CONFIGURATION_INVALID")
        if args.command == "dossier":
            from dossier_sources import read_dossier
            from secretary_evidence import Archive
            if not THREAD_ID.fullmatch(args.thread):
                raise MailDeskError("Invalid thread ID", "SECRETARY_MAIL_BAD_THREAD", 400)
            # Archive uses the same native provider/keyring configuration. It
            # only reads; no collection, OCR or model operation is invoked.
            try:
                data = read_dossier(Archive(args.evidence_root, run=lambda command: run_gog(args, "gmail.thread.get", command)), args.thread,
                                    contract=args.reader_contract)
            except (OSError, ValueError, RuntimeError, KeyError):
                raise MailDeskError("The current correspondence could not be read", "SECRETARY_DOSSIER_SOURCE_UNAVAILABLE") from None
        else:
            data = {"threads": list_threads, "handled": mark_handled, "backlog": backlog, "senders": review_senders}[args.command](args)
        print(json.dumps({"status": "success", "data": data}, ensure_ascii=False))
    except MailDeskError as exc:
        # Exit 0 with an error envelope: the SSH caller parses stdout either way.
        print(json.dumps({"status": "error", "code": exc.code, "statusCode": exc.status, "message": str(exc)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
