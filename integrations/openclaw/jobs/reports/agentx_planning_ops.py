#!/usr/bin/env python3
"""OpenClaw command helper for AgentX Planning reconciliation, daily digest and weekly review."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_BASE_URL = "http://127.0.0.1:3180"
DEFAULT_TIMEOUT = 25
MAX_OUTPUT_CHARS = 3800
TOKEN_FILES = (
    Path.home() / ".openclaw" / ".env",
    Path.home() / ".openclaw" / "gateway.systemd.env",
)
OPERATOR_TOKEN_FILES = (
    Path.home() / ".config" / "agentx" / "aiops.env",
)


class PlanningOpsError(RuntimeError):
    """Bounded operator-safe failure."""


def unwrap(body: Any) -> dict[str, Any]:
    if not isinstance(body, dict):
        raise PlanningOpsError("AgentX returned a non-object response")
    data = body.get("data", body)
    if not isinstance(data, dict):
        raise PlanningOpsError("AgentX returned an invalid data envelope")
    return data


def env_value(path: Path, key: str) -> str:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return ""
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        name = name.strip().removeprefix("export ").strip()
        if name != key:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        return value
    return ""


def resolve_token() -> str:
    token = os.environ.get("AGENTX_MCP_TOKEN", "").strip()
    if token:
        return token
    for path in TOKEN_FILES:
        token = env_value(path, "AGENTX_MCP_TOKEN").strip()
        if token:
            return token
    raise PlanningOpsError("AGENTX_MCP_TOKEN is unavailable in the OpenClaw private environment")


def resolve_operator_token() -> str:
    token = os.environ.get("AGENTX_OPERATOR_TOKEN", "").strip()
    if token:
        return token
    for path in OPERATOR_TOKEN_FILES:
        token = env_value(path, "AGENTX_OPERATOR_TOKEN").strip()
        if token:
            return token
    raise PlanningOpsError("AGENTX_OPERATOR_TOKEN is unavailable in the AIOps private environment")


def operator_headers() -> dict[str, str]:
    return {"x-agentx-operator-token": resolve_operator_token()}


def http_json(
    url: str,
    *,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> dict[str, Any]:
    request_headers = {"Accept": "application/json", **(headers or {})}
    body = None
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        request_headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        url,
        data=body,
        headers=request_headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        detail = ""
        try:
            parsed = json.loads(error.read().decode("utf-8", errors="replace"))
            detail = parsed.get("error") or parsed.get("message") or parsed.get("code") or ""
        except (ValueError, AttributeError):
            detail = ""
        suffix = f": {str(detail)[:200]}" if detail else ""
        raise PlanningOpsError(f"AgentX HTTP {error.code}{suffix}") from error
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
        raise PlanningOpsError(f"AgentX request failed: {str(error)[:200]}") from error
    if not isinstance(result, dict):
        raise PlanningOpsError("AgentX returned invalid JSON")
    return result


def reconcile(base_url: str, *, timeout: int, dry_run: bool, force: bool) -> str:
    token = resolve_token()
    body = http_json(
        f"{base_url.rstrip('/')}/api/planning/automation/reconcile",
        method="POST",
        payload={"dryRun": dry_run, "force": force},
        headers={"x-agentx-mcp-token": token},
        timeout=timeout,
    )
    data = unwrap(body)
    totals = data.get("totals") or {}
    failed = int(totals.get("failed") or 0)
    if failed:
        raise PlanningOpsError(f"Planning reconcile degraded: {failed} metric refresh(es) failed")
    mode = "dry-run" if dry_run else "apply"
    return (
        f"Planning reconcile OK: mode={mode}, "
        f"scanned={int(totals.get('scanned') or 0)}, "
        f"updated={int(totals.get('updated') or 0)}, "
        f"skipped={int(totals.get('skipped') or 0)}"
    )


def number(value: Any, default: float = 0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def format_benchmark_evidence(benchmark: dict[str, Any]) -> str:
    """Render benchmark evidence without turning coverage or latency into quality."""
    leaderboard = benchmark.get("leaderboard") or benchmark.get("top") or []
    qualified = [
        row for row in leaderboard
        if isinstance(row, dict)
        and row.get("fullScopeEligible") is True
        and str(row.get("evidenceStatus") or "").lower()
        in {"full_scope", "qualified", "trusted"}
    ]
    if qualified:
        top = qualified[0]
        score = top.get("generalistScore")
        suffix = f", score {number(score):.2f}" if score is not None else ""
        return (
            "Benchmark quality: qualified leader "
            f"{top.get('model') or top.get('name') or 'unknown'}{suffix}"
        )

    total_tests = int(number(benchmark.get("total_tests") or benchmark.get("totalTests")))
    if leaderboard and isinstance(leaderboard[0], dict):
        candidate = leaderboard[0]
        evidence = str(candidate.get("evidenceStatus") or "").strip()
        if evidence:
            tests = int(number(candidate.get("totalTests") or candidate.get("tests")))
            detail = f"{evidence}, {tests} tests" if tests else evidence
            return (
                "Benchmark quality: no qualified winner; leading candidate "
                f"{candidate.get('model') or candidate.get('name') or 'unknown'} "
                f"is {detail}"
            )

    coverage = f"; {total_tests} historical rows" if total_tests else ""
    return (
        "Benchmark quality: no qualified winner in this report"
        f"{coverage}; latency inventory is not a quality ranking"
    )


def format_budget_evidence(budget: dict[str, Any] | None) -> list[str]:
    if not budget:
        return []
    lines: list[str] = []
    health = str(budget.get("budget_health") or "unknown")
    ratio = number(budget.get("usage_ratio"))
    lines.append(f"Local token budget: {health}, {ratio:.2f}x daily limit")
    cloud_observability = str(budget.get("cloud_spend_observability") or "unknown")
    if cloud_observability == "none-recorded":
        lines.append("Cloud cost: unobserved; $0 recorded is not proof of zero cloud use")
    else:
        lines.append(
            "Cloud usage: "
            f"{int(number(budget.get('cloud_requests')))} requests, "
            f"{int(number(budget.get('cloud_tokens')))} tokens "
            f"[{cloud_observability}]"
        )
    return lines


def format_daily_digest(
    data: dict[str, Any],
    budget: dict[str, Any] | None = None,
) -> str:
    analytics = data.get("analytics") or {}
    performance = data.get("performance") or {}
    benchmark = data.get("benchmark") or {}
    rag = data.get("rag") or {}
    error_rate = number(performance.get("error_rate"))
    status = "RED" if error_rate > 0.05 else "GREEN"
    lines = [
        f"{status} Daily digest: {int(number(analytics.get('messages')))} messages, "
        f"{error_rate:.2%} inference errors",
        (
            "Performance: "
            f"{int(number(performance.get('requests')))} requests, "
            f"{number(performance.get('avg_latency_ms') or performance.get('avg_latency')):.0f}ms avg"
        ),
        format_benchmark_evidence(benchmark),
        *format_budget_evidence(budget),
    ]
    document_count = rag.get("documents") or rag.get("document_count") or rag.get("documentCount")
    rag_status = rag.get("status") or ("ok" if document_count is not None else "unknown")
    lines.append(f"RAG: {document_count if document_count is not None else 'unknown'} documents [{rag_status}]")
    output = "\n".join(lines)
    if len(output) > MAX_OUTPUT_CHARS:
        output = output[: MAX_OUTPUT_CHARS - 16].rstrip() + "\n...[truncated]"
    return output


def format_weekly_review(
    data: dict[str, Any],
    budget: dict[str, Any] | None = None,
) -> str:
    benchmark = data.get("benchmark") or {}
    costs = data.get("costs") or data.get("analytics") or {}
    profiler = data.get("profiler") or {}
    planning = data.get("planning") or {}
    lines: list[str] = []

    lines.append(format_benchmark_evidence(benchmark))

    total = (
        costs.get("this_period_usd")
        or costs.get("week_total_usd")
        or costs.get("cost_usd")
        or costs.get("total_usd")
        or 0
    )
    messages = costs.get("messages") or costs.get("message_count") or 0
    lines.append(f"Recorded costs: ${number(total):.4f} this week across {int(number(messages))} messages")
    lines.extend(format_budget_evidence(budget))

    healthy = profiler.get("hosts_healthy")
    if healthy is None:
        healthy = profiler.get("healthy_hosts", profiler.get("healthy"))
    total_hosts = profiler.get("total_hosts")
    if total_hosts is None:
        total_hosts = profiler.get("hosts_total", profiler.get("total"))
    if healthy is not None:
        suffix = f"/{int(number(total_hosts))}" if total_hosts is not None else ""
        lines.append(f"Profiler: {int(number(healthy))}{suffix} hosts healthy")
    elif profiler.get("status") == "unreachable":
        lines.append("Profiler: unreachable")

    recommendations = benchmark.get("recommendations") or data.get("recommendations") or []
    if recommendations:
        rendered = []
        for item in recommendations[:3]:
            if isinstance(item, dict):
                rendered.append(str(
                    item.get("model")
                    or item.get("title")
                    or item.get("recommendation")
                    or item
                )[:80])
            else:
                rendered.append(str(item)[:80])
        lines.append("Recommendations: " + "; ".join(rendered))

    pulse = planning.get("pulse") or {}
    if planning.get("status") == "unreachable":
        lines.append("Planning: unavailable")
    else:
        lines.append(
            "Planning: "
            f"{int(number(pulse.get('active')))} active, "
            f"{int(number(pulse.get('blocked')))} blocked, "
            f"{int(number(pulse.get('atRisk')))} at risk, "
            f"{int(number(pulse.get('evidenceAdded')))} evidence added"
        )

        metrics = planning.get("metrics") or []
        if metrics:
            rendered = []
            for metric in metrics[:3]:
                if not isinstance(metric, dict):
                    continue
                rendered.append(
                    f"{metric.get('title', 'metric')}: {metric.get('value', 'n/a')} "
                    f"[{metric.get('status', 'unknown')}]"
                )
            if rendered:
                lines.append("Metrics: " + "; ".join(rendered))

        risks = planning.get("risks") or []
        if risks:
            rendered = [
                f"{risk.get('title', 'risk')} [{risk.get('level') or risk.get('status') or 'risk'}]"
                for risk in risks[:3]
                if isinstance(risk, dict)
            ]
            if rendered:
                lines.append("Risks: " + "; ".join(rendered))

        wins = planning.get("wins") or []
        if wins:
            rendered = [
                str(win.get("label") or win.get("item", {}).get("title") or "proof")[:100]
                for win in wins[:3]
                if isinstance(win, dict)
            ]
            if rendered:
                lines.append("Proof/wins: " + "; ".join(rendered))

        proposed = [
            decision for decision in (planning.get("decisions") or [])
            if isinstance(decision, dict) and decision.get("status") == "proposed"
        ]
        if proposed:
            lines.append(
                "Decisions needed: "
                + "; ".join(str(decision.get("title") or "untitled")[:100] for decision in proposed[:3])
            )

        actions = planning.get("nextActions") or []
        rendered = [
            str(action.get("label") or "")[:120]
            for action in actions[:3]
            if isinstance(action, dict) and action.get("label")
        ]
        if rendered:
            lines.append("Next: " + "; ".join(rendered))

    output = "\n".join(lines)
    if len(output) > MAX_OUTPUT_CHARS:
        output = output[: MAX_OUTPUT_CHARS - 16].rstrip() + "\n...[truncated]"
    return output


def weekly_review(base_url: str, *, timeout: int) -> str:
    headers = operator_headers()
    body = http_json(
        f"{base_url.rstrip('/')}/api/reports/weekly-review",
        headers=headers,
        timeout=timeout,
    )
    budget = http_json(
        f"{base_url.rstrip('/')}/api/budget/status",
        headers=headers,
        timeout=timeout,
    )
    return format_weekly_review(unwrap(body), unwrap(budget))


def daily_digest(base_url: str, *, timeout: int) -> str:
    headers = operator_headers()
    body = http_json(
        f"{base_url.rstrip('/')}/api/reports/daily-digest",
        headers=headers,
        timeout=timeout,
    )
    budget = http_json(
        f"{base_url.rstrip('/')}/api/budget/status",
        headers=headers,
        timeout=timeout,
    )
    return format_daily_digest(unwrap(body), unwrap(budget))


def default_base_url() -> str:
    for name in ("AGENTX_CORE_URL", "AGENTX_BASE_URL"):
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return DEFAULT_BASE_URL


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base-url",
        default=default_base_url(),
        help=f"AgentX Core base URL (default: {DEFAULT_BASE_URL})",
    )
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    subparsers = parser.add_subparsers(dest="command", required=True)
    reconcile_parser = subparsers.add_parser("reconcile", help="Refresh due Planning metrics")
    reconcile_parser.add_argument("--dry-run", action="store_true")
    reconcile_parser.add_argument("--force", action="store_true")
    subparsers.add_parser("weekly-review", help="Format the AgentX weekly review for Telegram")
    subparsers.add_parser("daily-digest", help="Format the AgentX daily digest for Telegram")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "reconcile":
            output = reconcile(
                args.base_url,
                timeout=args.timeout,
                dry_run=args.dry_run,
                force=args.force,
            )
        elif args.command == "weekly-review":
            output = weekly_review(args.base_url, timeout=args.timeout)
        else:
            output = daily_digest(args.base_url, timeout=args.timeout)
        print(output)
        return 0
    except PlanningOpsError as error:
        print(f"Planning ops failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
