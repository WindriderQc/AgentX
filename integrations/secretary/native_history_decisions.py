"""Read selected committed Core decisions without granting cleanup authority.

Each response observes one Entry document. Even two agreeing observations are
not an atomic batch, proof of archive completeness or downstream acceptance.
"""
from __future__ import annotations

import hashlib
from datetime import datetime
import json
import re
import urllib.error
import urllib.request
import uuid

from retention_plan import NATIVE_GAPS

CONTRACT = "agentx.history-decision-state/v1"
MAX_ENTRIES = 100
ID = re.compile(r"[a-f0-9]{24}\Z")
HASH = re.compile(r"[a-f0-9]{64}\Z")
SNAPSHOT_KEYS = {"contract", "entryId", "entryRevision", "entrySha256", "reviewState", "kind", "source",
                 "relatedSources", "decisionSha256", "confirmationSha256", "reviewHistorySha256",
                 "sourceReviewsSha256", "pendingSourceDecisions", "contextRevision", "contextHash",
                 "souvenirNoteId", "downstreamState"}


def digest(value):
    # This bounded snapshot contains only strings, safe integers, null and
    # arrays/objects of those values. Full entry JSON is compared inside Core.
    raw = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(raw.encode()).hexdigest()


def pairs(items):
    out = {}
    for key, value in items:
        if key in out:
            raise ValueError("Ambiguous native decision response")
        out[key] = value
    return out


def invalid_constant(_):
    raise ValueError("Non-finite native decision response")


def selected(entries, rows, saved):
    messages = {row["messageId"] for row in saved}
    selected_ids = set()
    for row in [*saved, *(row for row in rows if row["messageId"] in messages)]:
        findings = row.get("findings")
        if not isinstance(findings, dict) or not isinstance(row.get("undecidedEntries"), list):
            raise ValueError("Selected disposition has no exact decision scope")
        for finding in findings.values():
            if not isinstance(finding, dict) or not isinstance(finding.get("decidedBy"), list):
                raise ValueError("Selected disposition decisions are invalid")
            for decision in finding["decidedBy"]:
                if not isinstance(decision, dict):
                    raise ValueError("Selected disposition decision is invalid")
                selected_ids.add(decision.get("entryId"))
        selected_ids.update(row["undecidedEntries"])
    # Include new current assertions citing these messages, including related
    # sources. Their absence from an old disposition must not conceal an action.
    for entry in entries:
        if any(ref.get("system") == "gmail" and ref.get("messageId") in messages
               for ref in [entry.get("source") or {}, *(entry.get("relatedSources") or [])]):
            selected_ids.add(entry["id"])
    if len(selected_ids) > MAX_ENTRIES or any(not isinstance(key, str) or not ID.fullmatch(key) for key in selected_ids):
        raise ValueError("Select at most 100 exact historical decision entries")
    return sorted(selected_ids)


def observe(core, entry, *, expected=None, opener=urllib.request.urlopen):
    projection = {key: value for key, value in entry.items() if key != "souvenir"}
    observation_id = str(uuid.uuid4())
    body = {"entry": projection, "observationId": observation_id,
            **({"expected": expected} if expected is not None else {})}
    payload = json.dumps(body, ensure_ascii=False, allow_nan=False).encode()
    if len(payload) > 256 * 1024:
        raise ValueError("Selected historical decision exceeds its bounded capacity")
    request = urllib.request.Request(
        f"{core.rstrip('/')}/api/secretary/history/{entry['id']}/decision-state/check", data=payload,
        headers={"x-service-caller": "secretary-retention-review", "Content-Type": "application/json"}, method="POST")
    try:
        with opener(request, timeout=15) as response:
            raw = response.read(64 * 1024 + 1)
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ValueError("The selected native historical decision is unavailable") from None
    if len(raw) > 64 * 1024:
        raise ValueError("Native historical decision response exceeds its bounded capacity")
    value = json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)
    data = value.get("data") if isinstance(value, dict) and value.get("ok") is True else None
    if not isinstance(data, dict) or data.get("authority") != "agentx.core" or data.get("contract") != CONTRACT \
            or data.get("consistency") != "single-entry-committed-document" or data.get("scope") != "selected-entry-only" \
            or data.get("executionAllowed") is not False or data.get("cleanupStatus") != "blocked" \
            or data.get("nativeValidationGaps") != list(NATIVE_GAPS) or data.get("authenticatedPerson") is not None \
            or "authenticatedPerson" not in data or data.get("observationId") != observation_id \
            or data.get("entryMatches") is not True or data.get("status") != ("observed_match" if expected else "observed"):
        raise ValueError("Core did not confirm the selected current decision projection")
    snapshot = data.get("snapshot")
    if not isinstance(snapshot, dict) or set(snapshot) != SNAPSHOT_KEYS or snapshot.get("contract") != CONTRACT \
            or snapshot.get("entryId") != entry["id"] or snapshot.get("entryRevision") != entry["revision"] \
            or type(snapshot.get("entryRevision")) is not int or not 0 <= snapshot["entryRevision"] <= 9007199254740991 \
            or snapshot.get("reviewState") != entry["reviewState"] or snapshot.get("kind") != entry.get("kind") \
            or snapshot.get("source") != entry["source"] or snapshot.get("relatedSources") != entry.get("relatedSources", []) \
            or snapshot.get("contextRevision") != entry.get("contextRevision", 0) \
            or snapshot.get("contextHash") != entry.get("contextHash") \
            or type(snapshot.get("contextRevision")) is not int or not 0 <= snapshot["contextRevision"] <= 9007199254740991 \
            or type(snapshot.get("pendingSourceDecisions")) is not int or not 0 <= snapshot["pendingSourceDecisions"] <= 20 \
            or snapshot.get("downstreamState") != "not_rechecked":
        raise ValueError("Native historical decision identity or bounded scope is invalid")
    for key in ("entrySha256", "decisionSha256", "confirmationSha256", "reviewHistorySha256", "sourceReviewsSha256"):
        if not isinstance(snapshot.get(key), str) or not HASH.fullmatch(snapshot[key]):
            raise ValueError("Native historical decision fingerprint is invalid")
    fingerprint = data.get("fingerprint")
    if not isinstance(fingerprint, str) or not HASH.fullmatch(fingerprint) or digest(snapshot) != fingerprint \
            or (expected is not None and fingerprint != expected):
        raise ValueError("Native historical decision changed or failed its integrity check")
    observed_at = data.get("observedAt")
    if not isinstance(observed_at, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", observed_at):
        raise ValueError("Native historical decision observation date is invalid")
    datetime.fromisoformat(observed_at.replace("Z", "+00:00"))
    return {"entryId": entry["id"], "entryRevision": entry["revision"], "fingerprint": fingerprint,
            "pendingSourceDecisions": snapshot["pendingSourceDecisions"], "downstreamState": "not_rechecked",
            "observationId": observation_id, "observedAt": observed_at}


def capture(core, entries, rows, saved, *, previous=None, opener=urllib.request.urlopen):
    ids = selected(entries, rows, saved)
    by_id = {entry["id"]: entry for entry in entries}
    prior = {row["entryId"]: row for row in previous} if previous is not None else None
    if prior is not None and set(prior) != set(ids):
        raise ValueError("The native decision selection changed during reconciliation")
    result = []
    for key in ids:
        if key not in by_id:
            # Missing/forgotten is not an empty set of accepted decisions.
            raise ValueError("A selected native historical decision is unavailable")
        result.append(observe(core, by_id[key], expected=prior[key]["fingerprint"] if prior is not None else None, opener=opener))
    return result
