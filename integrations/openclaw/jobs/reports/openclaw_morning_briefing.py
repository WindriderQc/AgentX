#!/usr/bin/env python3
"""Render the statement-free AgentX morning briefing for OpenClaw delivery."""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import urllib.error
import urllib.request

DEFAULT_BASE_URL = "http://127.0.0.1:3180"
REPORT_ROUTE = "/api/reports/morning-brief"
REPORT_URL = DEFAULT_BASE_URL + REPORT_ROUTE


class MorningBriefingError(RuntimeError):
    """Operator-safe failure that must fail the scheduled command."""


def fetch_report(
    url: str = REPORT_URL,
    *,
    timeout: int = 20,
) -> dict:
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.load(response)
    except urllib.error.HTTPError as error:
        raise MorningBriefingError(
            f"AgentX morning report returned HTTP {error.code}"
        ) from error
    except (urllib.error.URLError, OSError, TimeoutError, ValueError) as error:
        raise MorningBriefingError("AgentX morning report is unavailable") from error
    if not isinstance(body, dict):
        raise MorningBriefingError("AgentX morning report returned an invalid envelope")
    return body


def require_report_data(body: dict) -> dict:
    if body.get("status") != "success" or not isinstance(body.get("data"), dict):
        raise MorningBriefingError("AgentX morning report returned an invalid success envelope")
    data = body["data"]
    for name in ("alerts", "analytics", "performance", "memoryReview"):
        value = data.get(name)
        if not isinstance(value, dict) or value.get("error"):
            raise MorningBriefingError(f"AgentX morning report returned invalid {name} evidence")
    active_run = (data.get("memoryReview") or {}).get("activeRun")
    if active_run is not None and not isinstance(active_run, dict):
        raise MorningBriefingError("AgentX morning report returned invalid memoryReview evidence")
    reconciliation = (active_run or {}).get("reconciliation")
    if reconciliation is not None and not isinstance(reconciliation, dict):
        raise MorningBriefingError("AgentX morning report returned invalid reconciliation evidence")
    return data


def nonnegative_int(value: object, label: str) -> int:
    if isinstance(value, bool):
        raise MorningBriefingError(f"AgentX morning report returned invalid {label}")
    try:
        parsed = int(value)
    except (TypeError, ValueError, OverflowError) as error:
        raise MorningBriefingError(f"AgentX morning report returned invalid {label}") from error
    if parsed < 0 or (isinstance(value, float) and value != parsed):
        raise MorningBriefingError(f"AgentX morning report returned invalid {label}")
    return parsed


def finite_number(value: object, label: str) -> float:
    if isinstance(value, bool):
        raise MorningBriefingError(f"AgentX morning report returned invalid {label}")
    try:
        parsed = float(value)
    except (TypeError, ValueError, OverflowError) as error:
        raise MorningBriefingError(f"AgentX morning report returned invalid {label}") from error
    if not math.isfinite(parsed):
        raise MorningBriefingError(f"AgentX morning report returned invalid {label}")
    return parsed


def has_attention(data: dict) -> bool:
    alerts = data.get("alerts") or {}
    memory_review = data.get("memoryReview") or {}
    active_run = memory_review.get("activeRun") or {}
    reconciliation = active_run.get("reconciliation") or {}
    return any(
        (
            nonnegative_int(alerts.get("critical"), "alerts.critical") > 0,
            nonnegative_int(alerts.get("warning"), "alerts.warning") > 0,
            nonnegative_int(alerts.get("active"), "alerts.active") > 0,
            nonnegative_int(memory_review.get("pending"), "memoryReview.pending") > 0,
            bool(memory_review.get("attention")),
            bool(reconciliation.get("overdue")),
        )
    )


def build_lines(data: dict) -> list[str]:
    alerts = data.get("alerts") or {}
    analytics = data.get("analytics") or {}
    performance = data.get("performance") or {}
    memory_review = data.get("memoryReview") or {}
    critical = nonnegative_int(alerts.get("critical"), "alerts.critical")
    warning = nonnegative_int(alerts.get("warning"), "alerts.warning")
    active = nonnegative_int(alerts.get("active"), "alerts.active")

    if critical:
        recent = alerts.get("recent") or []
        first = recent[0] if recent and isinstance(recent[0], dict) else {}
        detail = first.get("title") or first.get("message") or "critical alert active"
        lines = [f"RED Critical alerts: {critical} - {detail}"]
    elif warning:
        lines = [f"YELLOW {warning} warning alert(s) active"]
    elif active == 0:
        lines = ["GREEN All clear"]
    elif data.get("summary"):
        lines = [str(data["summary"])]
    else:
        lines = [f"{active} active alert(s)"]

    messages = nonnegative_int(
        analytics.get("messages", analytics.get("message_count")),
        "analytics.messages",
    )
    cost = finite_number(analytics.get("cost_usd", analytics.get("cost")), "analytics.cost")
    lines.append(f"Analytics: {messages} messages, ${cost:.4f} cost")
    latency = performance.get("avg_latency_ms", performance.get("avg_latency", performance.get("latency_ms")))
    lines.append(f"Performance: avg latency {round(finite_number(latency, 'performance.latency'))}ms")

    pending = nonnegative_int(memory_review.get("pending"), "memoryReview.pending")
    run_id = str(memory_review.get("runId") or "")
    active_run = memory_review.get("activeRun") or {}
    reconciliation = active_run.get("reconciliation") or {}
    if pending:
        suffix = f" in {run_id}" if run_id else ""
        lines.append(
            f"Dreaming Review: {pending} awaiting individual review{suffix}. Open AgentX /memory-review."
        )
    if memory_review.get("attention") or reconciliation.get("overdue"):
        active_id = str(active_run.get("runId") or "")
        missing = [str(value) for value in (reconciliation.get("missingRuntimes") or [])]
        suffix = f" {active_id}" if active_id else ""
        waiting = f" waiting for {', '.join(missing)}" if missing else ""
        lines.append(
            f"Dreaming Review:{suffix} reconciliation is overdue{waiting}. Open AgentX /memory-review."
        )
    elif not pending:
        lines.append("Dreaming Review: nothing awaiting review.")
    return lines


def default_report_url() -> str:
    for name in ("AGENTX_CORE_URL", "AGENTX_BASE_URL"):
        value = os.environ.get(name, "").strip()
        if value:
            return value.rstrip("/") + REPORT_ROUTE
    return REPORT_URL


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report-url", default=default_report_url())
    parser.add_argument("--timeout", type=int, default=20)
    parser.add_argument(
        "--exception-only",
        action="store_true",
        help="Emit no message when the report contains no active attention state",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        body = fetch_report(args.report_url, timeout=args.timeout)
        data = require_report_data(body)
        output = "\n".join(build_lines(data))
        if args.exception_only and not has_attention(data):
            return 0
    except MorningBriefingError as error:
        print(f"Morning briefing failed: {error}", file=sys.stderr)
        return 1
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
