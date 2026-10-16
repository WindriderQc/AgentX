"""Durable page-review dispatch fences and saved outcomes; never retry uncertainty."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

from evidence_store import load, now


class ReviewUncertain(RuntimeError):
    """The exact native request must be reconciled before another model call."""


def hashed(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def durable(file, value, exclusive=False):
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = file if exclusive else file.with_name(file.name + f".{os.getpid()}.tmp")
    flags = os.O_WRONLY | os.O_CREAT | (os.O_EXCL if exclusive else os.O_TRUNC)
    descriptor = os.open(target, flags, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        json.dump(value, output, ensure_ascii=False, indent=2)
        output.flush(); os.fsync(output.fileno())
    if not exclusive:
        target.replace(file)
    if os.name != "nt":
        directory = os.open(file.parent, os.O_RDONLY)
        try: os.fsync(directory)
        finally: os.close(directory)


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


def unsettled(root):
    result = []
    for file in (Path(root) / "review-attempts").glob("*/attempt.json"):
        try:
            state = load(file, {})
            if state.get("phase") == "refused":
                continue
            if completed(file.parent, state) is not None:
                continue
        except (OSError, ValueError, KeyError, TypeError):
            state = {}
        result.append({"requestId": state.get("requestId"), "pageId": state.get("pageId"),
                       "phase": state.get("phase", "unreadable"), "receipt": str(file)})
    return result


def extract_once(archive, client, system, prompt, page, light=False):
    directory = archive.root / "review-attempts" / hashed(page["pageId"])
    file = directory / "attempt.json"
    intent = {"pageId": page["pageId"], "systemSha256": hashed(system), "promptSha256": hashed(prompt),
              "core": getattr(client, "base", None), "taskType": getattr(client, "task_type", None),
              "lightModel": getattr(client, "light_model", None) if light else None,
              "lightHost": getattr(client, "light_host", None) if light else None, "light": light}
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
        if state.get("phase") != "refused":
            raise ReviewUncertain("Page review outcome is unconfirmed; retain its native request identity")
        state.update(phase="pending", attempt=state["attempt"] + 1, updatedAt=now())
    try:
        durable(directory / f"dispatch-{state['attempt']}.json", {
            "requestId": identity, "intentSha256": state["intentSha256"], "at": now()}, exclusive=True)
    except FileExistsError:
        raise ReviewUncertain("This exact page-review dispatch already exists; reconcile before continuing")
    durable(file, state)
    try:
        value = client.extract(system, prompt, light=light, request_id=identity)
        if not isinstance(value, dict):
            raise ValueError("Page review returned no structured result")
        receipt = {"schema": "agentx.secretary-review-result/v1", "requestId": identity,
                   "intentSha256": state["intentSha256"], "at": now(), "value": value,
                   "valueSha256": hashed(value), "inference": getattr(client, "last_inference_receipt", None)}
        durable(directory / "result.json", receipt)
    except Exception as error:
        state.update(phase="refused" if getattr(error, "safe_to_retry", False) is True else "unconfirmed",
                     updatedAt=now(), errorType=type(error).__name__)
        durable(file, state)
        if state["phase"] == "refused":
            raise
        raise ReviewUncertain("Page-review response is uncertain; reconcile the saved request before any replacement") from error
    state.update(phase="completed", finishedAt=receipt["at"], valueSha256=receipt["valueSha256"])
    durable(file, state)
    return value
