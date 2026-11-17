"""Observe only existing linked owner souvenirs; never create selected memory."""
from __future__ import annotations

from datetime import datetime
import json
import re
import urllib.error
import urllib.request
import uuid

from native_history_decisions import HASH, ID, digest, pairs, invalid_constant
from native_history_message_scope import references
from retention_plan import NATIVE_GAPS

CONTRACT = "agentx.history-downstream-scope/v1"
MAX_RESPONSE = 1024 * 1024
MAX_TOTAL = 16 * 1024 * 1024


def observe(core, reference, finding, entries, *, expected=None, opener=urllib.request.urlopen):
    observation_id = str(uuid.uuid4())
    body = {"source": reference, "observationId": observation_id,
            **({"expected": expected} if expected is not None else {})}
    request = urllib.request.Request(f"{core.rstrip('/')}/api/secretary/history/decision-state/downstream",
        data=json.dumps(body).encode(), method="POST",
        headers={"x-service-caller": "secretary-retention-review", "Content-Type": "application/json"})
    try:
        with opener(request, timeout=60) as response:
            raw = response.read(MAX_RESPONSE + 1)
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ValueError("The selected native downstream scope is unavailable") from None
    if len(raw) > MAX_RESPONSE:
        raise ValueError("Native downstream scope exceeds its response capacity")
    value = json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)
    data = value.get("data") if isinstance(value, dict) and value.get("ok") is True else None
    if not isinstance(data, dict) or data.get("authority") != "agentx.core" or data.get("contract") != CONTRACT \
            or data.get("observationId") != observation_id \
            or data.get("status") != ("observed_match" if expected is not None else "observed") \
            or data.get("consistency") != "two-agreeing-linked-souvenir-reads-with-final-core-fence" \
            or data.get("downstreamState") != "linked-souvenirs-observed" or data.get("atomicBatch") is not False \
            or data.get("semanticAcceptance") is not False or "authenticatedPerson" not in data \
            or data["authenticatedPerson"] is not None or data.get("executionAllowed") is not False \
            or data.get("cleanupStatus") != "blocked" or data.get("nativeValidationGaps") != list(NATIVE_GAPS):
        raise ValueError("Core did not confirm the bounded downstream contract")
    snapshot = data.get("snapshot")
    if not isinstance(snapshot, dict) or set(snapshot) != {"contract", "reference", "findingScope", "entries", "coverage"} \
            or snapshot.get("contract") != CONTRACT or snapshot.get("reference") != reference \
            or snapshot.get("findingScope") != {"fingerprint": finding["fingerprint"], "snapshot": finding["snapshot"]} \
            or digest(snapshot["findingScope"]) != digest({"fingerprint": finding["fingerprint"], "snapshot": finding["snapshot"]}) \
            or digest(finding["snapshot"]) != finding["fingerprint"] \
            or not isinstance(snapshot.get("entries"), list):
        raise ValueError("Native downstream source/finding membership changed")
    pins = finding["snapshot"]["coreScope"]["members"]
    if len(snapshot["entries"]) != len(pins):
        raise ValueError("Native downstream membership is incomplete")
    by_id = {entry["id"]: entry for entry in entries}
    counts = {"entries": len(pins), "notLinked": 0, "currentLinks": 0, "unavailable": 0, "needsReview": 0}
    states = {"not_linked": "notLinked", "current_link": "currentLinks", "unavailable": "unavailable", "needs_review": "needsReview"}
    for row, pin in zip(snapshot["entries"], pins):
        if not isinstance(row, dict) or set(row) != {"entryId", "entryRevision", "decisionFingerprint", "state", "note", "blockers"} \
                or row.get("entryId") != pin["entryId"] or row.get("entryId") not in by_id \
                or type(row.get("entryRevision")) is not int or row["entryRevision"] != pin["entryRevision"] \
                or row.get("decisionFingerprint") != pin["fingerprint"] or not isinstance(row.get("state"), str) or row["state"] not in states:
            raise ValueError("Native downstream entry pins are invalid")
        note_id = by_id[row["entryId"]].get("souvenirNoteId")
        state, note = row["state"], row["note"]
        counts[states[state]] += 1
        if state == "not_linked":
            if note_id or note is not None or row["blockers"] != []:
                raise ValueError("An existing souvenir link was omitted")
            continue
        if not note_id:
            raise ValueError("A downstream note was invented for an unlinked assertion")
        if state == "unavailable":
            if note is not None or row["blockers"] != ["linked_souvenir_unavailable"]:
                raise ValueError("An unavailable souvenir must remain held")
            continue
        if not isinstance(note, dict) or set(note) != {"id", "revision", "fingerprint", "sourceBinding", "contextBinding", "replacementPending"} \
                or note.get("id") != note_id or not isinstance(note_id, str) or not ID.fullmatch(note_id) \
                or type(note.get("revision")) is not int or not 0 <= note["revision"] <= 9007199254740991 \
                or not isinstance(note.get("fingerprint"), str) or not HASH.fullmatch(note["fingerprint"]) \
                or any(type(note.get(key)) is not bool for key in ("sourceBinding", "contextBinding", "replacementPending")):
            raise ValueError("Native souvenir evidence is invalid or discloses unselected content")
        blockers = [code for condition, code in (
            (not note["sourceBinding"], "linked_souvenir_source_mismatch"),
            (not note["contextBinding"], "linked_souvenir_context_mismatch"),
            (note["replacementPending"], "linked_souvenir_replacement_pending")) if condition]
        if row["blockers"] != blockers or state != ("needs_review" if blockers else "current_link"):
            raise ValueError("Native souvenir binding failures were not held")
    blockers = list(finding["snapshot"]["coverage"]["blockers"])
    if counts["unavailable"] or counts["needsReview"]:
        blockers.append("linked_souvenirs_need_review")
    if digest(snapshot["coverage"]) != digest({"counts": counts, "blockers": blockers}):
        raise ValueError("Native downstream coverage disagrees with its complete members")
    if not isinstance(data.get("fingerprint"), str) or not HASH.fullmatch(data["fingerprint"]) \
            or digest(snapshot) != data["fingerprint"] or (expected is not None and data["fingerprint"] != expected):
        raise ValueError("Native downstream fingerprint changed or is invalid")
    at = data.get("observedAt")
    if not isinstance(at, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", at):
        raise ValueError("Native downstream observation date is invalid")
    datetime.fromisoformat(at.replace("Z", "+00:00"))
    return {"reference": reference, "snapshot": snapshot, "fingerprint": data["fingerprint"],
            "observationId": observation_id, "observedAt": at}, len(raw)


def capture(core, saved, findings, entries, *, opener=urllib.request.urlopen):
    by_message = {finding["reference"]["messageId"]: finding for finding in findings}
    refs = references(saved)
    if len(by_message) != len(findings) or set(by_message) != {ref["messageId"] for ref in refs}:
        raise ValueError("The complete selected downstream finding scope is unavailable")
    out, received, seen_entries, seen_notes = [], 0, {}, {}
    linked_ids = {entry['id']: entry.get('souvenirNoteId') for entry in entries}
    for reference in refs:
        finding = by_message[reference["messageId"]]
        if finding.get("reference") != reference or finding.get("snapshot", {}).get("reference") != reference:
            raise ValueError("The selected downstream source reference changed")
        first, size = observe(core, reference, finding, entries, opener=opener)
        received += size
        second, size = observe(core, reference, finding, entries, expected=first["fingerprint"], opener=opener)
        received += size
        if received > MAX_TOTAL:
            raise ValueError("Native downstream observations exceed their aggregate capacity")
        for row in second["snapshot"]["entries"]:
            key = row["entryId"]
            if key in seen_entries and seen_entries[key] != row:
                raise ValueError("A shared downstream entry changed between selected messages")
            seen_entries[key] = row
            note_id = linked_ids[key]
            if note_id:
                note = row["note"]
                pin = None if note is None else (note["revision"], note["fingerprint"])
                if note_id in seen_notes and seen_notes[note_id] != pin:
                    raise ValueError("A shared souvenir changed between selected messages")
                seen_notes[note_id] = pin
        out.append({**second, "initialObservationId": first["observationId"], "initialObservedAt": first["observedAt"]})
    return out
