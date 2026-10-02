#!/usr/bin/env python3
"""Bounded AgentX pipeline lifecycle helper for OpenClaw workers."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


DEFAULT_API_BASE = os.environ.get("AGENTX_API", "http://127.0.0.1:3180")
FEEDBACK_TARGET_STATUS = {
    "done": "review",
    "partial": "in_progress",
    "blocked": "blocked",
}
TASK_ID_PATTERN = re.compile(r"^[0-9]{4,}$")


class PipelineWorkerError(RuntimeError):
    """Raised when a worker lifecycle operation does not satisfy its contract."""


def retry_after_delay(
    raw: str,
    headers: Mapping[str, str] | None = None,
    *,
    fallback: float = 1.5,
    max_wait: float = 60.0,
    now: datetime | None = None,
) -> float:
    value: Any = None
    if headers:
        value = headers.get("Retry-After")
    if value is None:
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = {}
        if isinstance(payload, dict):
            value = payload.get("retryAfter")
            data = payload.get("data")
            if value is None and isinstance(data, dict):
                value = data.get("retryAfter")

    delay = fallback
    if isinstance(value, (int, float)):
        delay = float(value)
    elif isinstance(value, str) and value.strip():
        candidate = value.strip()
        try:
            delay = float(candidate)
        except ValueError:
            try:
                target = datetime.fromisoformat(candidate.replace("Z", "+00:00"))
                current = now or datetime.now(timezone.utc)
                if target.tzinfo is None:
                    target = target.replace(tzinfo=timezone.utc)
                delay = (target - current).total_seconds()
            except ValueError:
                delay = fallback
    return max(0.0, min(delay, max_wait))


def api_json(
    api_base: str,
    path: str,
    *,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    timeout: int = 30,
    retries: int = 3,
) -> dict[str, Any]:
    url = f"{api_base.rstrip('/')}{path}"
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    for attempt in range(retries + 1):
        request = Request(url, data=data, headers=headers, method=method)
        try:
            with urlopen(request, timeout=timeout) as response:
                raw = response.read().decode("utf-8")
            parsed = json.loads(raw) if raw else {}
            if not isinstance(parsed, dict):
                raise PipelineWorkerError(f"non-object JSON from {url}")
            if parsed.get("ok") is False:
                raise PipelineWorkerError(
                    str(parsed.get("message") or parsed.get("error") or "API error")
                )
            return parsed
        except HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            if exc.code == 429 and attempt < retries:
                time.sleep(retry_after_delay(raw, exc.headers))
                continue
            raise PipelineWorkerError(
                f"{method} {url} failed with HTTP {exc.code}: {raw[:500]}"
            ) from exc
        except (URLError, TimeoutError, json.JSONDecodeError) as exc:
            if attempt < retries:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise PipelineWorkerError(f"{method} {url} failed: {exc}") from exc
    raise PipelineWorkerError(f"{method} {url} exhausted retries")


def task_from_envelope(envelope: dict[str, Any]) -> dict[str, Any]:
    data = envelope.get("data")
    task = data.get("task") if isinstance(data, dict) else None
    if not isinstance(task, dict):
        raise PipelineWorkerError("pipeline response is missing data.task")
    return task


def fetch_task(api_base: str, task_id: str) -> dict[str, Any]:
    query = urlencode({"includeDone": "true", "limit": "1000"})
    envelope = api_json(api_base, f"/api/pipeline/tasks?{query}")
    data = envelope.get("data")
    tasks = data.get("tasks") if isinstance(data, dict) else None
    if not isinstance(tasks, list):
        raise PipelineWorkerError("pipeline response is missing data.tasks")
    matches = [
        task
        for task in tasks
        if isinstance(task, dict) and str(task.get("pipelineId") or "") == task_id
    ]
    if len(matches) != 1:
        raise PipelineWorkerError(
            f"expected one pipeline task {task_id}, found {len(matches)}"
        )
    return matches[0]


def claim_task(api_base: str, task_id: str, assignee: str) -> dict[str, Any]:
    task = task_from_envelope(
        api_json(
            api_base,
            f"/api/pipeline/tasks/{task_id}/claim",
            method="POST",
            payload={"assignee": assignee},
        )
    )
    if task.get("status") != "in_progress" or task.get("assignee") != assignee:
        raise PipelineWorkerError("claim response did not confirm assignee/in_progress")
    return task


def heartbeat_task(api_base: str, task_id: str) -> dict[str, Any]:
    envelope = api_json(
        api_base,
        f"/api/pipeline/tasks/{task_id}/heartbeat",
        method="POST",
        payload={},
    )
    data = envelope.get("data")
    if not isinstance(data, dict) or str(data.get("pipelineId") or "") != task_id:
        raise PipelineWorkerError("heartbeat response did not confirm the task id")
    return data


def submit_feedback(
    api_base: str,
    task_id: str,
    *,
    by: str,
    status: str,
    text_file: Path,
) -> dict[str, Any]:
    text = text_file.read_text(encoding="utf-8").strip()
    if not text:
        raise PipelineWorkerError("feedback text file is empty")
    if len(text) > 5000:
        raise PipelineWorkerError(
            f"feedback text is {len(text)} characters; API limit is 5000"
        )
    task = task_from_envelope(
        api_json(
            api_base,
            f"/api/pipeline/tasks/{task_id}/feedback",
            method="POST",
            payload={"status": status, "by": by, "text": text},
        )
    )
    expected = FEEDBACK_TARGET_STATUS[status]
    if task.get("status") != expected:
        raise PipelineWorkerError(
            f"feedback response status is {task.get('status')!r}, expected {expected!r}"
        )
    feedback = task.get("feedback")
    latest = feedback[-1] if isinstance(feedback, list) and feedback else None
    if not isinstance(latest, dict) or str(latest.get("by") or "") != by:
        raise PipelineWorkerError("feedback response did not confirm the worker entry")
    return task


def validate_task_id(value: str) -> str:
    if not TASK_ID_PATTERN.fullmatch(value):
        raise argparse.ArgumentTypeError("task id must contain at least four digits")
    return value


def add_common(subparser: argparse.ArgumentParser) -> None:
    subparser.add_argument("--api-base", default=DEFAULT_API_BASE)
    subparser.add_argument("--task-id", required=True, type=validate_task_id)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Perform one bounded AgentX pipeline worker lifecycle action."
    )
    subparsers = parser.add_subparsers(dest="action", required=True)

    get_parser = subparsers.add_parser("get")
    add_common(get_parser)

    claim_parser = subparsers.add_parser("claim")
    add_common(claim_parser)
    claim_parser.add_argument("--assignee", required=True)

    heartbeat_parser = subparsers.add_parser("heartbeat")
    add_common(heartbeat_parser)

    feedback_parser = subparsers.add_parser("feedback")
    add_common(feedback_parser)
    feedback_parser.add_argument("--by", required=True)
    feedback_parser.add_argument(
        "--status", required=True, choices=sorted(FEEDBACK_TARGET_STATUS)
    )
    feedback_parser.add_argument("--text-file", required=True, type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if args.action == "get":
            result = fetch_task(args.api_base, args.task_id)
        elif args.action == "claim":
            result = claim_task(args.api_base, args.task_id, args.assignee)
        elif args.action == "heartbeat":
            result = heartbeat_task(args.api_base, args.task_id)
        else:
            result = submit_feedback(
                args.api_base,
                args.task_id,
                by=args.by,
                status=args.status,
                text_file=args.text_file,
            )
        print(json.dumps({"ok": True, "action": args.action, "result": result}))
        return 0
    except (OSError, PipelineWorkerError) as exc:
        print(
            json.dumps({"ok": False, "action": args.action, "error": str(exc)}),
            file=sys.stderr,
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
