#!/usr/bin/env python3
"""Prepare an exact-message cleanup review; never perform a mailbox change.

Archive coverage, qualified analysis and information disposition are separate
receipts. All must match current evidence. This planner deliberately has no
Gmail transport, approval implementation or deletion command.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re

from evidence_store import load, now, save
from history_coverage import content_hash, coverage, cutoff_date, independent, proof_matches
from secretary_evidence import Archive, DEFAULT_ROOT
from compound_sources import packet_scopes, proof_paths, decision_reasons

HASH = re.compile(r"[a-f0-9]{64}")
QUALIFICATION_CASES = frozenset((
    "whole_body", "pagination", "quoted_authorship", "relative_dates", "sent_mail",
    "unsent_draft", "attachments", "calendar", "contacts", "invoice",
    "later_thread_resolution", "untrusted_instructions",
    "signature_information", "owner_aliases", "mime_alternatives", "external_references",
))
ANALYSIS_CONTRACT = "agentx.secretary-retention-analysis/v1"
DISPOSITION_CONTRACT = "agentx.secretary-retention-disposition/v1"
DECIDED = frozenset(("retained", "resolved", "dismissed"))
# Findings an owner disposition must cover even for bulk mail.
OBLIGATIONS = frozenset(("actions", "deliverables", "invoices"))


def aware(value):
    try:
        return cutoff_date(value)
    except (ValueError, TypeError, AttributeError):
        return None


def rolling_cutoff(days, clock=None):
    """Midnight UTC at least `days` days before now: a cutoff that advances by itself."""
    moment = (clock or datetime.now(timezone.utc)) - timedelta(days=days)
    return moment.replace(hour=0, minute=0, second=0, microsecond=0)


def qualification_valid(receipt):
    """A calibration attestation is evidence to inspect, not authentication."""
    if receipt.get("schema") != "agentx.secretary-retention-qualification/v1" \
            or receipt.get("qualified") is not True \
            or receipt.get("analysisContract") != ANALYSIS_CONTRACT \
            or not receipt.get("reviewerId") or not aware(receipt.get("at")) \
            or not HASH.fullmatch(receipt.get("corpusSha256", "")):
        return False
    cases = receipt.get("cases")
    if not isinstance(cases, list) or not cases:
        return False
    covered = set()
    for case in cases:
        if not isinstance(case, dict) or case.get("passed") is not True \
                or not HASH.fullmatch(case.get("sourceSha256", "")) \
                or not str(case.get("reason", "")).strip():
            return False
        covered.update(case.get("covers", []))
    return QUALIFICATION_CASES.issubset(covered)


def inventory_checks(inventory, before, clock):
    reasons = []
    at = aware(inventory.get("updatedAt"))
    expected_query = f"in:anywhere before:{int(before.timestamp())}"
    ids = inventory.get("ids")
    if inventory.get("query") != expected_query or inventory.get("complete") is not True \
            or inventory.get("next") or not isinstance(ids, list) \
            or any(not isinstance(mid, str) or not re.fullmatch(r"[a-f0-9]{10,32}", mid) for mid in (ids or [])) \
            or len(set(ids or [])) != len(ids or []):
        reasons.append("provider_inventory_incomplete_or_wrong_scope")
    if not at or not clock - timedelta(hours=24) <= at <= clock:
        reasons.append("provider_inventory_stale_or_invalid_date")
    return reasons, set(ids or []) if isinstance(ids, list) and all(isinstance(x, str) for x in ids) else set()


def _reasons_for_decision(row, decision, packet, qualification):
    reasons = decision_reasons(packet.get("compoundAttachments", {}), decision.get("compoundMembers", {}),
                               decision.get("compoundMetadata", {}))
    if packet.get("compoundAttachments") and not any(
            case.get("passed") is True and "compound_attachments" in case.get("covers", [])
            for case in qualification.get("cases", [])):
        reasons.append("compound_review_process_not_qualified")
    if decision.get("schema") != ANALYSIS_CONTRACT:
        return ["message_analysis_missing"]
    pins = {"messageId": row["messageId"], "threadId": row["threadId"],
            "sourceSha256": row["originalSha256"], "evidenceHash": row["evidenceHash"],
            "reviewSha256": row["reviewSha256"], "packetSha256": content_hash(packet),
            "qualificationSha256": content_hash(qualification)}
    if any(decision.get(key) != value for key, value in pins.items()):
        reasons.append("analysis_receipt_stale_or_wrong_source")
    if decision.get("reviewerId") != qualification.get("reviewerId") \
            or not aware(decision.get("at")) or not str(decision.get("reason", "")).strip():
        reasons.append("analysis_reviewer_or_reason_missing")
    checks = decision.get("checks", {})
    for name in ("wholeOriginalRead", "quotedAuthorshipChecked", "datesChecked", "threadContextChecked",
                 "noOutstandingAction", "allInformationAddressed", "signaturesChecked", "identityAttributionChecked",
                 "allMimeRepresentationsChecked", "externalReferencesDispositioned"):
        if checks.get(name) is not True:
            reasons.append(name)
    expected = packet["findingIds"]
    supplied = decision.get("findings", {})
    if set(supplied) != set(expected):
        reasons.append("finding_dispositions_incomplete")
    for identity in expected:
        item = supplied.get(identity, {})
        section = expected[identity]
        allowed = {"resolved", "not_applicable", "duplicate"} if section in ("actions", "deliverables") \
            else {"retained", "not_applicable", "duplicate"}
        if item.get("state") not in allowed or not str(item.get("reason", "")).strip() \
                or not str(item.get("evidenceRef", "")).strip():
            reasons.append("finding_disposition_unproven")
    for section, identities in (("pages", packet["pageIds"]), ("attachments", packet["attachmentIds"]),
                                ("questions", packet["questionIds"])):
        dispositions = decision.get(section, {})
        if set(dispositions) != set(identities):
            reasons.append(section + "_review_incomplete")
        for identity in identities:
            item = dispositions.get(identity, {})
            if item.get("state") not in ({"read"} if section == "pages" else {"addressed", "no_relevant_content"}) \
                    or not str(item.get("reason", "")).strip() or not str(item.get("evidenceRef", "")).strip():
                reasons.append(section + "_review_unproven")
    return reasons


def _reasons_for_disposition(row, disposition):
    """An owner disposition: bulk mail, or every finding decided by the owner in Core.

    It replaces the exact-message analysis only. Integrity, copies, provider,
    draft, date and unread-page blockers still apply. A finding the owner never
    saw (left out of Core) keeps the message held.
    """
    if disposition.get("schema") != DISPOSITION_CONTRACT:
        return ["owner_disposition_missing"]
    reasons = []
    pins = {"messageId": row["messageId"], "threadId": row["threadId"], "sourceSha256": row["originalSha256"],
            "evidenceHash": row["evidenceHash"], "reviewSha256": row["reviewSha256"]}
    if any(disposition.get(key) != value for key, value in pins.items()) or not aware(disposition.get("at")):
        reasons.append("owner_disposition_stale_or_wrong_source")
    expected = {identity: section for section, identities in row["findingIds"].items() for identity in identities}
    supplied = disposition.get("findings", {})
    if set(supplied) != set(expected):
        reasons.append("owner_disposition_findings_incomplete")
    basis, lane = disposition.get("basis"), (disposition.get("lane") or {}).get("lane")
    if disposition.get("undecidedEntries"):
        reasons.append("owner_review_entries_undecided")
    if basis == "bulk-lane" and lane == "bulk":
        required = [i for i, s in expected.items() if s in OBLIGATIONS]
    elif basis == "owner-decided" and lane in ("person", "important"):
        required = list(expected)
        if not required:
            # Nothing was found to decide: a separate, later owner validation.
            reasons.append("no_owner_decision_yet")
    else:
        return reasons + ["owner_disposition_basis_invalid"]
    for identity in required:
        decided = (supplied.get(identity) or {}).get("decidedBy") or []
        if not decided or any(entry.get("state") not in DECIDED for entry in decided):
            reasons.append("finding_not_decided_by_owner")
            break
    return reasons


def review_packet(archive, row):
    """Pin current page, attachment, finding and whole-thread question sets."""
    tid, mid = row["threadId"], row["messageId"]
    manifest = load(archive.root / "threads" / tid / "manifest.json", {})
    review = load(archive.root / "reviews" / f"{tid}.json", {})
    message = next((m for m in manifest.get("messages", []) if m.get("id") == mid), {})
    pages = [page for page in archive.review_pages(manifest) if page["messageId"] == mid]
    packet = {"messageId": mid, "threadId": tid, "sourceSha256": row["originalSha256"],
            "evidenceHash": row["evidenceHash"], "reviewSha256": row["reviewSha256"],
            "readerContract": "secretary.archive-reader/v3",
            "pageIds": {p["pageId"]: content_hash(p) for p in pages},
            "attachmentIds": {item.get("sha256") or "missing:" + str(item.get("partId")): {
                "sha256": item.get("sha256"), "bytes": item.get("bytes"), "path": item.get("path"),
                "extractionStatus": item.get("status")
            } for item in message.get("attachments", [])},
            "findingIds": {identity: section for section, identities in row["findingIds"].items() for identity in identities},
            "questionIds": {content_hash([tid, item]): item for item in review.get("unresolved", [])}}
    compound = packet_scopes(archive.root, message.get("attachments", []))
    if compound:
        packet["compoundAttachments"] = compound
    return packet


def plan(archive, before, inventory, primary, mirror, qualification, decisions, *, dispositions=(), clock=None):
    clock = clock or datetime.now(timezone.utc)
    report = coverage(archive, before, primary, mirror)
    global_reasons, provider_ids = inventory_checks(inventory, before, clock)
    # The triage qualification attests the exact-analysis process only; owner
    # dispositions rest on the owner's own decisions instead.
    analysis_unqualified = not qualification_valid(qualification)
    grouped, owned = {}, {}
    for decision in decisions:
        grouped.setdefault(decision.get("messageId"), []).append(decision)
    for disposition in dispositions:
        owned.setdefault(disposition.get("messageId"), []).append(disposition)
    rows, counts = [], Counter()
    # These preliminary blockers are discharged only by exact, qualified
    # per-message review. Hash/copy/source/date/draft blockers cannot be waived.
    reviewable = {"unread_source_pages", "attachment_analysis_needs_review", "action_findings_need_reconciliation",
                  "information_disposition_not_verified", "thread_questions_unresolved",
                  "analysis_validation_required", "message_classification_proof_required"}
    for row in report["messages"]:
        packet = review_packet(archive, row)
        matching, disposed = grouped.get(row["messageId"], []), owned.get(row["messageId"], [])
        owner_path = not matching and len(disposed) == 1
        if owner_path:
            # Unread pages are never waived; bulk mail also waives attachment
            # images and thread questions, which person/important mail keeps.
            waived = {"analysis_validation_required", "message_classification_proof_required",
                      "action_findings_need_reconciliation", "information_disposition_not_verified"}
            if disposed[0].get("basis") == "bulk-lane":
                waived |= {"attachment_analysis_needs_review", "thread_questions_unresolved"}
            reasons = list(global_reasons) + [b for b in row["blockers"] if b not in waived]
        else:
            reasons = list(global_reasons) + [b for b in row["blockers"] if b not in reviewable]
            if analysis_unqualified:
                reasons.append("triage_process_not_qualified")
        # Inventory/file integrity is not an analysis judgment and cannot be waived.
        if any(scope["status"] != "complete" or scope.get("errors")
               for scope in packet.get("compoundAttachments", {}).values()):
            reasons.append("compound_inventory_missing_or_incomplete")
        primary_tree, mirror_tree = primary.get("archiveTree", {}), mirror.get("archiveTree", {})
        if not independent(primary, mirror) or not HASH.fullmatch(primary_tree.get("indexSha256", "")) \
                or primary_tree.get("indexSha256") != mirror_tree.get("indexSha256") \
                or not primary_tree.get("expectedFiles") or not mirror_tree.get("expectedFiles"):
            reasons.append("archive_metadata_copies_not_verified")
        paths = [f"threads/{row['threadId']}/manifest.json", f"threads/{row['threadId']}/original.json",
                 f"reviews/{row['threadId']}.json", f"raw-receipts/{row['messageId']}.json"]
        paths += [f"page-reviews/{page}.json" for page in packet["pageIds"]
                  if (archive.root / "page-reviews" / (page + ".json")).is_file()]
        paths += proof_paths(packet.get("compoundAttachments", {}))
        for relative in paths:
            file = archive.root / relative
            expected = {"sha256": hashlib.sha256(file.read_bytes()).hexdigest(), "bytes": file.stat().st_size} if file.is_file() else {}
            if not proof_matches(primary, "archiveTreeFiles", relative, expected) \
                    or not proof_matches(mirror, "archiveTreeFiles", relative, expected):
                reasons.append("current_metadata_copies_not_verified")
        if row["messageId"] not in provider_ids:
            reasons.append("message_absent_from_provider_inventory")
        if owner_path:
            reasons.extend(_reasons_for_disposition(row, disposed[0]))
        elif len(matching) != 1:
            reasons.append("analysis_missing_or_ambiguous")
        else:
            reasons.extend(_reasons_for_decision(row, matching[0], packet, qualification))
        if row["coverage"]["expectedPages"] == 0:
            reasons.append("source_page_plan_empty")
        reasons = sorted(set(reasons))
        counts.update(reasons)
        rows.append({**row, "reviewPacket": packet, "blockers": reasons,
                     "basis": (disposed[0].get("basis") if owner_path else "exact-analysis" if len(matching) == 1 else None),
                     "candidateForOwnerReview": not reasons, "executionAllowed": False})
    archived_ids = {row["messageId"] for row in rows}
    missing = sorted(provider_ids - archived_ids)
    return {"schema": "agentx.secretary-retention-plan/v1", "at": clock.isoformat(), "before": before.isoformat(),
            "executionAllowed": False, "requiresNativeApproval": True,
            "effect": "none; exact-message review preparation only",
            "counts": {"historicalArchiveMessages": len(rows), "providerMessages": len(provider_ids),
                       "providerMessagesWithoutHistoricalArchive": len(missing),
                       "candidatesForOwnerReview": sum(r["candidateForOwnerReview"] for r in rows),
                       "held": sum(not r["candidateForOwnerReview"] for r in rows), "blockers": dict(counts)},
            "providerMessagesWithoutHistoricalArchive": missing, "messages": rows,
            "inputHashes": {"inventory": content_hash(inventory), "primary": content_hash(primary),
                            "mirror": content_hash(mirror), "qualification": content_hash(qualification),
                            "decisions": content_hash(decisions), "dispositions": content_hash(list(dispositions))},
            "executionRequirements": ["fresh exact-message provider recheck", "preserved provider metadata",
                "fresh candidate manifest and native one-time approval", "reversible Trash first",
                "per-message effect reconciliation and archive retrieval after cleanup"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    when = parser.add_mutually_exclusive_group(required=True)
    when.add_argument("--before", type=cutoff_date)
    when.add_argument("--older-than-days", type=int, help="Rolling cutoff, e.g. 456 for 1.25 years")
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--primary-proof", type=Path)
    parser.add_argument("--mirror-proof", type=Path)
    parser.add_argument("--qualification", type=Path)
    parser.add_argument("--decisions", type=Path, help="Private immutable analysis/disposition receipts")
    parser.add_argument("--dispositions", type=Path, help="Private owner dispositions from retention_dispositions.py")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.older_than_days is not None:
        if not 30 <= args.older_than_days <= 36500:
            parser.error("older-than-days must be 30-36500")
        args.before = rolling_cutoff(args.older_than_days)
    if args.output.resolve().is_relative_to(args.root.resolve()):
        parser.error("Retention reports stay outside the evidence archive")
    if args.output.exists():
        parser.error("Retain the existing plan and use a new output identity")
    read = lambda p, fallback: load(p, fallback) if p else fallback
    result = plan(Archive(args.root, run=lambda _: (_ for _ in ()).throw(RuntimeError("Provider access disabled"))),
        args.before, read(args.inventory, {}), read(args.primary_proof, {}), read(args.mirror_proof, {}),
        read(args.qualification, {}), read(args.decisions, []), dispositions=read(args.dispositions, []))
    save(args.output, result)
    print(json.dumps({k: v for k, v in result.items() if k not in ("messages", "providerMessagesWithoutHistoricalArchive")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
