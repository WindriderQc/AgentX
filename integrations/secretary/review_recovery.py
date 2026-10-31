#!/usr/bin/env python3
"""Explicit native terminal reconciliation and linked review attempts; no inference."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone, timedelta
import hashlib
import json
from pathlib import Path
import re
import urllib.parse
import urllib.request

from evidence_store import load, now
from review_receipts import durable, hashed
from review_refusals import record_refusal

RECONCILIATION = "agentx.secretary-review-terminal/v1"
RETRY = "agentx.secretary-review-linked-retry/v1"
LINK_FIELDS = {"parentRequestId", "terminalReconciliationSha256"}


def _sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def _instant(value):
    result = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("Native evidence timestamp needs its timezone")
    return result.astimezone(timezone.utc)


def _text(value, label):
    if not isinstance(value, str) or not value.strip() or len(value) > 2000:
        raise ValueError(label + " must be explicit bounded text")
    return value


def _valid_state(state):
    intent = state.get("intent", {})
    if state.get("schema") != "agentx.secretary-review-attempt/v1" or not intent \
            or state.get("intentSha256") != hashed(intent) \
            or state.get("requestId") != "secretary-review-" + hashed(intent) \
            or state.get("pageId") != intent.get("pageId") \
            or state.get("phase") not in ("pending", "unconfirmed", "invalid-output"):
        raise ValueError("The retained native attempt identity or phase is invalid")
    _instant(state.get("startedAt"))


def _validate_terminal(row, state):
    _valid_state(state)
    _text(row.get("reason"), "Reconciliation reason")
    _text(row.get("authorizationRef"), "Authorization reference")
    evidence = row.get("evidence", {})
    queue, log = evidence.get("queue", {}), evidence.get("inferenceLog", {})
    terminal_text, status_text = evidence.get("terminalReceiptText", ""), evidence.get("workerStatusText", "")
    release = queue.get("releaseReceipt", {})
    terminal, status = json.loads(terminal_text), json.loads(status_text)
    if row.get("schema") != RECONCILIATION or row.get("outcome") != "completed-unusable-output" or row.get("userConfirmed") is not False \
            or row.get("requestId") != state.get("requestId") or row.get("intentSha256") != state.get("intentSha256") \
            or row.get("pageId") != state.get("pageId") or row.get("evidenceSha256") != hashed(evidence) \
            or row.get("core") != state.get("intent", {}).get("core") \
            or queue.get("state") not in ("completed", "failed", "cancelled") \
            or not queue.get("dispatchId") or release.get("operationId") != queue["dispatchId"] \
            or release.get("authority") != "operator-attestation" or release.get("state") != queue["state"] \
            or release.get("confirmation") != "EXECUTOR_TERMINATED_AND_RUNTIME_RELEASED" \
            or release.get("receiptSha256") != _sha(terminal_text) \
            or release.get("receiptRef") != queue.get("executor", {}).get("receiptRef") \
            or terminal.get("contract") != "agentx.operator-heavy-work/v1" \
            or terminal.get("receiptRef") != release.get("receiptRef") or terminal.get("actor") != release.get("actor") \
            or terminal.get("queueRequestId") != queue.get("id") or terminal.get("dispatchId") != queue["dispatchId"] \
            or terminal.get("runtimeReleased") is not True or terminal.get("state") != queue["state"] \
            or terminal.get("workerStatusSha256") != _sha(status_text) \
            or status.get("queueRequestId") != queue["id"] or status.get("dispatchId") != queue["dispatchId"] \
            or status.get("pageId") != state.get("pageId") \
            or not re.fullmatch(r"[a-f0-9]{24}", str(log.get("_id", ""))) \
            or log.get("correlationId") != state.get("requestId") or log.get("status") != "success" \
            or log.get("taskType") != state.get("intent", {}).get("taskType"):
        raise ValueError("Native terminal reconciliation does not match the retained request and release")
    if _instant(log.get("timestamp")) < _instant(state["startedAt"]) - timedelta(seconds=5) \
            or _instant(log.get("timestamp")) > _instant(terminal["observedAt"]) + timedelta(seconds=5):
        raise ValueError("Native inference evidence lies outside the retained execution interval")
    return row


def terminal_at(directory, state):
    file = directory / "terminal-reconciliation.json"
    return _validate_terminal(load(file, {}), state) if file.exists() else None


def _next(directory, state, plan):
    terminal = terminal_at(directory, state)
    if terminal is None or (directory / "result.json").exists():
        raise ValueError("A retry needs a reconciled terminal request with no retained structured result")
    intent = {k: v for k, v in state["intent"].items() if k not in LINK_FIELDS}
    intent.update(maxOutputTokens=plan.get("maxOutputTokens"), parentRequestId=state["requestId"],
                  terminalReconciliationSha256=hashed(terminal))
    budget = plan.get("maxOutputTokens")
    if plan.get("schema") != RETRY or type(budget) is not int or not 1 <= budget <= 65536 \
            or plan.get("nativeAdmissionRequired") is not True or plan.get("userConfirmed") is not False \
            or plan.get("parentRequestId") != state["requestId"] or plan.get("parentIntentSha256") != state["intentSha256"] \
            or plan.get("terminalReconciliationSha256") != hashed(terminal) or plan.get("intent") != intent \
            or plan.get("requestId") != "secretary-review-" + hashed(intent):
        raise ValueError("Linked retry intent differs from its native terminal parent")
    _text(plan.get("reason"), "Retry reason"); _text(plan.get("authorizationRef"), "Authorization reference")
    return directory / "retries" / hashed(intent), intent


def selection(base, intent=None):
    directory, expected = Path(base), None
    for _ in range(8):
        file = directory / "retry-plan.json"
        if not file.exists():
            if intent is not None and expected is not None:
                supplied = {**intent, **{k: expected[k] for k in LINK_FIELDS}}
                if supplied != expected:
                    raise ValueError("The linked retry's policy or explicit output budget changed")
            return directory, expected if expected is not None else intent
        state = load(directory / "attempt.json", {})
        directory, expected = _next(directory, state, load(file, {}))
    raise ValueError("The bounded linked-retry chain needs explicit review")


def request_directory(base, request_id):
    directory = Path(base)
    for _ in range(8):
        state = load(directory / "attempt.json", {})
        if state.get("requestId") == request_id:
            return directory, state
        file = directory / "retry-plan.json"
        if not file.exists():
            break
        directory, _ = _next(directory, state, load(file, {}))
    raise ValueError("The exact retained request identity was not found")


def record_terminal(directory, state, *, queue_id, inference_log_id, terminal_file, status_file,
                    reason, authorization_ref, call):
    _valid_state(state)
    if not re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", queue_id or "") \
            or not re.fullmatch(r"[a-f0-9]{24}", inference_log_id or ""):
        raise ValueError("Use exact native queue and inference-log identities")
    reason, authorization_ref = _text(reason, "Reconciliation reason"), _text(authorization_ref, "Authorization reference")
    prior = terminal_at(directory, state)
    if prior:
        if prior["evidence"]["queue"]["id"] != queue_id or prior["evidence"]["inferenceLog"]["_id"] != inference_log_id \
                or prior["reason"] != reason or prior["authorizationRef"] != authorization_ref:
            raise ValueError("This immutable reconciliation already has other evidence or instructions")
        return prior
    if (directory / "result.json").exists():
        raise ValueError("Retain and recover the existing structured result instead of authorizing replacement")
    active = call("/api/nerve-center/runtime-coordination/active")
    if not {"maintenance", "workloads", "inferences"} <= set(active) \
            or not isinstance(active["workloads"], list) or not isinstance(active["inferences"], list) \
            or active.get("maintenance") or active.get("drain") or active["workloads"] or active["inferences"]:
        raise ValueError("Wait for native runtime release before terminal reconciliation")
    queue = call("/api/cluster/schedule/work-queue/" + queue_id)
    logs = call("/api/analytics/inference/logs?" + urllib.parse.urlencode({"correlationId": state["requestId"], "pageSize": 100}))
    matches = [row for row in logs.get("items", []) if row.get("_id") == inference_log_id]
    if len(matches) != 1 or logs.get("pagination", {}).get("hasNext"):
        raise ValueError("The selected native inference log is absent or its evidence set is incomplete")
    if str(Path(terminal_file).resolve()) != queue.get("executor", {}).get("receiptRef"):
        raise ValueError("The native terminal receipt path differs from the operator request")
    log = {k: matches[0].get(k) for k in ("_id", "correlationId", "status", "timestamp", "taskType", "tokensIn", "tokensOut", "durationMs")}
    evidence = {"queue": queue, "inferenceLog": log, "terminalReceiptText": Path(terminal_file).read_bytes().decode("utf-8"),
                "workerStatusText": Path(status_file).read_bytes().decode("utf-8")}
    row = {"schema": RECONCILIATION, "at": now(), "outcome": "completed-unusable-output", "core": state["intent"]["core"],
           "requestId": state["requestId"], "pageId": state["pageId"], "intentSha256": state["intentSha256"],
           "reason": reason, "authorizationRef": authorization_ref, "userConfirmed": False,
           "evidence": evidence, "evidenceSha256": hashed(evidence)}
    _validate_terminal(row, state)  # reject before creating authoritative reconciliation evidence
    try:
        durable(directory / "terminal-reconciliation.json", row, exclusive=True)
    except FileExistsError:
        prior = terminal_at(directory, state)
        if {k: v for k, v in prior.items() if k != "at"} != {k: v for k, v in row.items() if k != "at"}:
            raise ValueError("A different immutable reconciliation was retained concurrently")
        return prior
    return row


def authorize_retry(directory, state, *, max_output_tokens, reason, authorization_ref):
    terminal = terminal_at(directory, state)
    if terminal is None or (directory / "result.json").exists():
        raise ValueError("Reconcile the exact terminal request before planning a linked retry")
    intent = {k: v for k, v in state["intent"].items() if k not in LINK_FIELDS}
    intent.update(maxOutputTokens=max_output_tokens, parentRequestId=state["requestId"], terminalReconciliationSha256=hashed(terminal))
    row = {"schema": RETRY, "at": now(), "parentRequestId": state["requestId"], "parentIntentSha256": state["intentSha256"],
           "terminalReconciliationSha256": hashed(terminal), "maxOutputTokens": max_output_tokens,
           "intent": intent, "requestId": "secretary-review-" + hashed(intent),
           "reason": _text(reason, "Retry reason"), "authorizationRef": _text(authorization_ref, "Authorization reference"),
           "nativeAdmissionRequired": True, "userConfirmed": False}
    _next(directory, state, row)
    file = directory / "retry-plan.json"
    if file.exists():
        prior = load(file, {})
        if {k: v for k, v in prior.items() if k != "at"} != {k: v for k, v in row.items() if k != "at"}:
            raise ValueError("The immutable retry plan already has another intent")
        return prior
    durable(file, row, exclusive=True)
    return row


def core_reader(base):
    def call(path):
        with urllib.request.urlopen(base.rstrip("/") + path, timeout=30) as response:
            value = json.loads(response.read())
        if value.get("ok") is False or value.get("status") == "error":
            raise ValueError("Native Core refused the read-only evidence query")
        return value.get("data", value)
    return call


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("record-terminal", "authorize-retry", "record-refusal"))
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--page-id", required=True)
    parser.add_argument("--request-id", required=True)
    parser.add_argument("--reason", required=True)
    parser.add_argument("--authorization-ref", required=True)
    parser.add_argument("--queue-id")
    parser.add_argument("--inference-log-id")
    parser.add_argument("--terminal-receipt", type=Path)
    parser.add_argument("--worker-status", type=Path)
    parser.add_argument("--max-output-tokens", type=int)
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[a-zA-Z0-9_-]{8,256}", args.page_id) or not re.fullmatch(r"secretary-review-[a-f0-9]{64}", args.request_id):
        raise ValueError("Use explicit native page and request identities")
    if (args.directory / "worker.lock").exists():
        raise ValueError("Wait for the native worker before reconciling its results")
    base = args.directory / "review-attempts" / hashed(args.page_id)
    directory, state = request_directory(base, args.request_id)
    if args.operation == "record-terminal":
        if not args.queue_id or not args.inference_log_id or not args.terminal_receipt or not args.worker_status:
            raise ValueError("Native queue, inference-log and exact terminal/status receipts are required")
        row = record_terminal(directory, state, queue_id=args.queue_id, inference_log_id=args.inference_log_id,
            terminal_file=args.terminal_receipt, status_file=args.worker_status, reason=args.reason,
            authorization_ref=args.authorization_ref, call=core_reader(state["intent"]["core"]))
    elif args.operation == "record-refusal":
        row = record_refusal(directory, state, reason=args.reason, authorization_ref=args.authorization_ref,
                             call=core_reader(state["intent"]["core"]))
    else:
        row = authorize_retry(directory, state, max_output_tokens=args.max_output_tokens,
                              reason=args.reason, authorization_ref=args.authorization_ref)
    print(json.dumps({"operation": args.operation, "requestId": row["requestId"], "parentRequestId": row.get("parentRequestId"),
                      "receiptSha256": hashed(row), "inferenceStarted": False,
                      "originalFenceChanged": args.operation == "record-refusal", "requestIdentityChanged": False}))


if __name__ == "__main__":
    main()
