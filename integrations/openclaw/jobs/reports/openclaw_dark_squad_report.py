#!/usr/bin/env python3
"""Emit a bounded, deterministic OpenClaw ecosystem supervision report."""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import sys
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import urlsplit

DEFAULT_BASE_URL = "http://127.0.0.1:3180"
DEFAULT_TIMEOUT = 20
MAX_OUTPUT_CHARS = 1600
MISSING = object()


class OpenClawReportError(RuntimeError):
    """Trusted supervision evidence could not be collected."""


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse redirects so the operator header never crosses an origin."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: N803
        return None


def origin(url: str) -> tuple[str, str, int]:
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise OpenClawReportError("AgentX base URL is invalid")
    return parsed.scheme, parsed.hostname.lower(), parsed.port or (443 if parsed.scheme == "https" else 80)


def get_json(base_url: str, route: str, *, timeout: int = DEFAULT_TIMEOUT) -> dict[str, Any]:
    root = base_url.rstrip("/")
    url = f"{root}/{route.lstrip('/')}"
    if origin(url) != origin(root):
        raise OpenClawReportError("AgentX evidence URL is outside the trusted origin")
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json"},
    )
    try:
        with urllib.request.build_opener(NoRedirectHandler()).open(request, timeout=timeout) as response:
            body = json.load(response)
    except urllib.error.HTTPError as error:
        raise OpenClawReportError(f"AgentX evidence returned HTTP {error.code}") from error
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
        raise OpenClawReportError("AgentX evidence is unavailable") from error
    if not isinstance(body, dict):
        raise OpenClawReportError("AgentX returned a non-object response")
    return body


def success_data(body: dict[str, Any], label: str) -> dict[str, Any]:
    if body.get("status") != "success" or not isinstance(body.get("data"), dict):
        raise OpenClawReportError(f"AgentX returned an invalid {label} envelope")
    return body["data"]


def data_or_body(body: dict[str, Any], label: str) -> dict[str, Any]:
    if body.get("status") == "error":
        raise OpenClawReportError(f"AgentX returned failed {label} evidence")
    if "data" in body:
        if not isinstance(body["data"], dict):
            raise OpenClawReportError(f"AgentX returned an invalid {label} envelope")
        return body["data"]
    return body


def number(value: Any, label: str, default: Any = MISSING) -> float:
    if value is None or value == "":
        if default is MISSING:
            raise OpenClawReportError(f"AgentX returned missing {label} evidence")
        return float(default)
    if isinstance(value, bool):
        raise OpenClawReportError(f"AgentX returned invalid {label} evidence")
    try:
        parsed = float(value)
    except (TypeError, ValueError) as error:
        raise OpenClawReportError(f"AgentX returned invalid {label} evidence") from error
    if not math.isfinite(parsed):
        raise OpenClawReportError(f"AgentX returned invalid {label} evidence")
    return parsed


def count(value: Any, label: str) -> int:
    parsed = number(value, label)
    if parsed < 0 or parsed != int(parsed):
        raise OpenClawReportError(f"AgentX returned invalid {label} evidence")
    return int(parsed)


def validate_evidence(
    agent_ops: dict[str, Any],
    openclaw: dict[str, Any],
    budget: dict[str, Any],
    resources: dict[str, float],
) -> None:
    work = agent_ops.get("work")
    counts = work.get("counts") if isinstance(work, dict) else None
    sources = agent_ops.get("sources")
    automations = agent_ops.get("automations")
    if not isinstance(counts, dict) or not isinstance(sources, dict) or not sources or not isinstance(automations, list):
        raise OpenClawReportError("Agent Ops returned an invalid supervision schema")
    for key in ("queued", "in_progress", "review", "blocked"):
        count(counts.get(key), f"work.{key}")
    if any(not isinstance(item, dict) for item in automations):
        raise OpenClawReportError("Agent Ops returned an invalid automation list")
    if any(not isinstance(value, dict) or value.get("status") not in {"ok", "degraded", "error"} for value in sources.values()):
        raise OpenClawReportError("Agent Ops returned invalid source-health evidence")
    if openclaw.get("status") not in {"online", "offline"}:
        raise OpenClawReportError("OpenClaw returned an invalid runtime status")
    gateway = openclaw.get("gateway")
    if not isinstance(gateway, dict) or not isinstance(gateway.get("reachable"), bool):
        raise OpenClawReportError("OpenClaw returned invalid gateway evidence")
    if not str(openclaw.get("runtimeVersion") or "").strip():
        raise OpenClawReportError("OpenClaw returned missing runtime-version evidence")
    count(openclaw.get("sessions"), "openclaw.sessions")
    for key in ("local_requests", "local_tokens", "cloud_requests"):
        count(budget.get(key), f"budget.{key}")
    number(budget.get("usage_ratio"), "budget.usage_ratio")
    if str(budget.get("cloud_health") or "") not in {"green", "yellow", "red", "unknown"}:
        raise OpenClawReportError("AgentX returned invalid budget.cloud_health evidence")
    if not str(budget.get("cloud_spend_observability") or "").strip():
        raise OpenClawReportError("AgentX returned missing budget.cloud_spend_observability evidence")
    for key in ("disk_used_pct", "disk_free_gib", "memory_available_gib"):
        number(resources.get(key), f"host.{key}")


def host_resources() -> dict[str, float]:
    disk = shutil.disk_usage("/")
    memory_available_kib = 0
    try:
        with open("/proc/meminfo", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("MemAvailable:"):
                    memory_available_kib = int(line.split()[1])
                    break
    except (OSError, ValueError, IndexError):
        memory_available_kib = 0
    return {
        "disk_used_pct": ((disk.total - disk.free) / disk.total * 100) if disk.total else 0,
        "disk_free_gib": disk.free / (1024**3),
        "memory_available_gib": memory_available_kib / (1024**2),
    }


def build_report(
    agent_ops: dict[str, Any],
    openclaw: dict[str, Any],
    budget: dict[str, Any],
    resources: dict[str, float],
    host_label: str = "",
) -> str:
    validate_evidence(agent_ops, openclaw, budget, resources)
    work_counts = (agent_ops.get("work") or {}).get("counts") or {}
    queued = count(work_counts.get("queued"), "work.queued")
    active = count(work_counts.get("in_progress"), "work.in_progress")
    review = count(work_counts.get("review"), "work.review")
    blocked = count(work_counts.get("blocked"), "work.blocked")
    automations = [
        item for item in (agent_ops.get("automations") or [])
        if isinstance(item, dict) and item.get("confidence") == "live" and item.get("enabled") is not False
    ]
    automation_errors = [
        item for item in automations
        if item.get("health") == "error" or item.get("lastStatus") == "error"
    ]
    sources = agent_ops.get("sources") or {}
    degraded_sources = [
        name for name, value in sources.items()
        if isinstance(value, dict) and value.get("status") != "ok"
    ]
    openclaw_online = openclaw.get("status") == "online"
    gateway_reachable = (openclaw.get("gateway") or {}).get("reachable") is True
    runtime_version = str(openclaw.get("runtimeVersion") or "unknown")
    sessions = count(openclaw.get("sessions"), "openclaw.sessions")
    local_requests = count(budget.get("local_requests"), "budget.local_requests")
    local_tokens = count(budget.get("local_tokens"), "budget.local_tokens")
    budget_ratio = number(budget.get("usage_ratio"), "budget.usage_ratio")
    cloud_requests = count(budget.get("cloud_requests"), "budget.cloud_requests")
    cloud_health = str(budget.get("cloud_health") or "unknown")
    cloud_observability = str(budget.get("cloud_spend_observability") or "unknown")
    cloud_attribution_missing = cloud_requests > 0 and cloud_observability in {"none-recorded", "unknown"}
    disk_used = number(resources.get("disk_used_pct"), "host.disk_used_pct")
    disk_free = number(resources.get("disk_free_gib"), "host.disk_free_gib")
    memory_free = number(resources.get("memory_available_gib"), "host.memory_available_gib")
    attention = any((
        blocked > 0,
        queued > 0 and active == 0,
        bool(automation_errors),
        bool(degraded_sources),
        not openclaw_online,
        not gateway_reachable,
        cloud_health in {"yellow", "red", "unknown"},
        cloud_attribution_missing,
        disk_used >= 85,
        0 < memory_free < 1,
    ))
    label = " ".join(str(host_label or "").split())
    host_suffix = f" {label}" if label else ""
    lines = [f"Dark Squad — {'ATTENTION' if attention else 'OK'}"]
    lines.append(
        f"• Pipeline — {queued} en attente, {active} en cours, {review} en revue, {blocked} bloqués. "
        + ("Action : arbitrer les blocages avant de relancer la file." if blocked else "Aucun blocage déclaré.")
    )
    lines.append(
        "• Workers — "
        + ("aucun flux actif malgré la file. Action : lancer une seule carte exécutable."
           if queued and not active else f"{active} flux actif(s); conserver la limite d’un flux prioritaire.")
    )
    lines.append(
        f"• Automations — {len(automations) - len(automation_errors)}/{len(automations)} jobs OpenClaw observés sains; "
        f"runtime {runtime_version}, gateway {'joignable' if gateway_reachable else 'indisponible'}, {sessions} sessions."
        + (" Action : ouvrir Agent Ops > Automations." if automation_errors or not openclaw_online or not gateway_reachable else "")
    )
    lines.append(
        f"• Runtime — {len(sources) - len(degraded_sources)}/{len(sources)} sources Agent Ops saines."
        + (f" Dégradées : {', '.join(degraded_sources[:3])}." if degraded_sources else "")
    )
    lines.append(
        f"• LLM — local {local_requests} appels / {local_tokens} jetons à {budget_ratio:.2f}× la référence; "
        f"cloud {cloud_requests} appels, budget {cloud_health}, attribution {cloud_observability}."
        + (" Action : vérifier le budget cloud et l’attribution par appel avant toute escalade."
           if cloud_health in {"yellow", "red", "unknown"} or cloud_attribution_missing else "")
    )
    lines.append(
        f"• Hôte{host_suffix} — disque {disk_used:.0f}% ({disk_free:.1f} Gio libres), mémoire disponible {memory_free:.1f} Gio."
        + (" Action : libérer de l’espace ou de la mémoire."
           if disk_used >= 85 or (0 < memory_free < 1) else "")
    )
    output = "\n".join(lines)
    return output if len(output) <= MAX_OUTPUT_CHARS else output[: MAX_OUTPUT_CHARS - 16].rstrip() + "\n…[tronqué]"


def run(base_url: str = DEFAULT_BASE_URL, host_label: str = "") -> str:
    return build_report(
        success_data(get_json(base_url, "/api/agent-ops"), "Agent Ops"),
        get_json(base_url, "/api/openclaw/status"),
        data_or_body(get_json(base_url, "/api/budget/status"), "budget"),
        host_resources(),
        host_label,
    )


def default_base_url() -> str:
    for name in ("AGENTX_CORE_URL", "AGENTX_BASE_URL"):
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return DEFAULT_BASE_URL


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=default_base_url())
    parser.add_argument(
        "--host-label",
        default=os.environ.get("AGENTX_REPORT_HOST_LABEL", ""),
        help="Short name of the observed host shown on the resource line",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        print(run(args.base_url, args.host_label))
        return 0
    except OpenClawReportError as error:
        print(f"Dark Squad — FAILED: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
