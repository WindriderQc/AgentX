"""Durable page-review dispatch fences and saved outcomes; never retry uncertainty."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path

from evidence_store import load, now
from review_response import ReviewInvalidOutput
from review_receipts import hashed, durable
from review_recovery import selection, terminal_at


class ReviewUncertain(RuntimeError):
    """The exact native request must be reconciled before another model call."""


def completed(directory, state):
    try: receipt = load(directory / "result.json", {})
    except (OSError, ValueError): return None
    if receipt.get("schema") != "agentx.secretary-review-result/v1" \
            or receipt.get("requestId") != state.get("requestId") \
            or receipt.get("intentSha256") != state.get("intentSha256") \
            or not isinstance(receipt.get("at"), str) or not receipt["at"] \
            or not isinstance(receipt.get("value"), dict) or receipt.get("valueSha256") != hashed(receipt["value"]):
        return None
    if state.get("phase") != "completed":
        state.update(phase="completed", finishedAt=receipt["at"], valueSha256=receipt["valueSha256"])
        durable(directory / "attempt.json", state)
    return receipt["value"]


def response_file(directory, state, stage):
    return directory / f"response-{state['attempt']}-{stage}.txt"


def capture_response(directory, state):
    def capture(stage, content, details):
        if stage not in ("http", "model") or not isinstance(content, bytes):
            raise ValueError("Unknown native response capture stage")
        file = response_file(directory, state, stage)
        descriptor = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write(content); output.flush(); os.fsync(output.fileno())
        durable(file.with_suffix(".json"), {"schema": "agentx.secretary-review-response/v1", "stage": stage,
            "requestId": state["requestId"], "intentSha256": state["intentSha256"], "at": now(),
            "bytes": len(content), "bodySha256": hashlib.sha256(content).hexdigest(),
            "representation": "exact-received-text-bytes", **details}, exclusive=True)
    return capture


def response_received(directory, state):
    try:
        file = response_file(directory, state, "http")
        receipt, content = load(file.with_suffix(".json"), {}), file.read_bytes()
        return receipt.get("schema") == "agentx.secretary-review-response/v1" \
            and receipt.get("requestId") == state.get("requestId") \
            and receipt.get("intentSha256") == state.get("intentSha256") \
            and receipt.get("stage") == "http" and receipt.get("httpStatus") == 200 \
            and receipt.get("bytes") == len(content) and receipt.get("bodySha256") == hashlib.sha256(content).hexdigest()
    except (OSError, ValueError, KeyError, TypeError):
        return False


def unsettled(root, attempts="review-attempts"):
    result = []
    for file in (Path(root) / attempts).glob("*/attempt.json"):
        try:
            directory, expected = selection(file.parent)
            file = directory / "attempt.json"
            if not file.exists() and expected is not None:
                continue  # an explicit linked plan exists, but no child dispatch has started
            state = load(file, {})
            if expected is not None and (state.get("intent") != expected or state.get("intentSha256") != hashed(expected)):
                raise ValueError("The retained linked attempt differs from its authorized plan")
            if state.get("phase") == "refused":
                continue
            if completed(file.parent, state) is not None:
                continue
            terminal = terminal_at(file.parent, state)
        except (OSError, ValueError, KeyError, TypeError):
            state, terminal = {}, None
        result.append({"requestId": state.get("requestId"), "pageId": state.get("pageId"),
                       "phase": state.get("phase", "unreadable"), "receipt": str(file),
                       **({"outcome": "completed-invalid-output"} if terminal or state.get("phase") == "invalid-output" and response_received(file.parent, state) else {})})
    return result


def blocked_counts(held):
    invalid = sum(row.get("outcome") == "completed-invalid-output" for row in held)
    return {"unresolvedInferenceAttempts": len(held) - invalid, "invalidInferenceResults": invalid}


def blocked_phase(held):
    return "validation-error" if held and blocked_counts(held)["unresolvedInferenceAttempts"] == 0 else "uncertain"


def result_file(root, page_id, attempts="review-attempts"):
    """Locate an explicitly linked retained result without issuing or authorizing a call."""
    try:
        directory, _ = selection(Path(root) / attempts / hashed(page_id))
        return directory / "result.json"
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise ReviewUncertain("The retained review chain needs native reconciliation") from error


def extract_once(archive, client, system, prompt, page, light=False, attempts="review-attempts"):
    directory = archive.root / attempts / hashed(page["pageId"])
    intent = {"pageId": page["pageId"], "systemSha256": hashed(system), "promptSha256": hashed(prompt),
              "core": getattr(client, "base", None), "taskType": getattr(client, "task_type", None),
              "lightModel": getattr(client, "light_model", None) if light else None,
              "lightHost": getattr(client, "light_host", None) if light else None, "light": light}
    if getattr(client, "max_output_tokens", None) is not None:
        intent["maxOutputTokens"] = client.max_output_tokens
    if getattr(client, "thinking", False) is True:
        intent["thinking"] = True  # false preserves the original dispatch identity
    try:
        directory, intent = selection(directory, intent)
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise ReviewUncertain("The explicit native retry plan no longer matches this review intent") from error
    file = directory / "attempt.json"
    identity = "secretary-review-" + hashed(intent)
    state = {"schema": "agentx.secretary-review-attempt/v1", "requestId": identity, "pageId": page["pageId"],
             "threadId": page["threadId"], "intentSha256": hashed(intent), "intent": intent,
             "phase": "pending", "attempt": 1, "startedAt": now()}
    try:
        durable(file, state, exclusive=True)
    except FileExistsError:
        try: state = load(file, {})
        except (OSError, ValueError) as error:
            raise ReviewUncertain("The saved page-review fence is unreadable; retain it for native reconciliation") from error
        if state.get("requestId") != identity or state.get("intentSha256") != hashed(intent):
            raise ReviewUncertain("The saved page-review intent changed; reconcile its original identity")
        value = completed(directory, state)
        if value is not None:
            return value
        if state.get("phase") == "invalid-output" and response_received(directory, state):
            raise ReviewInvalidOutput(state.get("invalidReason", "retained-invalid-response"), state.get("limits"))
        try:
            terminal = terminal_at(directory, state)
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise ReviewUncertain("The saved terminal reconciliation needs inspection") from error
        if terminal:
            raise ReviewInvalidOutput("native-terminal-unusable-output", terminal["evidence"]["inferenceLog"])
        if state.get("phase") != "refused":
            raise ReviewUncertain("Page review outcome is unconfirmed; retain its native request identity")
        state.update(phase="pending", attempt=state["attempt"] + 1, updatedAt=now())
    try:
        durable(directory / f"dispatch-{state['attempt']}.json", {
            "requestId": identity, "intentSha256": state["intentSha256"], "at": now()}, exclusive=True)
    except FileExistsError:
        raise ReviewUncertain("This exact page-review dispatch already exists; reconcile before continuing")
    durable(file, state)
    capturing = hasattr(client, "review_response_sink")
    prior_capture = getattr(client, "review_response_sink", None)
    if capturing:
        client.review_response_sink = capture_response(directory, state)
    try:
        value = client.extract(system, prompt, light=light, request_id=identity)
        if not isinstance(value, dict):
            raise ValueError("Page review returned no structured result")
        receipt = {"schema": "agentx.secretary-review-result/v1", "requestId": identity,
                   "intentSha256": state["intentSha256"], "at": now(), "value": value,
                   "valueSha256": hashed(value), "inference": getattr(client, "last_inference_receipt", None)}
        durable(directory / "result.json", receipt)
    except Exception as error:
        known_invalid = isinstance(error, ReviewInvalidOutput) and response_received(directory, state)
        state.update(phase="invalid-output" if known_invalid else "refused" if getattr(error, "safe_to_retry", False) is True else "unconfirmed",
                     updatedAt=now(), errorType=type(error).__name__)
        if known_invalid:
            state.update(invalidReason=error.reason, limits=error.limits)
        durable(file, state)
        if state["phase"] in ("refused", "invalid-output"):
            raise
        raise ReviewUncertain("Page-review response is uncertain; reconcile the saved request before any replacement") from error
    finally:
        if capturing:
            client.review_response_sink = prior_capture
    state.update(phase="completed", finishedAt=receipt["at"], valueSha256=receipt["valueSha256"])
    durable(file, state)
    return value
