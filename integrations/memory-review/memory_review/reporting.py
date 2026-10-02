"""Human-readable run reports and briefing digests.

Structured truth lives in Core/Mongo; these renderers are derived views. Each
render writes a versioned snapshot plus a derived latest-report.md pointer.
Reports carry candidate numbers, policy receipts, and never raw transcripts.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

NO_SEMANTIC_CHANGES_LINE = (
    "This scheduled run made no semantic memory, skill, task, config, or "
    "documentation changes. Safe dispositions were shadowed or no candidate "
    "qualified; only listed exceptions may require human review."
)


def _semantic_change_line(run: dict) -> str:
    applied = [
        candidate for candidate in (run.get("candidates") or [])
        if candidate.get("status") in ("applying", "applied", "apply_failed")
    ]
    if not applied:
        return NO_SEMANTIC_CHANGES_LINE
    automated = [candidate for candidate in applied if (candidate.get("apply") or {}).get("automated")]
    return (
        f"Core applied {len(automated)} candidate(s) under the bounded standing policy; "
        "any remaining entries are separately authorized operator apply activity. Inspect each "
        "receipt and rollback reference below."
    )


def _fmt_counts(counts: dict) -> str:
    if not counts:
        return "none"
    return ", ".join(f"{key}={value}" for key, value in sorted(counts.items()))


def render_report(run: dict) -> str:
    lines: list[str] = []
    window = run.get("window") or {}
    model = run.get("model") or {}
    lines.append("# Ecosystem Memory Review run report")
    lines.append("")
    lines.append(f"- run: `{run.get('runId')}`  mode: **{run.get('mode')}**  status: **{run.get('status')}**")
    lines.append(f"- window: {window.get('from')} -> {window.get('to')} ({window.get('timezone')})")
    lines.append(f"- collector: {run.get('collectorVersion')}  prompt: {run.get('promptVersion')}")
    lines.append(f"- model: {model.get('provider')}/{model.get('model')} @ temp {model.get('temperature')}")
    lines.append("")
    lines.append(f"> {_semantic_change_line(run)}")
    lines.append("")

    lines.append("## Collectors")
    lines.append("")
    collectors = run.get("collectors") or []
    if not collectors:
        lines.append("- (none reported)")
    for col in collectors:
        lines.append(
            f"- **{col.get('runtime')}** on {col.get('host')}"
            + (f" ({col.get('agentOrProfile')})" if col.get("agentOrProfile") else "")
            + f": files={col.get('sourceFilesSeen', 0)} events={col.get('sourceEventsSeen', 0)}"
            + f" eligible={col.get('eligibleObservations', 0)} rejected={col.get('rejectedObservations', 0)}"
        )
        lines.append(f"  - watermark: `{col.get('watermarkBefore')}` -> `{col.get('watermarkAfter')}`")
        lines.append(f"  - rejections: {_fmt_counts(col.get('rejectionCounts') or {})}")
        for err in col.get("errors") or []:
            lines.append(f"  - error: {err}")
        for drift in col.get("drift") or []:
            lines.append(f"  - drift: {drift}")
    lines.append("")

    candidates = run.get("candidates") or []
    lines.append(f"## Candidates ({len(candidates)})")
    lines.append("")
    if not candidates:
        lines.append("- None proposed." + (
            " (No eligible observations - the model was not called.)"
            if (run.get("summary") or {}).get("noEligibleObservations")
            else ""
        ))
    for index, cand in enumerate(candidates, start=1):
        target = cand.get("target") or {}
        risk = cand.get("risk") or {}
        flags = [k for k in ("secret", "promptInjection") if risk.get(k)]
        for level_key in ("privacy", "governance", "staleness"):
            if risk.get(level_key) not in (None, "none"):
                flags.append(f"{level_key}:{risk[level_key]}")
        lines.append(
            f"{index}. `[{cand.get('candidateId', '')[:10]}]` **{cand.get('type')}** -> "
            f"{target.get('kind')}"
            + (f" ({target.get('runtime')})" if target.get("runtime") else "")
            + f" — status **{cand.get('status')}**"
        )
        lines.append(f"   - {cand.get('statement')}")
        automation = cand.get("automation") or {}
        lines.append(
            f"   - policy: {automation.get('disposition', 'review')} "
            f"({automation.get('reason', 'legacy/manual')}); scope={cand.get('scope', 'project')} "
            f"sensitivity={cand.get('sensitivity', 'normal')} impact={cand.get('impact', 'context_only')} "
            f"stability={cand.get('stability', 'durable')}"
        )
        if cand.get("rationale"):
            lines.append(f"   - why durable: {cand.get('rationale')}")
        rec = cand.get("recurrence") or {}
        lines.append(
            f"   - evidence: {len(cand.get('evidence') or [])} ref(s), "
            f"recurrence {rec.get('observationCount', 0)} obs / "
            f"{rec.get('independentSessions', 0)} sessions / "
            f"{rec.get('independentRuntimes', 0)} runtimes, "
            f"confidence {cand.get('confidence')}"
        )
        if cand.get("conflicts"):
            for conflict in cand["conflicts"]:
                lines.append(f"   - CONFLICT [{conflict.get('authority', '?')}]: {conflict.get('summary')}")
        if flags:
            lines.append(f"   - risk flags: {', '.join(flags)}")
        apply_info = cand.get("apply") or {}
        if apply_info.get("attemptedAt"):
            lines.append(
                f"   - apply: {apply_info.get('result')} via {apply_info.get('adapter')} at {apply_info.get('attemptedAt')}"
            )
    lines.append("")

    lines.append("## Human exceptions")
    lines.append("")
    lines.append(
        "Review only proposed/deferred/apply-failed exceptions in AgentX (/memory-review) or via "
        "`POST /api/memory-review/runs/<runId>/candidates/<candidateId>/review`. "
        "There is no bulk approval."
    )
    failures = [a for a in (run.get("audit") or []) if a.get("level") == "error"]
    if failures:
        lines.append("")
        lines.append("## Failures")
        lines.append("")
        for item in failures[-10:]:
            lines.append(f"- {item.get('at')}: {item.get('event')} — {item.get('detail')}")
        lines.append("")
        lines.append("Retry guidance: the run is retryable; re-running the same window is idempotent.")
    return "\n".join(lines) + "\n"


def write_report(state_dir: Path, run: dict) -> Path:
    reports_dir = Path(state_dir) / "reports"
    reports_dir.mkdir(parents=True, exist_ok=True)
    run_id = str(run.get("runId") or "unknown-run").replace("/", "_")
    content = render_report(run)
    revision = str(run.get("updatedAt") or run.get("createdAt") or "snapshot")
    revision = "".join(ch for ch in revision if ch.isalnum())[:24] or "snapshot"
    target = reports_dir / f"{run_id}-{revision}.md"
    if not target.exists():
        target.write_text(content, encoding="utf-8")
    latest = reports_dir / "latest-report.md"
    latest.write_text(
        f"<!-- derived pointer; authoritative snapshot: {target.name}; structured truth: AgentX -->\n" + content,
        encoding="utf-8",
    )
    return target


def render_digest(run: dict | None) -> str:
    """Compact read-only text for the OpenClaw briefing / Telegram surface."""
    if not run:
        return "Memory review: no runs recorded yet."
    candidates = run.get("candidates") or []
    pending = [c for c in candidates if c.get("status") in ("proposed", "deferred", "apply_failed")]
    automatic = [c for c in candidates if c.get("status") == "applied" and (c.get("apply") or {}).get("automated")]
    soft = [c for c in automatic if (c.get("target") or {}).get("kind") == "soft_memory"]
    stamp = run.get("completedAt") or run.get("createdAt") or datetime.now(timezone.utc).isoformat()
    head = (
        f"Memory review {run.get('runId')} ({run.get('status')}, {stamp[:16]}): "
        f"{len(automatic)} auto-applied ({len(soft)} soft), {len(pending)} exception(s) awaiting review."
    )
    if not pending:
        return head + " Nothing pending."
    body_lines = [head, "Human exceptions (review individually in AgentX /memory-review):"]
    for index, cand in enumerate(candidates, start=1):
        if cand.get("status") not in ("proposed", "deferred", "apply_failed"):
            continue
        target = (cand.get("target") or {}).get("kind")
        body_lines.append(f"  {index}. [{cand.get('type')} -> {target}] {str(cand.get('statement'))[:140]}")
    body_lines.append("Safe reversible updates follow the standing policy; private, conflicting, and high-impact items do not.")
    return "\n".join(body_lines)
