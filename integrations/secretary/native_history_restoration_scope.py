"""Bind every selected disposition to a fresh retained native disk restore.

No receipt is created and no provider is contacted. Temporary native probes
are real work; a live corpus requires its own queued, authorized execution.
"""
from __future__ import annotations

from datetime import datetime
import json
import re
import urllib.error
import urllib.request
import uuid

from native_history_decisions import HASH, ID, digest, pairs, invalid_constant
from native_history_message_scope import references
from history_coverage import content_hash
from retention_plan import NATIVE_GAPS

CONTRACT = "agentx.history-restoration-scope/v1"
UUID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\Z")
MAX_RESPONSE = 2 * 1024 * 1024


def selection(saved, checks):
    refs = references(saved)
    if not isinstance(checks, list) or len(checks) != len(refs):
        raise ValueError("Every selected message needs exactly one retained restoration receipt")
    by_message = {}
    for check in checks:
        if not isinstance(check, dict) or set(check) != {"entryId", "requestId", "snapshotHash", "source"} \
                or any(not isinstance(check.get(key), str) or not pattern.fullmatch(check[key])
                       for key, pattern in (("entryId", ID), ("requestId", UUID), ("snapshotHash", HASH))) \
                or not isinstance(check.get("source"), dict):
            raise ValueError("Use exact retained native entry/request/snapshot/source identities")
        mid = check["source"].get("messageId")
        if not isinstance(mid, str) or mid in by_message:
            raise ValueError("Restoration selection is ambiguous")
        by_message[mid] = check
    if set(by_message) != {ref["messageId"] for ref in refs} \
            or any(by_message[ref["messageId"]]["source"] != ref for ref in refs):
        raise ValueError("Restoration receipts must cover the complete exact saved source set")
    return [by_message[ref["messageId"]] for ref in refs]


def observe(core, checks, *, expected=None, opener=urllib.request.urlopen):
    observation_id = str(uuid.uuid4())
    request = urllib.request.Request(f"{core.rstrip('/')}/api/secretary/history/preservation-scope",
        data=json.dumps({"checks": checks, "observationId": observation_id,
                         **({"expected": expected} if expected is not None else {})}, allow_nan=False).encode(),
        method="POST", headers={"x-service-caller": "secretary-retention-review", "Content-Type": "application/json"})
    try:
        # At most 20 sequential messages; each existing native two-copy call
        # has its unchanged 45-second bound. No retries or mode fallback.
        with opener(request, timeout=960) as response:
            raw = response.read(MAX_RESPONSE + 1)
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ValueError("The complete native restoration observation is unavailable") from None
    if len(raw) > MAX_RESPONSE:
        raise ValueError("Native restoration scope exceeds its response capacity")
    value = json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)
    data = value.get("data") if isinstance(value, dict) and value.get("ok") is True else None
    if not isinstance(data, dict) or data.get("authority") != "agentx.core" or data.get("contract") != CONTRACT \
            or data.get("observationId") != observation_id \
            or data.get("status") != ("observed_match" if expected is not None else "observed") \
            or data.get("consistency") != "retained-restoration-rechecks-with-final-core-fence" \
            or data.get("coverage") != "complete-selected-source-set" or data.get("atomicBatch") is not False \
            or data.get("semanticAcceptance") is not False or "authenticatedPerson" not in data \
            or data["authenticatedPerson"] is not None or data.get("executionAllowed") is not False \
            or data.get("cleanupStatus") != "blocked" or data.get("nativeValidationGaps") != list(NATIVE_GAPS):
        raise ValueError("Core did not confirm the bounded native restoration contract")
    snapshot = data.get("snapshot")
    if not isinstance(snapshot, dict) or set(snapshot) != {"contract", "sourceSetSha256", "pins", "members"} \
            or snapshot.get("contract") != CONTRACT \
            or snapshot.get("sourceSetSha256") != digest([check["source"] for check in checks]) \
            or not isinstance(snapshot.get("pins"), list) or len(snapshot["pins"]) != len(checks) \
            or not isinstance(snapshot.get("members"), list) or len(snapshot["members"]) != len(checks):
        raise ValueError("The complete native restoration membership is invalid")
    copy_identities = None
    for check, pin, member in zip(checks, snapshot["pins"], snapshot["members"]):
        if not isinstance(pin, dict) or set(pin) != set(check) | {"entryRevision", "basisHash", "privacyHash"} \
                or any(pin.get(key) != item for key, item in check.items()) \
                or type(pin.get("entryRevision")) is not int or not 0 <= pin["entryRevision"] <= 9007199254740991 \
                or any(not isinstance(pin.get(key), str) or not HASH.fullmatch(pin[key]) for key in ("basisHash", "privacyHash")) \
                or not isinstance(member, dict) or set(member) != set(check) | {"snapshot"} \
                or any(member.get(key) != item for key, item in check.items()):
            raise ValueError("Native restoration member pins changed")
        proof = member["snapshot"]
        if not isinstance(proof, dict) or digest(proof) != check["snapshotHash"] \
                or proof.get("contract") != "agentx.history-preservation/v2" \
                or proof.get("scope") != "selected-original-recorded-attachments-mime-and-temporary-disk-restore" \
                or proof.get("status") != "verified_scope" or proof.get("blockers") != [] \
                or not isinstance(proof.get("reference"), dict) \
                or any(proof["reference"].get(key) != item for key, item in check["source"].items()) \
                or not isinstance(proof.get("copies"), list) or len(proof["copies"]) != 2:
            raise ValueError("A retained native restoration is missing, stale or byte-only")
        identities = []
        for name, copy in zip(("primary", "mirror"), proof["copies"]):
            if not isinstance(copy, dict) or copy.get("copy") != name or copy.get("status") != "available" \
                    or any(not isinstance(copy.get(key), str) or not HASH.fullmatch(copy[key])
                           for key in ("machineIdSha256", "archiveIdSha256")) \
                    or not isinstance(copy.get("restoration"), dict) \
                    or copy["restoration"].get("temporaryCopyRemoved") is not True:
                raise ValueError("Both native restored copies are required")
            identities.append([name, copy["machineIdSha256"], copy["archiveIdSha256"]])
        if identities[0][1] == identities[1][1] or (copy_identities is not None and copy_identities != identities):
            raise ValueError("Native copy identities changed within the selection")
        copy_identities = identities
    if not isinstance(data.get("fingerprint"), str) or not HASH.fullmatch(data["fingerprint"]) \
            or data["fingerprint"] != digest(snapshot) or (expected is not None and data["fingerprint"] != expected):
        raise ValueError("Native restoration scope failed its fingerprint check")
    at = data.get("observedAt")
    if not isinstance(at, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", at):
        raise ValueError("Native restoration observation date is invalid")
    datetime.fromisoformat(at.replace("Z", "+00:00"))
    return data


def capture(core, saved, checks, *, opener=urllib.request.urlopen):
    selected = selection(saved, checks)
    first = observe(core, selected, opener=opener)
    second = observe(core, selected, expected=first["fingerprint"], opener=opener)
    return {**second, "initialObservationId": first["observationId"], "initialObservedAt": first["observedAt"],
            "savedDispositionsSha256": content_hash(saved)}
