"""Discover only selected Gmail-message references in native Core history.

Membership includes primary and related references regardless of primary source
system. The result is bounded observed membership, never atomic acceptance.
"""
from __future__ import annotations

from datetime import datetime
import json
import re
import urllib.error
import urllib.request
import uuid

from native_history_decisions import HASH, ID, digest, pairs, invalid_constant
from retention_plan import NATIVE_GAPS

CONTRACT = "agentx.history-message-scope/v1"
MAIL_ID = re.compile(r"[a-f0-9]{10,32}\Z")
MAX_MESSAGES = 20
MAX_ENTRIES = 100
MAX_RESPONSE = 4 * 1024 * 1024
MAX_TOTAL = 16 * 1024 * 1024


def references(saved):
    if not isinstance(saved, list) or not 1 <= len(saved) <= MAX_MESSAGES:
        raise ValueError("Select 1-20 exact saved messages for native discovery")
    found = {}
    for row in saved:
        if not isinstance(row, dict) or any(not isinstance(row.get(key), str) or not pattern.fullmatch(row[key])
                for key, pattern in (("messageId", MAIL_ID), ("threadId", MAIL_ID), ("sourceSha256", HASH))):
            raise ValueError("Native discovery requires exact saved message/thread/hash references")
        mid = row["messageId"]
        if mid in found:
            raise ValueError("Native discovery message selection is ambiguous")
        found[mid] = {"system": "gmail", **{key: row[key] for key in ("messageId", "threadId", "sourceSha256")}}
    return [found[key] for key in sorted(found)]


def observe(core, reference, *, expected=None, opener=urllib.request.urlopen):
    observation_id = str(uuid.uuid4())
    body = {"source": reference, "observationId": observation_id,
            **({"expected": expected} if expected is not None else {})}
    request = urllib.request.Request(f"{core.rstrip('/')}/api/secretary/history/decision-state/discover",
        data=json.dumps(body).encode(), method="POST",
        headers={"x-service-caller": "secretary-retention-review", "Content-Type": "application/json"})
    try:
        with opener(request, timeout=15) as response:
            raw = response.read(MAX_RESPONSE + 1)
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ValueError("Native historical message discovery is unavailable") from None
    if len(raw) > MAX_RESPONSE:
        raise ValueError("Native message scope exceeds its response capacity")
    value = json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)
    data = value.get("data") if isinstance(value, dict) and value.get("ok") is True else None
    if not isinstance(data, dict) or data.get("authority") != "agentx.core" or data.get("contract") != CONTRACT \
            or data.get("observationId") != observation_id or data.get("status") != ("observed_match" if expected else "observed") \
            or data.get("consistency") != "two-agreeing-bounded-membership-queries" \
            or data.get("coverage") != "selected-message-visible-core-entries" or data.get("atomicBatch") is not False \
            or data.get("downstreamState") != "not_rechecked" or data.get("executionAllowed") is not False \
            or data.get("cleanupStatus") != "blocked" or data.get("nativeValidationGaps") != list(NATIVE_GAPS) \
            or "authenticatedPerson" not in data or data["authenticatedPerson"] is not None:
        raise ValueError("Core did not confirm the bounded native message scope")
    snapshot, entries = data.get("snapshot"), data.get("entries")
    if not isinstance(snapshot, dict) or set(snapshot) != {"contract", "reference", "entries"} \
            or snapshot.get("contract") != CONTRACT or snapshot.get("reference") != reference \
            or not isinstance(snapshot.get("entries"), list) or len(snapshot["entries"]) > MAX_ENTRIES \
            or not isinstance(entries, list) or len(entries) != len(snapshot["entries"]):
        raise ValueError("Native message scope membership is incomplete or invalid")
    seen = set()
    for entry, pin in zip(entries, snapshot["entries"]):
        if not isinstance(pin, dict) or set(pin) != {"entryId", "entryRevision", "fingerprint", "sourceBinding"} \
                or not isinstance(pin.get("entryId"), str) or not ID.fullmatch(pin["entryId"]) or pin["entryId"] in seen \
                or not isinstance(pin.get("fingerprint"), str) or not HASH.fullmatch(pin["fingerprint"]) \
                or type(pin.get("entryRevision")) is not int or not 0 <= pin["entryRevision"] <= 9007199254740991 \
                or pin.get("sourceBinding") != "exact" or not isinstance(entry, dict) or entry.get("id") != pin["entryId"] \
                or type(entry.get("revision")) is not int or entry["revision"] != pin["entryRevision"] \
                or entry.get("reviewState") not in ("candidate", "retained", "dismissed", "resolved") \
                or not isinstance(entry.get("source"), dict) or not isinstance(entry.get("relatedSources", []), list):
            raise ValueError("Native message entries conflict with their exact selected scope")
        refs = [entry["source"], *entry.get("relatedSources", [])]
        cited = [ref for ref in refs if isinstance(ref, dict) and ref.get("system") == "gmail"
                 and ref.get("messageId") == reference["messageId"]]
        if not cited or any(ref.get("threadId") != reference["threadId"] or ref.get("sourceSha256") != reference["sourceSha256"] for ref in cited):
            raise ValueError("Native message source references conflict with their selected identity")
        seen.add(pin["entryId"])
    if [pin["entryId"] for pin in snapshot["entries"]] != sorted(seen):
        raise ValueError("Native message membership ordering is invalid")
    fingerprint = data.get("fingerprint")
    if not isinstance(fingerprint, str) or not HASH.fullmatch(fingerprint) or digest(snapshot) != fingerprint \
            or (expected is not None and fingerprint != expected):
        raise ValueError("Native message membership or decisions changed")
    at = data.get("observedAt")
    if not isinstance(at, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", at):
        raise ValueError("Native message observation date is invalid")
    datetime.fromisoformat(at.replace("Z", "+00:00"))
    receipt = {"reference": reference, "fingerprint": fingerprint, "members": snapshot["entries"],
               "observationId": observation_id, "observedAt": at}
    return entries, receipt, len(raw)


def discover(core, saved, *, previous=None, opener=urllib.request.urlopen):
    refs = references(saved)
    old = {row["reference"]["messageId"]: row for row in previous} if previous is not None else None
    if old is not None and set(old) != {ref["messageId"] for ref in refs}:
        raise ValueError("The native selected message set changed")
    by_id, pins, receipts, received = {}, {}, [], 0
    for reference in refs:
        entries, receipt, size = observe(core, reference,
            expected=old[reference["messageId"]]["fingerprint"] if old is not None else None, opener=opener)
        received += size
        if received > MAX_TOTAL:
            raise ValueError("Native message discovery exceeds its aggregate response capacity")
        for entry, pin in zip(entries, receipt["members"]):
            key = entry["id"]
            if key in by_id and (by_id[key] != entry or pins[key] != pin["fingerprint"]):
                raise ValueError("A shared historical entry changed between selected messages")
            by_id[key], pins[key] = entry, pin["fingerprint"]
            if len(by_id) > MAX_ENTRIES:
                raise ValueError("Select at most 100 historical entries across the selected messages")
        receipts.append(receipt)
    return [by_id[key] for key in sorted(by_id)], receipts


def confirm(captured, scopes):
    expected = {pin["entryId"]: pin["fingerprint"] for scope in scopes for pin in scope["members"]}
    if {row["entryId"]: row["fingerprint"] for row in captured} != expected:
        raise ValueError("Native decisions no longer match their discovered membership")
