#!/usr/bin/env python3
"""Find household document candidates in Secretary's private local archive.

This command only reads existing evidence. It never contacts Gmail, moves a file,
or changes the approved RAG corpus. Its output is for an adult review surface.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import json
import os
from pathlib import Path
import re
import sys
import unicodedata

from secretary_evidence import identifier, reader_text


DEFAULT_ROOT = Path(os.environ.get(
    "GMAIL_SECRETARY_ROOT", Path.home() / ".local/share/agentx/secretary-evidence"))
DEFAULT_TERMS = ("ecole", "school", "garderie", "daycare", "hockey", "karate")
FILE_HASH = re.compile(r"^[0-9a-f]{64}$")
SUPPORTED = {".pdf", ".txt", ".md", ".docx"}
SENSITIVE_NAME = re.compile(
    r"\b(?:dentist(?:e)?|podiatr\w*|psych\w*|medical|medecin|infirmier\w*|sante|"
    r"facture|invoice|receipt|recu|refund|remboursement|compte|cotisation|"
    r"paiement|varicelle|pediculose|suspension|resiliation|convention|"
    r"dossier|avocat|questionnaire|assurance|contrat|basc)\b|aviscotisation"
)
HIGH_SIGNAL_NAME = re.compile(
    r"\b(?:messager|rentree scolaire|activites parascolaires|calendrier|hockey|karate|"
    r"rencontre de parents|assemblee generale de parents|horaire|bulletin|camp de jour)\b"
)
TIME_BOUNDED_NAME = re.compile(
    r"\b(?:janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|"
    r"novembre|decembre|automne|hiver|printemps|ete|rentree)\b"
)
MAX_REGISTER_BYTES = 64 * 1024 * 1024
MAX_TEXT_CHARS = 12000
MAX_BODY_CHARS = 12000


def folded(value):
    normalized = unicodedata.normalize("NFKD", str(value or ""))
    return "".join(char for char in normalized if not unicodedata.combining(char)).lower()


def words(value):
    return tuple(part for part in re.findall(r"[a-z0-9]+", folded(value)) if len(part) > 1)


def received_at(value):
    try:
        parsed = parsedate_to_datetime(str(value))
        return parsed.astimezone(timezone.utc).isoformat() if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc).isoformat()
    except (TypeError, ValueError, IndexError):
        return None


def private_file(root, relative, prefix):
    if not isinstance(relative, str) or not relative.startswith(prefix + "/"):
        return None
    candidate = (root / relative).resolve()
    directory = (root / prefix).resolve()
    if directory not in candidate.parents or not candidate.is_file():
        return None
    return candidate


def read_bounded(file, max_chars):
    if not file:
        return ""
    with file.open("r", encoding="utf-8", errors="replace") as source:
        return source.read(max_chars)


def load_register(root):
    file = root / "attachment-register.json"
    if not file.is_file() or file.stat().st_size > MAX_REGISTER_BYTES:
        raise ValueError("Secretary attachment register is unavailable or too large")
    rows = json.loads(file.read_text(encoding="utf-8"))
    if not isinstance(rows, list):
        raise ValueError("Secretary attachment register must contain a list")
    return rows


def message_body(root, thread_id, message_id, cache):
    key = (thread_id, message_id)
    if key in cache:
        return cache[key]
    try:
        thread = identifier(str(thread_id))
        message = identifier(str(message_id))
        original = private_file(root, f"threads/{thread}/original.json", "threads")
        if not original or original.stat().st_size > 8 * 1024 * 1024:
            cache[key] = ""
            return ""
        payload = json.loads(original.read_text(encoding="utf-8"))
        rows = payload.get("thread", payload).get("messages", [])
        found = next((row for row in rows if row.get("id") == message), None)
        cache[key] = reader_text(found)[:MAX_BODY_CHARS] if found else ""
    except (ValueError, TypeError, KeyError, OSError, json.JSONDecodeError):
        cache[key] = ""
    return cache[key]


def candidate_rows(root, query=None, since=None, include_unread=False):
    terms = words(query) if query else DEFAULT_TERMS
    if not terms:
        raise ValueError("Search query must contain a word")
    if since and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", since):
        raise ValueError("since must be YYYY-MM-DD")
    cutoff = datetime.fromisoformat(since).replace(tzinfo=timezone.utc) if since else None
    body_cache = {}
    by_hash = {}
    rows = load_register(root)
    for row in rows:
        if not isinstance(row, dict):
            continue
        digest = str(row.get("sha256") or "").lower()
        if not FILE_HASH.fullmatch(digest):
            continue
        file = private_file(root, row.get("path"), "files")
        if not file or file.suffix.lower() not in SUPPORTED:
            continue
        if file.stem != digest:
            continue
        status = str(row.get("status") or "")
        if not include_unread and status not in ("text_extracted", "ocr_text_extracted"):
            continue
        headers = row.get("headers") if isinstance(row.get("headers"), dict) else {}
        received = received_at(headers.get("date"))
        if cutoff and (not received or datetime.fromisoformat(received) < cutoff):
            continue
        title = str(row.get("filename") or "")[:200]
        subject = str(headers.get("subject") or "")[:240]
        text_file = private_file(root, row.get("textPath"), "files")
        content = read_bounded(text_file, MAX_TEXT_CHARS)
        body = message_body(root, row.get("threadId"), row.get("messageId"), body_cache)
        fields = (title, subject, body, content)
        matches = [index for index, field in enumerate(fields) if any(term in folded(field) for term in terms)]
        if not matches:
            continue
        score = sum((5, 4, 2, 1)[index] for index in matches)
        source_label = folded(title + " " + subject)
        review_flags = ["sensitive_source"] if SENSITIVE_NAME.search(source_label) else []
        high_signal = bool(HIGH_SIGNAL_NAME.search(source_label))
        source = {
            "threadId": str(row.get("threadId") or ""),
            "messageId": str(row.get("messageId") or ""),
            "gmailUrl": str(row.get("gmailUrl") or "")[:300],
            "receivedAt": received,
            "subject": subject,
        }
        current = by_hash.setdefault(digest, {
            "sha256": digest, "filename": title, "format": file.suffix.lower().lstrip("."),
            "bytes": file.stat().st_size, "textStatus": status,
            "possibleExpiry": bool(TIME_BOUNDED_NAME.search(folded(title)) or re.search(
                r"\b(?:expire|expiration|valid[ie]|jusqu.au)\b", folded(content + " " + body))),
            "preview": re.sub(r"\s+", " ", content).strip()[:1200],
            "score": score, "highSignal": high_signal, "reviewFlags": review_flags, "sources": []
        })
        current["score"] = max(current["score"], score)
        current["highSignal"] = current["highSignal"] or high_signal
        current["reviewFlags"] = sorted(set(current["reviewFlags"] + review_flags))
        if source not in current["sources"]:
            current["sources"].append(source)
    # The same bytes may arrive in multiple messages; prefer the strongest hit,
    # then the most recent source, without treating an unknown date as current.
    candidates = sorted(by_hash.values(), key=lambda item: (
        item["score"] + (5 if item["highSignal"] else 0) - (10 if item["reviewFlags"] else 0),
        max((source["receivedAt"] or "") for source in item["sources"])), reverse=True)
    return {"archiveCoverage": "partial_or_unknown", "registerAttachments": len(rows),
            "candidateCount": len(candidates), "candidates": candidates}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--query", help="Words to find in names, subjects, message bodies and extracted text")
    parser.add_argument("--since", help="Only messages received on or after YYYY-MM-DD")
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--include-unread", action="store_true", help="Show files that need visual or text review")
    args = parser.parse_args(argv)
    try:
        if not 1 <= args.limit <= 100:
            raise ValueError("limit must be between 1 and 100")
        result = candidate_rows(args.root.resolve(), args.query, args.since, args.include_unread)
        result["candidates"] = result["candidates"][:args.limit]
        result["truncated"] = result["candidateCount"] > args.limit
        print(json.dumps({"status": "success", "data": result}, ensure_ascii=False))
        return 0
    except (ValueError, OSError, json.JSONDecodeError) as error:
        print(json.dumps({"status": "error", "message": str(error)[:200]}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
