"""Immutable gaps for certainly received, rejected objective page outputs.

These receipts are neither accepted page reviews nor permission to retry an
inference. They let an explicitly review-only campaign visit its other pages.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from evidence_store import load, now
from objective_schema import normalize_representation, validate
from review_attempts import response_received, result_file
from review_receipts import durable, hashed

CONTRACT = "secretary.objective-page-disposition/v1"


class DispositionIntegrityError(ValueError):
    """A saved disposition cannot be trusted; never turn it into a source gap."""


def _proof(objective, page_id):
    """Require exact retained HTTP terminal evidence, never an unsettled call."""
    objective = Path(objective)
    result = result_file(objective, page_id)
    directory = result.parent
    state = load(directory / "attempt.json", {})
    intent = state.get("intent", {})
    if state.get("pageId") != page_id or intent.get("pageId") != page_id \
            or state.get("intentSha256") != hashed(intent) \
            or state.get("requestId") != "secretary-review-" + hashed(intent) \
            or state.get("phase") not in ("completed", "invalid-output") \
            or not response_received(directory, state):
        raise ValueError("Rejected page has no certain retained native response")
    http_file = directory / f"response-{state['attempt']}-http.txt"
    reply = json.loads(http_file.read_text(encoding="utf-8"))
    if not isinstance(reply, dict) or reply.get("done") is not True:
        raise ValueError("Rejected page has no explicit terminal response frame")
    files = [directory / "attempt.json", http_file, http_file.with_suffix(".json")]
    model_file = directory / f"response-{state['attempt']}-model.txt"
    if model_file.exists():
        descriptor = load(model_file.with_suffix(".json"), {})
        content = model_file.read_bytes()
        if descriptor.get("requestId") != state["requestId"] \
                or descriptor.get("intentSha256") != state["intentSha256"] \
                or descriptor.get("stage") != "model" or descriptor.get("bytes") != len(content) \
                or descriptor.get("bodySha256") != hashlib.sha256(content).hexdigest():
            raise ValueError("Rejected page model response integrity failed")
        files += [model_file, model_file.with_suffix(".json")]
    value = None
    if state["phase"] == "completed":
        receipt = load(result, {})
        value = receipt.get("value")
        if receipt.get("schema") != "agentx.secretary-review-result/v1" \
                or receipt.get("requestId") != state["requestId"] \
                or receipt.get("intentSha256") != state["intentSha256"] \
                or not isinstance(value, dict) or receipt.get("valueSha256") != hashed(value) \
                or state.get("valueSha256") != hashed(value):
            raise ValueError("Rejected page retained result integrity failed")
        files.append(result)
    elif not state.get("invalidReason"):
        raise ValueError("Rejected page lacks its known invalid-output reason")
    proof = {"requestId": state["requestId"], "intentSha256": state["intentSha256"],
             "phase": state["phase"], "terminal": True,
             "artifacts": [{"path": str(f.relative_to(objective)),
                            "sha256": hashlib.sha256(f.read_bytes()).hexdigest()} for f in files]}
    return proof, state, value


def _failure(value, state, body):
    if state["phase"] == "invalid-output":
        return {"type": "ReviewInvalidOutput", "message": state["invalidReason"]}
    try:
        normalized, _ = normalize_representation(value, body)
        validate(normalized, body)
    except ValueError as error:
        return {"type": type(error).__name__, "message": str(error)}
    raise ValueError("A valid result cannot be retained as a rejected page")


def terminal(objective, page_id, request_id):
    """A held known-invalid response may be revisited from cache, never retried."""
    proof, _, _ = _proof(objective, page_id)
    if proof["requestId"] != request_id:
        raise ValueError("Rejected page terminal request identity differs")
    return proof


def _read(objective, manifest, page_id, *, expected_identity=None):
    """Verify source scope and every retained byte before skipping a page."""
    objective = Path(objective)
    file = objective / "page-dispositions" / (page_id + ".json")
    if not file.exists():
        return None
    row = load(file, {})
    identity = row.get("identity", {})
    source = row.get("source", {})
    body = row.get("body")
    if row.get("schema") != CONTRACT or row.get("objectiveSha256") != manifest["objectiveSha256"] \
            or row.get("pageId") != page_id or hashed(identity) != page_id \
            or identity.get("objectiveSha256") != manifest["objectiveSha256"] \
            or expected_identity is not None and identity != expected_identity \
            or not isinstance(body, str) or hashlib.sha256(body.encode()).hexdigest() != identity.get("contentSha256") \
            or identity.get("end", -1) - identity.get("offset", 0) != len(body) \
            or row.get("offset") != identity.get("offset") or row.get("end") != identity.get("end") \
            or row.get("representation") != identity.get("unit") \
            or not isinstance(row.get("totalChars"), int) or row["totalChars"] < identity.get("end", 0) \
            or identity.get("sourceId") != source.get("id") \
            or identity.get("sourceSha256") != source.get("sha256") \
            or identity.get("system") != source.get("system") \
            or not any(all(s.get(k) == source.get(k) for k in ("system", "id", "sha256")) for s in manifest["sources"]) \
            or row.get("disposition") != "rejected-output" or row.get("textCovered") is not False \
            or row.get("userConfirmed") is not False:
        raise ValueError("Rejected page disposition identity or source integrity failed")
    if (objective / "page-reviews" / (page_id + ".json")).exists():
        raise ValueError("A rejected page cannot also be an accepted review")
    proof, state, value = _proof(objective, page_id)
    if row.get("proof") != proof or row.get("failure") != _failure(value, state, body):
        raise ValueError("Rejected page disposition no longer matches its retained result")
    return row


def read(objective, manifest, page_id, *, expected_identity=None):
    try:
        return _read(objective, manifest, page_id, expected_identity=expected_identity)
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise DispositionIntegrityError(str(error)) from error


def retain(objective, manifest, page, error):
    """No source/output rewrite; a certain rejection becomes an explicit gap."""
    prior = read(objective, manifest, page["pageId"], expected_identity=page["identity"])
    if prior:
        return prior
    proof, state, value = _proof(objective, page["pageId"])
    failure = _failure(value, state, page["content"])
    if failure != {"type": type(error).__name__, "message": str(error)}:
        raise ValueError("Rejected page error differs from the retained validation failure")
    row = {"schema": CONTRACT, "at": now(), "objectiveSha256": manifest["objectiveSha256"],
           "pageId": page["pageId"], "identity": page["identity"], "source": page["source"],
           "body": page["content"], "representation": page["representation"],
           "offset": page["offset"], "end": page["end"], "totalChars": page["totalChars"],
           "disposition": "rejected-output", "failure": failure, "proof": proof,
           "textCovered": False, "semanticAcceptance": "not-established", "userConfirmed": False}
    file = Path(objective) / "page-dispositions" / (page["pageId"] + ".json")
    durable(file, row, exclusive=True)
    return read(objective, manifest, page["pageId"], expected_identity=page["identity"])
