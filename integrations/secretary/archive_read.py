"""Bounded reading of a pinned archived original, without a provider call."""
from __future__ import annotations

import email
from email import policy
import hashlib
from pathlib import Path
import re

from evidence_store import load

MAX_BYTES = 64 * 1024 * 1024


class ArchiveReadError(RuntimeError):
    def __init__(self, message, code="SECRETARY_ARCHIVE_UNAVAILABLE", status=503):
        super().__init__(message)
        self.code, self.status = code, status


def read_original(root, message_id, source_sha256, offset=0, size=10000):
    root = Path(root).resolve()
    if not re.fullmatch(r"[a-zA-Z0-9_-]{8,256}", message_id or "") \
            or not re.fullmatch(r"[a-f0-9]{64}", source_sha256 or "") \
            or type(offset) is not int or offset < 0 or type(size) is not int or not 1 <= size <= 20000:
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
    body = message.get_body(preferencelist=("plain", "html"))
    content = body.get_content() if body else ""
    if not isinstance(content, str):
        content = ""
    if body and body.get_content_type() == "text/html":
        from secretary_evidence import TextHTML
        parser = TextHTML()
        parser.feed(content)
        content = "".join(parser.chunks)
    if offset > len(content):
        raise ArchiveReadError("The source offset is outside the message", "SECRETARY_ARCHIVE_INVALID", 400)
    end = min(len(content), offset + size)
    attachments = [{"filename": str(part.get_filename())[:300], "mimeType": part.get_content_type()}
                   for part in message.walk() if part.get_filename()]
    return {"messageId": message_id, "threadId": receipt.get("threadId"), "sourceSha256": source_sha256,
            "representation": "archived-original-message", "readerContract": "secretary.archive-reader/v1",
            "bodyReadable": body is not None, "headers": {key: str(message.get(key) or "")[:2000]
                for key in ("From", "To", "Cc", "Date", "Subject")},
            "offset": offset, "nextOffset": end if end < len(content) else None,
            "body": content[offset:end], "bodyTruncated": end < len(content), "totalChars": len(content),
            "attachments": attachments[:100], "attachmentCount": len(attachments),
            "attachmentContentIncluded": False}
