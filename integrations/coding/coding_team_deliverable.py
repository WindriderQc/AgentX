"""Bounded verification report deposited before terminal worker feedback."""

from __future__ import annotations

import base64
import hashlib
import json
import re
from typing import Any, Callable
from urllib.parse import quote


REPORT_NAME = "verification-report.md"


class ReportOutcomeUnknown(RuntimeError):
    """A POST may have committed, but its verified receipt is unavailable."""


def build_verified_feedback(
    worker_text: str,
    *,
    command: str,
    output: str,
    parse_criteria: Callable[[str], list[dict[str, Any]] | None],
) -> str:
    worker_criteria = parse_criteria(worker_text) or []
    output_tail = "\n".join(output.strip().splitlines()[-8:])[-1200:]
    command_summary = command.strip()
    if len(command_summary) > 1600:
        command_summary = command_summary[:1597] + "..."
    verified = {
        "criteria_verified": [{"id": "independent-verification-command", "status": "verified"}],
        "worker_criteria": [{"id": str(item.get("id", ""))[:80], "status": str(item.get("status", ""))[:40]} for item in worker_criteria[:8]],
        "additional_worker_criteria": max(0, len(worker_criteria) - 8),
        "dispatcher_verification": {
            "command": command_summary,
            "output_tail": output_tail,
            "summary": (
                "Independent verifier exited 0; deterministic repository guards passed. "
                "Worker criteria remain assertions for review; command success does not establish their coverage."
            ),
        },
    }
    worker_narrative = re.sub(
        r"```(?:json)?\s*\{\s*\"criteria_verified\".*?```",
        "",
        worker_text,
        flags=re.I | re.S,
    ).strip()
    evidence = "\n".join(
        [
            "Dispatcher independent verification: PASS",
            "```json",
            json.dumps(verified, indent=2, sort_keys=True),
            "```",
        ]
    )
    prefix = "\n".join([evidence, "", "Worker implementation evidence:"])
    remaining = max(0, 4900 - len(prefix) - 1)
    return prefix + "\n" + worker_narrative[:remaining]


def report_payload(*, agent: str, attempt: int, lease_id: str, text: str) -> dict[str, Any]:
    if not isinstance(attempt, int) or isinstance(attempt, bool) or not 1 <= attempt <= 10:
        raise ValueError("verification report attempt must be from 1 through 10")
    if not lease_id or not agent:
        raise ValueError("verification report requires an active worker lease and assignee")
    # Core's text-file contract rejects binary controls. Verification commands
    # often emit ANSI colors, which carry no evidence and must not block upload.
    clean = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
    clean = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", clean)
    data = clean.encode("utf-8")
    if not data or len(data) > 2 * 1024 * 1024:
        raise ValueError("verification report must be non-empty and at most 2 MiB")
    return {
        "name": REPORT_NAME,
        "dataUrl": "data:text/markdown;base64," + base64.b64encode(data).decode("ascii"),
        "sha256": hashlib.sha256(data).hexdigest(),
        "by": agent,
        "attempt": attempt,
        "leaseId": lease_id,
    }


def register_verification_report(
    api_json: Callable[..., dict[str, Any]],
    api_base: str,
    task_id: str,
    *,
    agent: str,
    attempt: int,
    lease_id: str,
    text: str,
) -> dict[str, Any]:
    payload = report_payload(agent=agent, attempt=attempt, lease_id=lease_id, text=text)
    path = f"/api/pipeline/tasks/{quote(str(task_id), safe='')}/deliverables"
    expected_lease_ref = "lease-" + hashlib.sha256(
        b"agentx.lease-reference/v1\0" + lease_id.encode("utf-8")
    ).hexdigest()[:16]

    def verified_receipt(response: dict[str, Any]) -> dict[str, Any]:
        data = response.get("data") if isinstance(response, dict) else None
        receipt = data.get("receipt") if isinstance(data, dict) else None
        producer = receipt.get("producer") if isinstance(receipt, dict) else None
        availability = receipt.get("availability") if isinstance(receipt, dict) else None
        if not isinstance(receipt, dict) or (
            receipt.get("name") != REPORT_NAME
            or receipt.get("attempt") != attempt
            or receipt.get("sha256") != payload["sha256"]
            or not isinstance(producer, dict)
            or producer.get("channel") != "worker_api"
            or producer.get("leaseRef") != expected_lease_ref
            or not isinstance(producer.get("permitSeq"), int)
            or producer.get("permitSeq") < 1
            or not isinstance(availability, dict)
            or availability.get("status") != "available"
        ):
            raise ValueError("verification report registration did not return a verified worker receipt")
        return receipt

    def existing_report() -> dict[str, Any] | None:
        try:
            listing = api_json(api_base, path)
        except Exception as exc:
            raise ReportOutcomeUnknown("verification report listing is unavailable; inspect the registry before retry") from exc
        rows = (listing.get("data") or {}).get("deliverables") if isinstance(listing, dict) else None
        if not isinstance(rows, list):
            raise ReportOutcomeUnknown("verification report listing is unavailable; inspect the registry before retry")
        existing = next((row for row in rows if isinstance(row, dict)
                         and row.get("name") == REPORT_NAME and row.get("attempt") == attempt), None)
        if not existing:
            return None
        if existing.get("sha256") != payload["sha256"] or not existing.get("id"):
            raise ValueError("a different verification report is already registered for this attempt")
        try:
            response = api_json(api_base, f"{path}/{quote(str(existing['id']), safe='')}")
        except Exception as exc:
            raise ReportOutcomeUnknown("verification report receipt is unavailable; inspect the registry before retry") from exc
        return verified_receipt(response)

    prior = existing_report()
    if prior:
        return prior
    try:
        response = api_json(api_base, path, method="POST", payload=payload)
    except Exception as exc:
        try:
            recovered = existing_report()
            if recovered:
                return recovered
        except ReportOutcomeUnknown:
            raise ReportOutcomeUnknown("verification report POST outcome is unknown; inspect the registry before retry") from exc
        raise ReportOutcomeUnknown("verification report POST outcome is unknown; inspect the registry before retry") from exc
    return verified_receipt(response)
