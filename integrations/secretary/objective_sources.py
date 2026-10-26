"""Native archive inputs for objective reviews, preserving MIME scope and gaps."""
from __future__ import annotations

import email
from email import policy
from email.utils import parsedate_to_datetime
import hashlib
import json
from pathlib import Path

from archive_read import MAX_BYTES, representations
from evidence_attribution import body_segments, page_context
from evidence_store import load
from review_attempts import hashed
from archive_rtf import PROFILE as RTF_PROFILE


def inventory(root, selection=None):
    """Metadata only: no provider, file hashing, MIME parsing or inference."""
    root, selection = Path(root), selection or {}
    wanted_gmail = selection.get("gmailMessageIds")
    wanted_outlook = selection.get("outlookSha256")
    rows = []
    for file in sorted((root / "raw-receipts").glob("*.json")):
        receipt = load(file, {})
        mid = receipt.get("messageId")
        if wanted_gmail is not None and mid not in wanted_gmail:
            continue
        rows.append({"system": "gmail", "id": mid, "threadId": receipt.get("threadId"),
            "sha256": receipt.get("sha256"), "path": receipt.get("path"), "bytes": receipt.get("bytes"),
            "sourceDate": receipt.get("internalDate"), "labels": receipt.get("labelIds", [])})
    items = load(root / "outlook/inventory.json", {}).get("items", {})
    for digest, item in sorted(items.items()):
        if item.get("kind") != "mail" or wanted_outlook is not None and digest not in wanted_outlook:
            continue
        rows.append({"system": "outlook-export", "id": digest, "sha256": digest,
            "threadId": "outlook-" + digest, "path": item.get("path"), "bytes": item.get("bytes"),
            "sourceDate": item.get("date"), "rfc822MessageId": item.get("messageId"),
            "alsoInGmail": item.get("alsoInGmail", []), "exports": item.get("exports", [])})
    requested = {("gmail", mid) for mid in wanted_gmail or []} | {
        ("outlook-export", digest) for digest in wanted_outlook or []}
    missing = requested - {(row["system"], row["id"]) for row in rows}
    if missing:
        raise ValueError("Selected archived sources are missing: " + str(sorted(missing)))
    order = selection.get("order", [])
    ranked = {key: pos for pos, key in enumerate(order)}
    rows.sort(key=lambda row: (ranked.get(row["system"] + ":" + row["id"], len(order)), row["system"], row["id"]))
    return rows


def _file(root, relative):
    root = Path(root).resolve()
    path = (root / str(relative or "")).resolve()
    if not relative or not path.is_relative_to(root) or not path.is_file():
        raise ValueError("Archived source is unavailable or outside its native root")
    return path


def _unit(kind, text, **extra):
    return {"representation": kind, "content": text, "textSha256": hashlib.sha256(text.encode()).hexdigest(), **extra}


def materialize(root, source):
    """Verify the original, then reuse Secretary's inert MIME representation reader.

    No download, OCR, decompression, rendering, external link or mailbox effect.
    Native existing text extractions remain qualified by their extraction status.
    """
    root = Path(root)
    path = _file(root, source.get("path"))
    if path.stat().st_size > MAX_BYTES:
        raise ValueError("Original exceeds the native bounded reader")
    data = path.read_bytes()
    if len(data) != source.get("bytes") or hashlib.sha256(data).hexdigest() != source.get("sha256"):
        raise ValueError("Original does not match its native preservation receipt")
    parsed = email.message_from_bytes(data, policy=policy.default)
    bodies, documents = representations(parsed)
    headers = {key.lower(): str(parsed.get(key) or "") for key in ("From", "To", "Cc", "Date", "Subject")}
    source = {**source, "rfc822MessageId": str(parsed.get("Message-ID") or "").strip(), "headers": headers}
    try:
        source["mailDate"] = parsedate_to_datetime(headers["date"]).isoformat()
    except (ValueError, TypeError, OverflowError):
        source["mailDate"] = None
    labels = set(source.get("labels", []))
    source["direction"] = "draft" if "DRAFT" in labels else "sent" if "SENT" in labels else "received" if labels else "unknown"
    units = []
    gaps = []
    if any(body.get("extraction") for body in bodies):
        source["rtfReaderProfile"] = RTF_PROFILE
    for body in bodies:
        ref = {"partIndex": body["partIndex"], "mimeType": body["mimeType"]}
        if body.get("decoding"):
            ref["decoding"] = body["decoding"]
        if body.get("extraction"):
            ref["extraction"] = body["extraction"]
        gaps.extend({**gap, "partIndex": body["partIndex"], "mimeType": body["mimeType"]}
                    for gap in body.get("extractionGaps", []))
        if not body["readable"]:
            gaps.append({"code": "mime-text-unreadable", **ref})
            continue
        units.append(_unit("mime-text", body["content"], **ref))
        extra = body.get("htmlEvidence")
        if extra and extra.get("items"):
            units.append(_unit("html-inert-supplement", json.dumps(extra, ensure_ascii=False), **ref))
        if extra and extra.get("truncated"):
            gaps.append({"code": "html-supplement-truncated", **ref})
    if not bodies or not units and source.get("rtfReaderProfile"):
        gaps.append({"code": "no-inline-text-representation"})
        units.append(_unit("message-headers", "\n".join(key + ": " + value for key, value in headers.items())))
    archived = {}
    if source["system"] == "gmail":
        manifest = load(root / "threads" / source["threadId"] / "manifest.json", {})
        archived = next((m for m in manifest.get("messages", []) if m.get("id") == source["id"]), {})
    attachments = archived.get("attachments", [])
    for attachment in attachments:
        ref = {k: attachment.get(k) for k in ("sha256", "filename", "mimeType", "status")}
        if attachment.get("textPath"):
            file = _file(root, attachment["textPath"])
            if file.stat().st_size <= MAX_BYTES:
                text = file.read_text(encoding="utf-8", errors="replace")
                units.append(_unit("attachment-existing-text", text, attachment=ref))
            else:
                gaps.append({"code": "attachment-text-too-large", "attachment": ref})
        if attachment.get("status") != "text_extracted":
            gaps.append({"code": "visual-or-ocr-qualification-pending", "attachment": ref})
    # The original MIME listing is authoritative: extracted text does not prove
    # visual acceptance or exhaustive nested/container member analysis.
    if documents:
        gaps.append({"code": "attachment-content-not-exhaustively-qualified", "documents": documents,
                     "existingTextExtractions": len([u for u in units if u["representation"] == "attachment-existing-text"])})
    return source, units, gaps


def retain_header_scope(source, units):
    """An upgrade adds body text; it never erases an old header page identity."""
    if not any(u["representation"] == "message-headers" for u in units):
        units.append(_unit("message-headers", "\n".join(key + ": " + value for key, value in source["headers"].items())))


def pages(source, units, objective_sha, page_chars=6000, overlap=300):
    for unit in units:
        text = unit["content"]
        spans = body_segments(text, source["headers"])
        step = page_chars - overlap
        for offset in range(0, max(1, len(text)), step):
            end = min(len(text), offset + page_chars)
            content = text[offset:end]
            ref = {k: v for k, v in unit.items() if k != "content"}
            identity = {"objectiveSha256": objective_sha, "system": source["system"], "sourceSha256": source["sha256"],
                        "sourceId": source["id"], "unit": ref, "offset": offset, "end": end,
                        "contentSha256": hashlib.sha256(content.encode()).hexdigest()}
            yield {"pageId": hashed(identity), "threadId": source["threadId"], "messageId": source["id"],
                   "identity": identity, "source": source, "representation": ref, "offset": offset,
                   "end": end, "totalChars": len(text), "moreOfThisRepresentation": end < len(text),
                   "sourceContext": page_context(spans, offset, len(content), kind="body" if unit["representation"] == "mime-text" else "attachment", newer_messages=0),
                   "content": content}
            if end == len(text):
                break
