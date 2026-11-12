"""Bind recorded archive findings to native Core decision observations.

This validates the native read contract, not semantics or mailbox authority.
"""
from __future__ import annotations

from datetime import datetime
import json
import re
import urllib.error
import urllib.request
import uuid

from native_history_decisions import HASH, ID, digest, pairs, invalid_constant
from native_history_message_scope import references, CONTRACT as MESSAGE_CONTRACT
from retention_plan import NATIVE_GAPS

CONTRACT = "agentx.history-finding-scope/v1"
SECTIONS = {"actions", "memories", "deliverables", "invoices"}
MAX_RESPONSE = 512 * 1024


def is_hash(value):
    return isinstance(value, str) and HASH.fullmatch(value) is not None


def observe(core, reference, local, scope, entries, *, opener=urllib.request.urlopen):
    observation_id = str(uuid.uuid4())
    body = {"source": reference, "observationId": observation_id}
    request = urllib.request.Request(f"{core.rstrip('/')}/api/secretary/history/decision-state/findings",
        data=json.dumps(body).encode(), method="POST", headers={"x-service-caller": "secretary-retention-review", "Content-Type": "application/json"})
    try:
        with opener(request, timeout=60) as response:
            raw = response.read(MAX_RESPONSE + 1)
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ValueError("Native recorded finding review is unavailable") from None
    if len(raw) > MAX_RESPONSE:
        raise ValueError("Native recorded finding review exceeds its response capacity")
    value = json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)
    data = value.get("data") if isinstance(value, dict) and value.get("ok") is True else None
    if not isinstance(data, dict) or data.get("authority") != "agentx.core" or data.get("contract") != CONTRACT \
            or data.get("observationId") != observation_id or data.get("status") != "observed" \
            or data.get("atomicBatch") is not False or data.get("semanticAcceptance") is not False \
            or data.get("executionAllowed") is not False or data.get("cleanupStatus") != "blocked" \
            or data.get("downstreamState") != "not_rechecked" or data.get("nativeValidationGaps") != list(NATIVE_GAPS) \
            or "authenticatedPerson" not in data or data["authenticatedPerson"] is not None:
        raise ValueError("Core did not confirm the recorded finding observation")
    snapshot = data.get("snapshot")
    if not isinstance(snapshot, dict) or set(snapshot) != {"contract", "reference", "inventory", "coreScope", "coverage"} \
            or snapshot.get("contract") != CONTRACT or snapshot.get("reference") != reference:
        raise ValueError("Native finding scope identity is invalid")
    inventory, native_scope, coverage = (snapshot.get(key) for key in ("inventory", "coreScope", "coverage"))
    if not isinstance(inventory, dict) or inventory.get("contract") != "secretary.archive-findings/v1" \
            or inventory.get("reference") != reference or inventory.get("scope") != "recorded-selected-message-findings-and-thread-questions" \
            or inventory.get("semanticAcceptance") is not False or inventory.get("executionAllowed") is not False \
            or any(not is_hash(inventory.get(key)) for key in ("evidenceHash", "reviewSha256", "metadataSha256")) \
            or inventory["evidenceHash"] != local.get("evidenceHash") or inventory["reviewSha256"] != local.get("reviewSha256") \
            or not isinstance(inventory.get("raw"), dict) or inventory["raw"].get("sha256") != reference["sourceSha256"] \
            or type(inventory["raw"].get("bytes")) is not int or not 1 <= inventory["raw"]["bytes"] <= 16 * 1024 * 1024:
        raise ValueError("Native findings do not match the selected current archive review")
    if not isinstance(native_scope, dict) or native_scope.get("contract") != MESSAGE_CONTRACT \
            or native_scope.get("fingerprint") != scope["fingerprint"] or native_scope.get("members") != scope["members"]:
        raise ValueError("Native findings no longer match the reconciled Core message membership")
    native_findings = inventory.get("findings")
    questions = inventory.get("threadQuestions")
    if not isinstance(native_findings, list) or len(native_findings) > 256 \
            or not isinstance(questions, list) or len(questions) > 128:
        raise ValueError("Native finding inventory exceeds its bounded capacity")
    indexed = {}
    for finding in native_findings:
        if not isinstance(finding, dict) or set(finding) != {"findingId", "section"} or not is_hash(finding.get("findingId")) \
                or finding.get("section") not in SECTIONS or finding["findingId"] in indexed:
            raise ValueError("Native finding identifiers are ambiguous or invalid")
        indexed[finding["findingId"]] = finding["section"]
    expected = {identity: section for section, ids in local["findingIds"].items() for identity in ids}
    if indexed != expected:
        raise ValueError("Native finding membership differs from the current local archive")
    question_ids = []
    for question in questions:
        if not isinstance(question, dict) or set(question) != {"questionId"} or not is_hash(question.get("questionId")):
            raise ValueError("Native thread question identifiers are invalid")
        question_ids.append(question["questionId"])
    if len(set(question_ids)) != len(question_ids) or len(question_ids) != local["coverage"]["threadQuestions"]:
        raise ValueError("Native unresolved thread questions differ from the current local review")
    if not isinstance(coverage, dict) or not isinstance(coverage.get("findings"), list) \
            or len(coverage["findings"]) != len(indexed) or not isinstance(coverage.get("blockers"), list) \
            or any(not isinstance(code, str) or len(code) > 100 for code in coverage["blockers"]) \
            or not isinstance(coverage.get("unmatchedEntries"), list) or len(coverage["unmatchedEntries"]) > 100 \
            or not isinstance(coverage.get("counts"), dict) \
            or set(coverage["counts"]) != {"recordedFindings", "noCoreReference", "needsReview", "observedDecision", "threadQuestions", "unmatchedEntries"} \
            or any(type(count) is not int or not 0 <= count <= 256 for count in coverage["counts"].values()):
        raise ValueError("Native recorded finding coverage is incomplete or invalid")
    members = {pin["entryId"]: pin for pin in scope["members"]}
    core_entries = {entry["id"]: entry for entry in entries}
    seen = set()
    for finding in coverage["findings"]:
        if not isinstance(finding, dict) or finding.get("findingId") not in indexed \
                or finding["findingId"] in seen or finding.get("section") != indexed[finding["findingId"]] \
                or finding.get("status") not in ("no_core_reference", "needs_review", "observed_decision") \
                or not isinstance(finding.get("records"), list) or len(finding["records"]) > 100:
            raise ValueError("Native finding decision references are invalid")
        seen.add(finding["findingId"])
        record_ids = set()
        for record in finding["records"]:
            if not isinstance(record, dict) or record.get("entryId") not in members or record["entryId"] in record_ids \
                    or type(record.get("revision")) is not int or record["revision"] != members[record["entryId"]]["entryRevision"] \
                    or record.get("fingerprint") != members[record["entryId"]]["fingerprint"] \
                    or record["entryId"] not in core_entries or record.get("kind") != core_entries[record["entryId"]].get("kind") \
                    or record.get("state") != core_entries[record["entryId"]].get("reviewState") \
                    or not isinstance(record.get("blockers"), list) or len(record["blockers"]) > 8 \
                    or any(not isinstance(code, str) or len(code) > 100 for code in record["blockers"]):
                raise ValueError("Native finding decisions no longer match the selected member versions")
            record_ids.add(record["entryId"])
    if any(not isinstance(key, str) or not ID.fullmatch(key) or key not in members for key in coverage["unmatchedEntries"]):
        raise ValueError("Native unmatched decision references are invalid")
    # Check transport consistency, not the server's domain disposition policy.
    counts = coverage["counts"]
    if len(set(coverage["unmatchedEntries"])) != len(coverage["unmatchedEntries"]) \
            or counts["recordedFindings"] != len(native_findings) or counts["threadQuestions"] != len(questions) \
            or counts["unmatchedEntries"] != len(coverage["unmatchedEntries"]) \
            or counts["noCoreReference"] != sum(row["status"] == "no_core_reference" for row in coverage["findings"]) \
            or counts["needsReview"] != sum(row["status"] == "needs_review" for row in coverage["findings"]) \
            or counts["observedDecision"] != sum(row["status"] == "observed_decision" for row in coverage["findings"]):
        raise ValueError("Native finding coverage counts are inconsistent")
    for finding in coverage["findings"]:
        status = "no_core_reference" if not finding["records"] else "needs_review" if any(row["blockers"] for row in finding["records"]) else "observed_decision"
        if finding["status"] != status:
            raise ValueError("Native finding coverage status is inconsistent")
    held = not native_findings or any(counts[key] for key in ("noCoreReference", "needsReview", "threadQuestions", "unmatchedEntries"))
    if bool(coverage["blockers"]) != held:
        raise ValueError("Native finding coverage blockers are inconsistent")
    fingerprint = data.get("fingerprint")
    if not is_hash(fingerprint) or digest(snapshot) != fingerprint:
        raise ValueError("Native finding scope failed its integrity check")
    at = data.get("observedAt")
    if not isinstance(at, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", at):
        raise ValueError("Native finding observation date is invalid")
    datetime.fromisoformat(at.replace("Z", "+00:00"))
    return {"reference": reference, "fingerprint": fingerprint, "snapshot": snapshot,
            "observationId": observation_id, "observedAt": at}


def capture(core, saved, current_rows, scopes, entries, *, opener=urllib.request.urlopen):
    current = {row["messageId"]: row for row in current_rows}
    native = {scope["reference"]["messageId"]: scope for scope in scopes}
    out = []
    for reference in references(saved):
        mid = reference["messageId"]
        if mid not in current or mid not in native:
            raise ValueError("The selected native finding review is unavailable")
        out.append(observe(core, reference, current[mid], native[mid], entries, opener=opener))
    return out
