"""Pipeline API calls for the guarded ClawdX dispatch: task fetch and claim,
attribution leases, heartbeats, requeue, worker feedback and failure blocking.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import threading
import time
from typing import Any, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import Request, urlopen

try:
    from integrations.coding.coding_dispatch_evidence import (
        PipelineApiError,
        ResourcePreflightDeferred,
        retry_after_delay,
        validate_attribution_args,
    )
except ModuleNotFoundError:  # direct execution from the scripts directory
    from coding_dispatch_evidence import (  # type: ignore
        PipelineApiError,
        ResourcePreflightDeferred,
        retry_after_delay,
        validate_attribution_args,
    )


DEFAULT_AGENT = "clawdx-worker"
PIPELINE_ATTRIBUTION_ROUTE = "/api/runtime-bridges/pipeline-attribution"


def api_json(
    api_base: str,
    path: str,
    *,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    timeout: int = 30,
    retries: int = 3,
    headers: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    url = f"{api_base.rstrip('/')}{path}"
    data = None
    request_headers = {"Accept": "application/json"}
    parsed_url = urlsplit(url)
    if parsed_url.scheme and parsed_url.netloc:
        origin = f"{parsed_url.scheme}://{parsed_url.netloc}"
        request_headers.update({
            "Origin": origin,
            "Referer": f"{origin}/pipeline",
            "Sec-Fetch-Site": "same-origin",
        })
    if headers:
        request_headers.update({str(key): str(value) for key, value in headers.items()})
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        request_headers["Content-Type"] = "application/json"

    for attempt in range(retries + 1):
        request = Request(url, data=data, headers=request_headers, method=method)
        try:
            with urlopen(request, timeout=timeout) as response:
                raw = response.read().decode("utf-8")
            parsed = json.loads(raw) if raw else {}
            if not isinstance(parsed, dict):
                raise PipelineApiError(f"pipeline API returned non-object JSON from {url}")
            if parsed.get("ok") is False:
                raise PipelineApiError(
                    str(parsed.get("message") or parsed.get("error") or "pipeline API error")
                )
            return parsed
        except HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            if exc.code == 429 and attempt < retries:
                time.sleep(retry_after_delay(raw, exc.headers))
                continue
            try:
                failure = json.loads(raw)
            except json.JSONDecodeError:
                failure = None
            code = failure.get("code") if isinstance(failure, dict) and failure.get("ok") is False else None
            raise PipelineApiError(
                f"pipeline API {method} {url} failed with HTTP {exc.code}: {raw[:500]}",
                status=exc.code, code=code if isinstance(code, str) else None,
            ) from exc
        except (URLError, TimeoutError, json.JSONDecodeError) as exc:
            if attempt < retries:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise PipelineApiError(f"pipeline API {method} {url} failed: {exc}") from exc
    raise PipelineApiError(f"pipeline API {method} {url} exhausted retries")


def fetch_task(
    api_base: str,
    task_id: str,
    *,
    agent: str = DEFAULT_AGENT,
    timeout: int = 30,
) -> dict[str, Any]:
    query = urlencode({"agent": agent})
    envelope = api_json(
        api_base,
        f"/api/pipeline/tasks/{task_id}/worker?{query}",
        timeout=timeout,
    )
    data = envelope.get("data")
    task = data.get("task") if isinstance(data, dict) else None
    if not isinstance(task, dict) or str(task.get("pipelineId") or "") != str(task_id):
        raise PipelineApiError("worker task response is missing the requested task")
    return task


def claim_task(
    api_base: str,
    task_id: str,
    *,
    agent: str,
    automated: bool = False,
    lease_duration_ms: int | None = None,
    timeout: int = 30,
) -> dict[str, Any]:
    payload: dict[str, Any] = {"assignee": agent}
    if automated:
        request_id = os.environ.get("AGENTX_CODING_DISPATCH_REQUEST_ID", "")  # launch reference, not authority
        payload.update({"automated": True, "leaseDurationMs": lease_duration_ms, **({"dispatchRequestId": request_id} if re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", request_id) else {})})
    try:
        envelope = api_json(
            api_base,
            f"/api/pipeline/tasks/{task_id}/claim",
            method="POST",
            payload=payload,
            timeout=timeout,
            retries=0,  # A lost claim response must not replay a mutation.
        )
    except PipelineApiError as exc:
        # Core acquires this slot before updating the task or incrementing attempts.
        if automated and exc.status == 409 and exc.code == "AUTOMATION_SLOT_OCCUPIED":
            raise ResourcePreflightDeferred(str(exc), status=exc.status, code=exc.code) from exc
        raise
    data = envelope.get("data")
    task = data.get("task") if isinstance(data, dict) else None
    if not isinstance(task, dict):
        raise PipelineApiError("claim response is missing data.task")
    if task.get("status") != "in_progress" or task.get("assignee") != agent:
        raise PipelineApiError("claim did not return the expected in_progress task assignment")
    return task


def open_attribution_lease(
    args: argparse.Namespace,
    *,
    request_id: str,
) -> dict[str, Any] | None:
    if not getattr(args, "attest_attribution", False):
        return None
    validate_attribution_args(args)
    envelope = api_json(
        args.api_base,
        f"{PIPELINE_ATTRIBUTION_ROUTE}/leases",
        method="POST",
        payload={
            "pipelineId": args.task_id,
            "assignee": args.agent,
            "requestId": request_id,
            "taskType": getattr(args, "attribution_task_type", "code_generation"),
            "attempt": getattr(args, "attribution_attempt", None),
            "ttlSeconds": min(1_800, max(30, int(args.timeout) + 120)),
        },
    )
    data = envelope.get("data")
    lease = data.get("lease") if isinstance(data, dict) else None
    if not isinstance(lease, dict):
        raise PipelineApiError("Pipeline attribution response is missing data.lease")
    if not str(lease.get("leaseId") or "").strip() or not str(
        lease.get("effectiveModel") or ""
    ).strip():
        raise PipelineApiError("Pipeline attribution lease identity is incomplete")
    print("pipeline_attribution_lease=opened")
    return lease


def close_attribution_lease(
    args: argparse.Namespace,
    lease: dict[str, Any] | None,
    *,
    request_id: str,
) -> int | None:
    if not lease:
        return None
    lease_id = str(lease.get("leaseId") or "").strip()
    envelope = api_json(
        args.api_base,
        f"{PIPELINE_ATTRIBUTION_ROUTE}/leases/{quote(lease_id, safe='')}/close",
        method="POST",
        payload={"requestId": request_id},
    )
    data = envelope.get("data")
    if not isinstance(data, dict) or data.get("closed") is not True:
        raise PipelineApiError("Pipeline attribution lease close was not acknowledged")
    request_count = data.get("requestCount")
    if not isinstance(request_count, int) or isinstance(request_count, bool) or request_count < 1:
        raise PipelineApiError(
            "Pipeline attribution lease closed without an attributed request"
        )
    print("pipeline_attribution_lease=closed")
    print(f"pipeline_attributed_requests={request_count}")
    if isinstance(data.get("inference"), dict):
        lease["inference"] = data["inference"]
    return request_count


def heartbeat_task(
    api_base: str,
    task_id: str,
    *,
    agent: str,
    lease_id: str,
    timeout: int = 30,
) -> dict[str, Any]:
    envelope = api_json(
        api_base,
        f"/api/pipeline/tasks/{task_id}/heartbeat",
        method="POST",
        payload={"assignee": agent, "leaseId": lease_id},
        timeout=timeout,
    )
    data = envelope.get("data")
    if not isinstance(data, dict) or str(data.get("pipelineId") or "") != str(task_id):
        raise PipelineApiError("heartbeat response is missing the requested task identity")
    return data


class LeaseHeartbeat:
    """Keep a server-issued lease alive while the worker and verifier run."""

    def __init__(
        self,
        api_base: str,
        task_id: str,
        *,
        agent: str,
        lease_id: str,
        lease_duration_ms: int,
    ) -> None:
        self.api_base = api_base
        self.task_id = task_id
        self.agent = agent
        self.lease_id = lease_id
        self.interval = max(1.0, min(60.0, lease_duration_ms / 3000.0))
        self._stop = threading.Event()
        self._error: Exception | None = None
        self._thread = threading.Thread(
            target=self._run,
            name=f"agentx-lease-heartbeat-{task_id}",
            daemon=True,
        )

    def __enter__(self) -> "LeaseHeartbeat":
        self._thread.start()
        return self

    def __exit__(self, _exc_type, _exc, _traceback) -> None:
        self._stop.set()
        self._thread.join(timeout=5)

    def _run(self) -> None:
        while not self._stop.wait(self.interval):
            try:
                heartbeat_task(
                    self.api_base,
                    self.task_id,
                    agent=self.agent,
                    lease_id=self.lease_id,
                )
            except Exception as exc:  # surfaced synchronously by ensure_healthy
                self._error = exc
                self._stop.set()

    def ensure_healthy(self) -> None:
        if self._error is not None:
            raise PipelineApiError(
                f"automation lease heartbeat failed: {type(self._error).__name__}: {self._error}"
            ) from self._error


def requeue_task(
    api_base: str,
    task_id: str,
    *,
    lease_id: str | None = None,
    lease_assignee: str | None = None,
    timeout: int = 30,
) -> dict[str, Any]:
    payload: dict[str, Any] = {"status": "queued", "by": "guarded-dispatch"}
    if lease_id:
        payload.update({"leaseId": lease_id, "leaseAssignee": lease_assignee})
    envelope = api_json(
        api_base,
        f"/api/pipeline/tasks/{task_id}/status",
        method="POST",
        payload=payload,
        timeout=timeout,
    )
    data = envelope.get("data")
    task = data.get("task") if isinstance(data, dict) else None
    if not isinstance(task, dict):
        raise PipelineApiError("requeue response is missing data.task")
    if task.get("status") != "queued" or task.get("assignee") is not None:
        raise PipelineApiError("requeue did not release the blocked task")
    return task


def submit_worker_feedback(
    api_base: str,
    task_id: str,
    *,
    agent: str,
    text: str,
    lease_id: str | None = None,
    attempt_evidence: dict[str, Any] | None = None,
    timeout: int = 30,
) -> dict[str, Any]:
    payload: dict[str, Any] = {"status": "done", "by": agent, "text": text}
    if lease_id:
        payload.update({"leaseId": lease_id, "leaseAssignee": agent})
    if lease_id and attempt_evidence is not None:
        payload["attemptEvidence"] = attempt_evidence
    envelope = api_json(
        api_base,
        f"/api/pipeline/tasks/{task_id}/feedback",
        method="POST",
        payload=payload,
        timeout=timeout,
    )
    data = envelope.get("data")
    task = data.get("task") if isinstance(data, dict) else None
    if not isinstance(task, dict):
        raise PipelineApiError("feedback response is missing data.task")
    if task.get("status") != "review":
        raise PipelineApiError(
            f"worker feedback left task in status {task.get('status')!r}"
        )
    return task


def block_failed_dispatch(
    api_base: str,
    task_id: str,
    *,
    agent: str,
    failures: list[str],
    worker_feedback: str = "",
    lease_id: str | None = None,
    attempt_evidence: dict[str, Any] | None = None,
    timeout: int = 30,
) -> dict[str, Any]:
    """Append a guard-owned blocked verdict after post-run validation fails."""
    reasons = [str(failure).strip() for failure in failures if str(failure).strip()]
    # Core feedback is bounded to 5000 characters; preserve the worker's question
    # even when a verifier returns many long diagnostics (kept in run artifacts).
    reasons = [reason[:180] for reason in reasons[:4]]
    verification = {
        "criteria_verified": [
            {
                "id": "guarded_dispatch",
                "status": "fail",
                "command": "post-run guarded dispatch validation",
                "output_summary": "; ".join(reasons),
            }
        ]
    }
    text = "\n".join(
        [
            "Guarded dispatcher verdict: BLOCKED.",
            f"Worker: {agent}",
            "The worker result failed one or more mandatory post-run gates:",
            *[f"- {reason}" for reason in reasons],
            "",
            "Worker question or problem (not verification evidence):",
            worker_feedback.strip()[:2400] or "No worker explanation was returned. See the technical reason above.",
            "",
            "The worker feedback and final response are rejected as completion evidence.",
            "```json",
            json.dumps(verification, indent=2, sort_keys=True),
            "```",
        ]
    )
    payload: dict[str, Any] = {
        "status": "blocked",
        "by": "guarded-dispatch",
        "text": text,
    }
    if lease_id:
        payload.update({"leaseId": lease_id, "leaseAssignee": agent})
    if lease_id and attempt_evidence is not None:
        payload["attemptEvidence"] = attempt_evidence
    envelope = api_json(
        api_base,
        f"/api/pipeline/tasks/{task_id}/feedback",
        method="POST",
        payload=payload,
        timeout=timeout,
    )
    data = envelope.get("data")
    task = data.get("task") if isinstance(data, dict) else None
    if not isinstance(task, dict):
        raise PipelineApiError("blocked feedback response is missing data.task")
    if task.get("status") != "blocked":
        raise PipelineApiError(
            f"blocked feedback left task in status {task.get('status')!r}"
        )
    return task
