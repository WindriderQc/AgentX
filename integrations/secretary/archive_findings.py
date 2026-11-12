"""Read one native recorded finding set, without changing mail or the archive.

The exact raw source is checked, but recorded findings are not semantic
acceptance, MIME/attachment preservation, a decision or mailbox authority.
"""
from __future__ import annotations

import json

from archive_preservation import (HASH, MAIL_ID, UUID, PreservationError, SourceFiles,
                                  checked_bytes, digest, strict_object)
from history_coverage import SECTIONS, content_hash, finding_id

CONTRACT = "secretary.archive-findings/v1"
SCOPE = "recorded-selected-message-findings-and-thread-questions"
MAX_FINDINGS = 256
MAX_QUESTIONS = 128


class FindingsError(RuntimeError):
    def __init__(self, code="SECRETARY_FINDINGS_INTEGRITY", status=409):
        super().__init__("The selected recorded archive findings could not be verified")
        self.code, self.status = code, status


def nonfinite(_value):
    raise FindingsError()


def metadata(files, path):
    value = json.loads(files.read(path), object_pairs_hook=strict_object, parse_constant=nonfinite)
    if not isinstance(value, dict):
        raise FindingsError()
    # Also rejects an overflowing JSON exponent (1e999) and invalid surrogates,
    # without changing the canonical finding identifiers used by prior imports.
    json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False).encode()
    return value


def inventory(files, message_id, thread_id, source_sha256, request_id):
    receipt = metadata(files, f"raw-receipts/{message_id}.json")
    if any(receipt.get(key) != value for key, value in (
            ("messageId", message_id), ("threadId", thread_id), ("sha256", source_sha256))):
        raise FindingsError()
    manifest = metadata(files, f"threads/{thread_id}/manifest.json")
    messages = manifest.get("messages")
    if manifest.get("threadId") != thread_id or not isinstance(messages, list) or not messages:
        raise FindingsError()
    known = set()
    for message in messages:
        mid = message.get("id") if isinstance(message, dict) else None
        if not isinstance(mid, str) or not MAIL_ID.fullmatch(mid) or mid in known \
                or ("threadId" in message and message["threadId"] != thread_id):
            raise FindingsError()
        known.add(mid)
    if message_id not in known:
        raise FindingsError()
    raw = checked_bytes(files, receipt)
    if not raw:
        raise FindingsError()
    review = metadata(files, f"reviews/{thread_id}.json")
    evidence_hash = manifest.get("evidenceHash")
    if not isinstance(evidence_hash, str) or not HASH.fullmatch(evidence_hash):
        raise FindingsError()
    if review.get("threadId") != thread_id or review.get("evidenceHash") != evidence_hash:
        raise FindingsError("SECRETARY_FINDINGS_STALE")
    findings, seen = [], set()
    for section in SECTIONS:
        items = review.get(section)
        if not isinstance(items, list):
            raise FindingsError()
        for item in items:
            mid = item.get("messageId") if isinstance(item, dict) else None
            if not isinstance(mid, str) or not MAIL_ID.fullmatch(mid) or mid not in known:
                raise FindingsError()
            identity = finding_id(thread_id, section, item)
            if identity in seen:
                raise FindingsError()
            seen.add(identity)
            if mid == message_id:
                findings.append({"findingId": identity, "section": section})
                if len(findings) > MAX_FINDINGS:
                    raise FindingsError("SECRETARY_FINDINGS_TOO_LARGE", 413)
    unresolved = review.get("unresolved")
    if not isinstance(unresolved, list):
        raise FindingsError()
    if len(unresolved) > MAX_QUESTIONS:
        raise FindingsError("SECRETARY_FINDINGS_TOO_LARGE", 413)
    questions, seen = [], set()
    for item in unresolved:
        if not isinstance(item, str) or not item.strip():
            raise FindingsError()
        identity = content_hash([thread_id, item])
        if identity in seen:
            raise FindingsError()
        seen.add(identity)
        questions.append({"questionId": identity})
    files.finish()
    # Every opened file is pinned, including metadata formatting and the raw
    # bytes. Paths and text are not returned to the consumer.
    pins = [[path, digest(data)] for path, (_, _, data) in sorted(files.files.items())]
    return {"contract": CONTRACT, "requestId": request_id, "messageId": message_id, "threadId": thread_id,
            "sourceSha256": source_sha256, "evidenceHash": evidence_hash, "reviewSha256": content_hash(review),
            "metadataSha256": digest(json.dumps(pins, separators=(",", ":"), ensure_ascii=False).encode()),
            "raw": {"sha256": source_sha256, "bytes": len(raw)},
            "findings": sorted(findings, key=lambda item: (item["section"], item["findingId"])),
            "threadQuestions": sorted(questions, key=lambda item: item["questionId"]),
            "scope": SCOPE, "semanticAcceptance": False, "executionAllowed": False}


def probe(root, message_id, thread_id, source_sha256, request_id):
    if any(not isinstance(value, str) or not pattern.fullmatch(value) for pattern, value in (
            (MAIL_ID, message_id), (MAIL_ID, thread_id), (HASH, source_sha256), (UUID, request_id))):
        raise FindingsError("SECRETARY_FINDINGS_INVALID", 400)
    files = None
    try:
        files = SourceFiles(root)
        return inventory(files, message_id, thread_id, source_sha256, request_id)
    except FindingsError:
        raise
    except PreservationError as error:
        if error.status == 413:
            raise FindingsError("SECRETARY_FINDINGS_TOO_LARGE", 413) from None
        raise FindingsError() from None
    except OSError:
        raise FindingsError("SECRETARY_FINDINGS_UNAVAILABLE", 503) from None
    except (ValueError, TypeError, LookupError, AttributeError, RecursionError):
        raise FindingsError() from None
    finally:
        if files is not None:
            files.close()
