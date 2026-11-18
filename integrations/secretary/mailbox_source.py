"""Bounded exact live Gmail source observation; no archive or mailbox writes."""
from __future__ import annotations

import base64
import binascii
import hashlib
import re

from gmail_provider import GmailProviderError

CONTRACT = "secretary.mailbox-source/v1"
SCOPE = "selected-live-message-raw-and-metadata"
MAX_BYTES = 16 * 1024 * 1024
ID = re.compile(r"[a-f0-9]{10,32}")
HASH = re.compile(r"[a-f0-9]{64}")
UUID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}")
LABEL = re.compile(r"[A-Za-z0-9_-]{1,128}")


class MailboxSourceError(RuntimeError):
    def __init__(self, code="SECRETARY_MAILBOX_SOURCE_UNAVAILABLE", status=503):
        super().__init__("The exact live Gmail source could not be qualified")
        self.code, self.status = code, status


def unique_pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError("Ambiguous live mailbox response")
        result[key] = value
    return result


def finite_constant(_):
    raise ValueError("Non-finite live mailbox response")


def decimal(value, limit):
    if type(value) is int:
        value = str(value)
    if not isinstance(value, str) or not re.fullmatch(r"0|[1-9][0-9]{0,31}", value) or int(value) > limit:
        raise MailboxSourceError()
    return value


def current(payload, message_id):
    if not isinstance(payload, dict):
        raise MailboxSourceError()
    row = payload.get("message", payload)
    if not isinstance(row, dict) or row.get("id") != message_id:
        raise MailboxSourceError()
    thread, labels, raw = row.get("threadId"), row.get("labelIds"), row.get("raw")
    if not isinstance(thread, str) or not ID.fullmatch(thread) or not isinstance(labels, list) \
            or len(labels) > 256 or any(not isinstance(x, str) or not LABEL.fullmatch(x) for x in labels) \
            or len(set(labels)) != len(labels):
        raise MailboxSourceError()
    if not isinstance(raw, str) or not 1 <= len(raw) <= 4 * ((MAX_BYTES + 2) // 3) \
            or not re.fullmatch(r"[A-Za-z0-9_-]+={0,2}", raw):
        raise MailboxSourceError()
    try:
        decoded = base64.b64decode(raw + "=" * (-len(raw) % 4), altchars=b"-_", validate=True)
    except (ValueError, binascii.Error):
        raise MailboxSourceError() from None
    encoded = base64.urlsafe_b64encode(decoded).decode("ascii")
    if raw not in (encoded, encoded.rstrip("=")) or not 1 <= len(decoded) <= MAX_BYTES:
        raise MailboxSourceError()
    return {"messageId": message_id, "threadId": thread,
            "internalDate": decimal(row.get("internalDate"), 253402300799999),
            "historyId": decimal(row.get("historyId"), 10**32 - 1),
            "labelIds": sorted(labels), "raw": {"sha256": hashlib.sha256(decoded).hexdigest(), "bytes": len(decoded)}}


def probe(message_id, thread_id, source_sha256, request_id, *, account_selection, read):
    for value, pattern in ((message_id, ID), (thread_id, ID), (source_sha256, HASH), (request_id, UUID)):
        if not isinstance(value, str) or not pattern.fullmatch(value):
            raise MailboxSourceError("SECRETARY_MAILBOX_SOURCE_INVALID", 400)
    if not isinstance(account_selection, str) or not account_selection.strip() or len(account_selection) > 1024:
        raise MailboxSourceError("SECRETARY_MAIL_CONFIGURATION_INVALID")
    observed = None
    try:
        observed = current(read(["gmail", "get", message_id, "--format=raw"]), message_id)
    except GmailProviderError as error:
        if error.kind != "not_found":
            raise MailboxSourceError() from None
    return {"contract": CONTRACT, "requestId": request_id, "messageId": message_id, "threadId": thread_id,
            "sourceSha256": source_sha256,
            # A native configured selector hash is NOT an authenticated OAuth subject.
            "accountSelectionSha256": hashlib.sha256(account_selection.encode()).hexdigest(),
            "status": "present" if observed else "not_found", "current": observed, "scope": SCOPE,
            "mailboxEffects": 0, "approvalBound": False}
