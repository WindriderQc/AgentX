#!/usr/bin/env python3
"""Read-only chronological coverage and review backlog for an archived mailbox.

This prepares evidence for review, never a mailbox command or deletion approval.
Provider dates, original hashes, current reading receipts, unresolved findings
and independent-copy proofs remain separate. Reports are private runtime data.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re

from evidence_store import load, now, save
from secretary_evidence import Archive, DEFAULT_ROOT, message_text

SECTIONS = ("actions", "memories", "deliverables", "invoices")


def content_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def cutoff_date(value):
    date = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if date.tzinfo is None:
        raise ValueError("The cutoff must include its timezone offset")
    return date


def source_date(message):
    try:
        date = datetime.fromtimestamp(int(message["internalDate"]) / 1000, timezone.utc)
        return date if int(message["internalDate"]) > 0 else None
    except (KeyError, ValueError, OverflowError, OSError, TypeError):
        return None


def finding_id(thread_id, section, item):
    return content_hash([thread_id, section, item])


def proof_matches(proof, kind, key, expected):
    if proof.get("schema") != "agentx.secretary-archive-verification/v1" or proof.get("intact") is not True:
        return False
    if not isinstance(expected.get("sha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", expected["sha256"]) \
            or type(expected.get("bytes")) is not int or expected["bytes"] < 0 or not proof.get("at"):
        return False
    value = proof.get(kind, {}).get(key, {})
    return all(value.get(k) == expected.get(k) for k in ("sha256", "bytes"))


def independent(primary, mirror):
    # Two paths on the same machine do not establish a second failure domain.
    return bool(primary.get("host") and mirror.get("host") and primary["host"] != mirror["host"])


def message_coverage(root, manifest, message, original, review, pages, primary, mirror):
    mid, tid = message["id"], manifest["threadId"]
    reasons = []
    labels = set(original.get("labelIds") or [])
    direction = "draft" if "DRAFT" in labels else "sent" if "SENT" in labels else "received" if labels else "unknown"
    if direction == "draft":
        reasons.append("draft")
    if direction == "unknown":
        reasons.append("message_direction_unknown")
    receipt = load(root / "raw-receipts" / f"{mid}.json", {})
    raw_ok = proof_matches(primary, "raw", mid, receipt) and bool(receipt.get("sha256"))
    backup_ok = independent(primary, mirror) and proof_matches(mirror, "raw", mid, receipt)
    if not raw_ok:
        reasons.append("original_integrity_not_verified")
    if not backup_ok:
        reasons.append("independent_original_copy_not_verified")
    body_hash = hashlib.sha256(message_text(original).encode()).hexdigest()
    if not original or body_hash != message.get("bodySha256"):
        reasons.append("parsed_source_mismatch")
    current_review = review.get("evidenceHash") == manifest["evidenceHash"]
    if not current_review:
        reasons.append("review_missing_or_stale")
    unread = [p["pageId"] for p in pages if not (root / "page-reviews" / (p["pageId"] + ".json")).is_file()]
    if unread:
        reasons.append("unread_source_pages")
    native_text, visual = [], []
    missing_files = []
    for attachment in message.get("attachments", []):
        path = attachment.get("path")
        if not path or not proof_matches(primary, "attachments", path, attachment) \
                or not proof_matches(mirror, "attachments", path, attachment) or not independent(primary, mirror):
            missing_files.append(attachment.get("sha256") or attachment.get("partId"))
        (native_text if attachment.get("status") == "text_extracted" else visual).append(attachment.get("sha256"))
    if missing_files:
        reasons.append("attachment_copies_not_verified")
    if visual:
        reasons.append("attachment_analysis_needs_review")
    findings = {section: [item for item in review.get(section, []) if item.get("messageId") == mid]
                for section in SECTIONS}
    counts = {section: len(items) for section, items in findings.items()}
    if counts["actions"]:
        reasons.append("action_findings_need_reconciliation")
    if any(counts[s] for s in ("memories", "deliverables", "invoices")):
        reasons.append("information_disposition_not_verified")
    if review.get("unresolved"):
        reasons.append("thread_questions_unresolved")
    # Existing reading receipts have no independent semantic acceptance or
    # message-level classification proof. Never infer either from Processed,
    # empty findings, free-form statuses, age, or coverage=complete.
    reasons.extend(["analysis_validation_required", "message_classification_proof_required"])
    return {"messageId": mid, "threadId": tid, "sourceDate": source_date(message).isoformat() if source_date(message) else None,
            "direction": direction, "originalSha256": receipt.get("sha256"),
            "evidenceHash": manifest["evidenceHash"], "reviewSha256": content_hash(review),
            "coverage": {"originalVerified": raw_ok, "independentCopyVerified": backup_ok,
                         "reviewCurrent": current_review, "expectedPages": len(pages), "unreadPages": len(unread),
                         "attachments": len(message.get("attachments", [])), "visualReviewPending": len(visual),
                         "findings": counts, "threadQuestions": len(review.get("unresolved", []))},
            "findingIds": {s: [finding_id(tid, s, item) for item in items] for s, items in findings.items()},
            "blockers": reasons, "executionAllowed": False}


def coverage(archive, before, primary=None, mirror=None, thread_ids=None):
    root, primary, mirror = archive.root, primary or {}, mirror or {}
    rows, excluded = [], Counter()
    counts, years = Counter(), defaultdict(Counter)
    for manifest in archive.manifests():
        tid = manifest["threadId"]
        if thread_ids is not None and tid not in thread_ids:
            continue
        payload = load(root / "threads" / tid / "original.json", {})
        originals = {m["id"]: m for m in payload.get("thread", payload).get("messages", [])}
        review = load(root / "reviews" / f"{tid}.json", {})
        pages = defaultdict(list)
        for page in archive.review_pages(manifest):
            pages[page["messageId"]].append(page)
        for message in manifest["messages"]:
            date = source_date(message)
            counts["archivedMessages"] += 1
            if date and date >= before:
                excluded["at_or_after_cutoff"] += 1
                continue
            row = message_coverage(root, manifest, message, originals.get(message["id"], {}), review,
                                   pages[message["id"]], primary, mirror)
            if date is None:
                row["blockers"].append("source_date_unknown")
            rows.append(row)
            year = str(date.astimezone(before.tzinfo).year) if date else "unknown"
            years[year]["messages"] += 1
            for reason in row["blockers"]:
                counts[reason] += 1
            for key in ("originalVerified", "independentCopyVerified", "reviewCurrent"):
                years[year][key] += int(row["coverage"][key])
    rows.sort(key=lambda r: (r["sourceDate"] or "9999", r["messageId"]))
    return {"schema": "agentx.secretary-history-coverage/v1", "at": now(), "before": before.isoformat(),
            "source": "existing-gmail-archive", "scope": "selected-threads" if thread_ids is not None else "archived-threads",
            "providerInventoryVerified": False, "executionAllowed": False,
            "counts": {**counts, "inHistoricalScope": len(rows), "requiresValidation": len(rows)},
            "excluded": dict(excluded), "years": {k: dict(v) for k, v in sorted(years.items())},
            "messages": rows, "proofs": {"primarySha256": content_hash(primary), "mirrorSha256": content_hash(mirror)}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--before", required=True, type=cutoff_date)
    parser.add_argument("--primary-proof", type=Path)
    parser.add_argument("--mirror-proof", type=Path)
    parser.add_argument("--output", required=True, type=Path, help="Private report outside Git")
    args = parser.parse_args()
    report = coverage(Archive(args.root, run=lambda _: (_ for _ in ()).throw(RuntimeError("Provider access is disabled"))),
                      args.before, load(args.primary_proof, {}) if args.primary_proof else {},
                      load(args.mirror_proof, {}) if args.mirror_proof else {})
    save(args.output, report)
    print(json.dumps({k: v for k, v in report.items() if k != "messages"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
