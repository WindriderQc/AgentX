#!/usr/bin/env python3
"""Index the owner's person and important mail into Core's private recall corpus.

One document per message body and one per read attachment (its extracted or
OCR text), each with its subject, date, people and preserved source. Bulk mail
and messages without a preserved original are left out. Core stores provenance
and sends the text to RAG's private owner collection; it then syncs souvenirs
and people itself. The job pauses for maintenance, deploys and benchmark work,
resumes from its private state, and replays an uncertain batch, which Core
keeps idempotent. Output holds counts only; it never contacts Gmail.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent))
from email.utils import getaddresses  # noqa: E402
from evidence_store import load, now, save  # noqa: E402
from history_import import preserved_source  # noqa: E402
from mail_catchup import CoreClient  # noqa: E402
from secretary_evidence import DEFAULT_ROOT, Archive, message_text  # noqa: E402
from value_lanes import correspondents, lanes_of, messages  # noqa: E402

KEPT_LANES = ("person", "important")
MAX_TEXT = 190_000  # Core puts the subject and people first; the corpus takes 200,000 characters at most
MAX_BATCH_DOCUMENTS = 20
MAX_BATCH_CHARS = 1_500_000  # well under Core's JSON body limit
PAUSE_SECONDS = 60


def when(message):
    try:
        stamp = int(message.get("internalDate") or 0)
    except (TypeError, ValueError):
        return None
    return datetime.fromtimestamp(stamp / 1000, timezone.utc).isoformat().replace("+00:00", "Z") if stamp > 0 else None


ASTRAL = re.compile("[\U00010000-\U0010FFFF]")


def clean(text):
    """Extracted text Core and RAG can store: no NUL (Core refuses it) and no
    character beyond the basic plane (mostly emoji), which RAG's chunking can
    split into a lone surrogate that Qdrant rejects."""
    return ASTRAL.sub("", text.replace("\x00", ""))


def people_of(headers, owner):
    found = []
    for field in ("from", "to", "cc"):
        for name, address in getaddresses([headers.get(field) or ""]):
            if address.strip().lower() not in owner and (name or address).strip():
                found.append(clean(name or address).strip()[:200])
    return list(dict.fromkeys(found))[:20]


def documents(archive, counts, maximum=None):
    """Mail bodies and read attachments of person and important messages."""
    rows = list(messages(archive))
    owner, _ = correspondents(rows)
    lanes = lanes_of(archive.root)
    originals = {}
    for tid, message, _labels in rows:
        if lanes.get(message["id"]) not in KEPT_LANES:
            counts["messagesNotPersonOrImportant"] += 1
            continue
        receipt = preserved_source(archive.root, message["id"])
        if receipt is None:
            counts["messagesWithoutPreservedOriginal"] += 1
            continue
        if tid not in originals:
            payload = load(archive.root / "threads" / tid / "original.json", {})
            originals = {tid: {m["id"]: m for m in payload.get("thread", payload).get("messages", [])}}
        headers = message.get("headers") or {}
        base = {"title": clean(headers.get("subject") or "").strip()[:300], "occurredAt": when(message),
                "people": people_of(headers, owner)}
        source = {"messageId": message["id"], "threadId": tid, "sourceSha256": receipt["sha256"]}
        original = originals[tid].get(message["id"])
        body = clean(message_text(original)).strip() if original else ""
        if body:
            counts["bodies"] += 1
            counts["truncatedTexts"] += len(body) > MAX_TEXT
            yield {**base, "documentId": f"mail:{message['id']}", "kind": "mail", "text": body[:MAX_TEXT], "source": source}
        for attachment in message.get("attachments", []):
            path = attachment.get("textPath")
            text = clean((archive.root / path).read_text(encoding="utf-8", errors="replace")).strip() if path and (archive.root / path).is_file() else ""
            if not text or not attachment.get("sha256"):
                counts["attachmentsWithoutReadText"] += 1
                continue
            counts["attachments"] += 1
            counts["truncatedTexts"] += len(text) > MAX_TEXT
            yield {**base, "documentId": f"file:{attachment['sha256'][:32]}_{message['id']}", "kind": "file",
                   "title": clean(f"{base['title']} — {attachment.get('filename') or 'pièce jointe'}")[:300], "text": text[:MAX_TEXT],
                   "source": {**source, "filename": (attachment.get("filename") or "")[:300]}}
        if maximum is not None and counts["bodies"] + counts["attachments"] >= maximum:
            return


def batches(docs):
    batch, size = [], 0
    for doc in docs:
        if batch and (len(batch) >= MAX_BATCH_DOCUMENTS or size + len(doc["text"]) > MAX_BATCH_CHARS):
            yield batch
            batch, size = [], 0
        batch.append(doc)
        size += len(doc["text"])
    if batch:
        yield batch


def digest(doc):
    return hashlib.sha256(json.dumps([doc["documentId"], doc["text"], doc["title"], doc["people"]], ensure_ascii=False).encode()).hexdigest()


def post(core, path, body, opener=urllib.request.urlopen, timeout=1800):
    request = urllib.request.Request(core.rstrip("/") + path, method="POST", headers={"content-type": "application/json"},
                                     data=json.dumps(body).encode())
    with opener(request, timeout=timeout) as response:
        reply = json.loads(response.read())
    if reply.get("status") != "success":
        raise ValueError("Core returned an unsuccessful recall receipt")
    return reply.get("data") or {}


def run(archive, core, state_file, *, client=None, opener=urllib.request.urlopen, sleep=time.sleep, maximum=None, stop=lambda: False):
    counts = Counter()
    state = load(state_file, {"schema": "agentx.secretary-recall-index/v1", "delivered": {}})
    totals = Counter()

    def report(phase, **extra):
        state.update(phase=phase, updatedAt=now(), counts=dict(counts), totals=dict(totals), **extra)
        save(state_file, state)

    pending = (doc for doc in documents(archive, counts, maximum) if state["delivered"].get(doc["documentId"]) != digest(doc))
    for batch in batches(pending):
        while True:
            if stop():
                report("stopped")
                return state
            reason = client.busy() if client else None
            if not reason:
                break
            report("paused", paused=reason)
            sleep(PAUSE_SECONDS)
        state.pop("paused", None)
        try:
            data = post(core, "/api/secretary/recall/documents", {"documents": batch}, opener)
        except (urllib.error.URLError, TimeoutError, ValueError) as error:
            detail = {}
            if isinstance(error, urllib.error.HTTPError):
                try: detail = {"httpStatus": error.code, "answer": error.read(2000).decode("utf-8", "replace")[:500]}
                except OSError: detail = {"httpStatus": error.code}
            report("unconfirmed", error=type(error).__name__, **detail,
                   batch=[doc["documentId"] for doc in batch])
            raise RuntimeError("Recall indexing answer is uncertain; rerun to replay the same documents") from error
        for doc in batch:
            state["delivered"][doc["documentId"]] = digest(doc)
        totals.update({k: data.get(k) or 0 for k in ("indexed", "unchanged", "refusedForgotten")})
        report("indexing")
    while True:
        data = post(core, "/api/secretary/recall/sync", {"limit": 200}, opener)
        totals.update({f"sync{k[0].upper()}{k[1:]}": data.get(k) or 0 for k in ("indexed", "removed")})
        if not data.get("remaining"):
            break
    for key in ("error", "httpStatus", "answer", "batch"):
        state.pop(key, None)  # an earlier interruption no longer applies
    report("done")
    return state


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--core", default=os.environ.get("AGENTX_CORE_URL", "http://127.0.0.1:3180"))
    parser.add_argument("--state", type=Path, required=True, help="private progress state outside Git")
    parser.add_argument("--max-documents", type=int, help="bound a trial")
    parser.add_argument("--plan", action="store_true", help="count documents and characters; send nothing")
    args = parser.parse_args(argv)
    archive = Archive(args.root, run=lambda _: (_ for _ in ()).throw(RuntimeError("Provider access disabled")))
    if not lanes_of(archive.root):
        parser.error("Label the archive first with value_lanes.py")
    if args.plan:
        counts = Counter()
        chars = sum(len(doc["text"]) for doc in documents(archive, counts, args.max_documents))
        print(json.dumps({"counts": dict(counts), "characters": chars}))
        return 0
    stopping = []
    signal.signal(signal.SIGTERM, lambda *_: stopping.append(True))
    state = run(archive, args.core, args.state, client=CoreClient(args.core), maximum=args.max_documents,
                stop=lambda: bool(stopping))
    print(json.dumps({k: state.get(k) for k in ("phase", "counts", "totals")}))
    return 2 if state["phase"] == "stopped" else 0


if __name__ == "__main__":
    raise SystemExit(main())
