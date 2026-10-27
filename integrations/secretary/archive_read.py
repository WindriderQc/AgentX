"""Bounded reading of a pinned archived original, without a provider call."""
from __future__ import annotations

import email
from email import policy
import hashlib
from pathlib import Path
import re

from evidence_store import load
from compound_sources import packet_scopes
from archive_rtf import is_rtf, read_part as read_rtf_part

MAX_BYTES = 64 * 1024 * 1024
CHARSET_ALIASES = {"windows-874": "cp874"}


class ArchiveReadError(RuntimeError):
    def __init__(self, message, code="SECRETARY_ARCHIVE_UNAVAILABLE", status=503):
        super().__init__(message)
        self.code, self.status = code, status


def _text(part):
    charset = part.get_content_charset()
    codec = CHARSET_ALIASES.get(charset)
    if codec is None:
        return part.get_content(), None
    payload = part.get_payload(decode=True)
    if not isinstance(payload, bytes):
        raise ValueError("No decoded MIME bytes for the declared charset alias")
    return payload.decode(codec, errors="strict"), {"declaredCharset": charset, "resolvedCodec": codec, "errors": "strict"}


def representations(message):
    bodies, attachments, stack, index = [], [], [(message, False, 0)], 0
    while stack:
        part, blocked, depth = stack.pop()
        if depth > 64 or index >= 4096:
            raise ArchiveReadError("This MIME tree exceeds the bounded reader", "SECRETARY_ARCHIVE_TOO_LARGE", 413)
        current = index; index += 1
        kind = part.get_content_type()
        document = bool(part.get_filename() or part.get_content_disposition() == "attachment" or kind == "message/rfc822")
        if not blocked and (document or not part.is_multipart() and kind not in ("text/plain", "text/html")):
            attachments.append({"partIndex": current, "filename": str(part.get_filename() or "(sans nom)")[:300], "mimeType": kind})
        if not blocked and not document and kind in ("text/plain", "text/html"):
            value, readable, extra, decoding = "", True, None, None
            try:
                value, decoding = _text(part)
                if not isinstance(value, str): readable, value = False, ""
                if kind == "text/html":
                    from archive_html import supplement
                    extra = supplement(value)
                    from secretary_evidence import TextHTML
                    parser = TextHTML(); parser.feed(value); value = "".join(parser.chunks)
            except (LookupError, UnicodeError, ValueError):
                readable, value = False, ""
            bodies.append({"partIndex": current, "mimeType": kind, "readable": readable, "totalChars": len(value),
                           "textSha256": hashlib.sha256(value.encode()).hexdigest() if readable else None,
                           "content": value, "part": part, "htmlEvidence": extra,
                           **({"decoding": decoding} if decoding else {})})
        if not blocked and not part.is_multipart() and is_rtf(kind, part.get_filename()):
            decoded = read_rtf_part(part)
            value = decoded["content"]
            bodies.append({"partIndex": current, "mimeType": kind, **decoded, "totalChars": len(value),
                           "textSha256": hashlib.sha256(value.encode()).hexdigest() if decoded["readable"] else None,
                           "part": part, "htmlEvidence": None, "documentPart": document})
        if part.is_multipart():
            stack.extend((child, blocked or document, depth + 1) for child in reversed(list(part.iter_parts())))
    return bodies, attachments


def read_original(root, message_id, source_sha256, offset=0, size=10000, part_index=None):
    root = Path(root).resolve()
    if not re.fullmatch(r"[a-zA-Z0-9_-]{8,256}", message_id or "") \
            or not re.fullmatch(r"[a-f0-9]{64}", source_sha256 or "") \
            or type(offset) is not int or offset < 0 or type(size) is not int or not 1 <= size <= 20000 \
            or part_index is not None and (type(part_index) is not int or not 0 <= part_index < 4096):
        raise ArchiveReadError("Invalid archived source request", "SECRETARY_ARCHIVE_INVALID", 400)
    receipt = load(root / "raw-receipts" / (message_id + ".json"), {})
    if receipt.get("messageId") != message_id or receipt.get("sha256") != source_sha256:
        raise ArchiveReadError("The archived source is absent or its revision changed", "SECRETARY_ARCHIVE_REVISION", 409)
    relative = receipt.get("path")
    file = (root / relative).resolve() if relative else root
    if not file.is_relative_to(root) or not file.is_file():
        raise ArchiveReadError("The archived original is unavailable", status=404)
    if file.stat().st_size > MAX_BYTES:
        raise ArchiveReadError("This original exceeds the bounded reader; use the archive restoration path", "SECRETARY_ARCHIVE_TOO_LARGE", 413)
    data = file.read_bytes()
    if len(data) != receipt.get("bytes") or hashlib.sha256(data).hexdigest() != source_sha256:
        raise ArchiveReadError("The archived original does not match its preservation receipt", "SECRETARY_ARCHIVE_INTEGRITY", 409)
    message = email.message_from_bytes(data, policy=policy.default)
    bodies, attachments = representations(message)
    body = message.get_body(preferencelist=("plain", "html"))
    selected = next((part for part in bodies if part["partIndex"] == part_index), None) if part_index is not None \
        else next((part for part in bodies if part["part"] is body), None)
    if part_index is None and selected is None:
        selected = next((part for part in bodies if part.get("extraction") and part["readable"]), None)
    if part_index is not None and selected is None:
        raise ArchiveReadError("Choose a text representation of this original", "SECRETARY_ARCHIVE_INVALID", 400)
    content = selected["content"] if selected else ""
    if offset > len(content):
        raise ArchiveReadError("The source offset is outside the message", "SECRETARY_ARCHIVE_INVALID", 400)
    end = min(len(content), offset + size)
    versions = [{k: v for k, v in part.items() if k not in ("content", "part", "htmlEvidence")} for part in bodies]
    extra = selected.get("htmlEvidence") if selected else None
    warnings = (["multiple_text_representations"] if len(bodies) > 1 else []) \
        + (["unreadable_text_representation"] if any(not part["readable"] for part in bodies) else [])
    if extra and extra["items"]:
        warnings.append("html_attributes_or_script_data_require_review")
    if extra and extra["truncated"]:
        warnings.append("html_supplement_truncated")
    if selected and selected.get("extraction"):
        warnings.append("rtf_text_only_not_visual_review")
    if any(part.get("extractionGaps") for part in bodies):
        warnings.append("rtf_content_has_explicit_gaps")
    thread = str(receipt.get("threadId") or "")
    manifest = load(root / "threads" / thread / "manifest.json", {}) \
        if re.fullmatch(r"[a-zA-Z0-9_-]{8,256}", thread) else {}
    archived = next((m for m in manifest.get("messages", []) if m.get("id") == message_id), {})
    compound = packet_scopes(root, archived.get("attachments", []), verify_members=False)
    if compound:
        warnings.append("compound_attachment_members_require_separate_review")
    return {"messageId": message_id, "threadId": receipt.get("threadId"), "sourceSha256": source_sha256,
            "representation": "archived-original-message", "readerContract": "secretary.archive-reader/v3",
            "bodyReadable": bool(selected and selected["readable"]),
            "bodyCompleteScope": "selected-mime-rtf-text-part" if selected and selected.get("extraction") else "selected-mime-text-part",
            "selectedPartIndex": selected["partIndex"] if selected else None,
            "bodyRepresentations": versions, "readingWarnings": warnings,
            "htmlEvidence": extra, "compoundAttachments": compound,
            "headers": {key: str(message.get(key) or "")[:2000]
                for key in ("From", "To", "Cc", "Date", "Subject")},
            "offset": offset, "nextOffset": end if end < len(content) else None,
            "body": content[offset:end], "bodyTruncated": end < len(content), "totalChars": len(content),
            "attachments": attachments[:100], "attachmentCount": len(attachments),
            "attachmentContentIncluded": bool(selected and selected.get("documentPart"))}
