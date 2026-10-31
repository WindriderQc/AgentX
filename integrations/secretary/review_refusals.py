"""Typed pre-dispatch refusals and explicit recovery of their retained evidence."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import urllib.parse

from evidence_store import load, now
from review_receipts import durable, hashed

BUSY_HTTP = (409, 423, 429, 502, 503, 504)
PRE_DISPATCH_CODES = {"BENCHMARK_CLAIM_ACTIVE", "BENCHMARK_CLAIM_PROOF_INVALID", "HOST_SESSION_HOLD_BUSY",
                      "RUNTIME_INFERENCE_ADMISSION_DENIED", "RUNTIME_INFERENCE_RECOVERY_REQUIRED",
                      "NO_UNCLAIMED_OLLAMA_HOST"}


def pre_dispatch_refusal(status, detail):
    return status in BUSY_HTTP and isinstance(detail, dict) and detail.get("code") in PRE_DISPATCH_CODES


def record_refusal(directory, state, *, reason, authorization_ref, call):
    """Retain the original fence and exact HTTP refusal before restoring retryability."""
    directory = Path(directory)
    intent, attempt = state.get("intent", {}), state.get("attempt")
    identity = "secretary-review-" + hashed(intent)
    if not intent or state.get("requestId") != identity or state.get("intentSha256") != hashed(intent) \
            or state.get("schema") != "agentx.secretary-review-attempt/v1" \
            or state.get("pageId") != intent.get("pageId") or type(attempt) is not int or attempt < 1 \
            or state.get("phase") not in ("pending", "unconfirmed", "refused"):
        raise ValueError("The retained native refusal identity or phase is invalid")
    for value in (reason, authorization_ref):
        if not isinstance(value, str) or not value.strip() or len(value) > 2000:
            raise ValueError("Explicit bounded reason and authorization reference are required")
    if (directory / "result.json").exists() or (directory / "terminal-reconciliation.json").exists():
        raise ValueError("Retain the existing result or terminal reconciliation")
    receipt = load(directory / f"response-{attempt}-http.json", {})
    raw = (directory / f"response-{attempt}-http.txt").read_bytes()
    if receipt.get("schema") != "agentx.secretary-review-response/v1" or receipt.get("stage") != "http" \
            or receipt.get("requestId") != identity or receipt.get("intentSha256") != hashed(intent) \
            or receipt.get("truncated") is not False or receipt.get("bytes") != len(raw) \
            or receipt.get("bodySha256") != hashlib.sha256(raw).hexdigest():
        raise ValueError("The exact complete native refusal response is unavailable")
    detail = json.loads(raw)
    if not pre_dispatch_refusal(receipt.get("httpStatus"), detail):
        raise ValueError("The saved response does not prove refusal before dispatch")
    file = directory / f"refusal-reconciliation-{attempt}.json"
    if file.exists():
        prior = load(file, {})
        if prior.get("schema") != "agentx.secretary-review-refusal/v1" \
                or prior.get("requestId") != identity or prior.get("responseReceipt") != receipt \
                or prior.get("code") != detail["code"] \
                or prior.get("reason") != reason or prior.get("authorizationRef") != authorization_ref \
                or hashed(prior.get("originalAttempt")) != prior.get("originalAttemptSha256") \
                or hashed(state) not in (prior.get("originalAttemptSha256"), prior.get("restoredAttemptSha256")):
            raise ValueError("The immutable refusal reconciliation differs from this attempt")
        restored = {**prior["originalAttempt"], "phase": "refused", "refusalReconciledAt": prior["at"]}
        if hashed(restored) != prior.get("restoredAttemptSha256"):
            raise ValueError("The restored native refusal differs from its receipt")
    else:
        logs = call("/api/analytics/inference/logs?" + urllib.parse.urlencode({"correlationId": identity, "pageSize": 100}))
        if not isinstance(logs.get("items"), list) or logs["items"] \
                or logs.get("pagination", {}).get("total") != 0 \
                or logs.get("pagination", {}).get("hasNext") is not False:
            raise ValueError("Native inference evidence does not confirm a refused dispatch")
        at = now()
        restored = {**state, "phase": "refused", "refusalReconciledAt": at}
        prior = {"schema": "agentx.secretary-review-refusal/v1", "at": at, "requestId": identity,
                 "intentSha256": hashed(intent), "code": detail["code"], "responseReceipt": receipt,
                 "originalAttempt": state, "originalAttemptSha256": hashed(state),
                 "restoredAttemptSha256": hashed(restored), "reason": reason,
                 "authorizationRef": authorization_ref, "inferenceStarted": False}
        if load(directory / "attempt.json", {}) != state:
            raise ValueError("The native attempt changed before reconciliation")
        durable(file, prior, exclusive=True)
    if load(directory / "attempt.json", {}) != state:
        raise ValueError("The native attempt changed before restoration")
    durable(directory / "attempt.json", restored)
    return prior
