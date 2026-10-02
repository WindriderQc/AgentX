"""Codex collector — reads rollout session JSONL for allowed project cwds.

Sources (read-only): <codex_home>/sessions/YYYY/MM/DD/rollout-*.jsonl
Archived sessions are excluded by default (historical backfill is a separate
explicit mode). Codex native memory stores (memories_1.sqlite, memories/) are
NEVER opened for writing and are not treated as stable public APIs.

Eligible: response_item events whose payload is a user-role message with
input_text parts, from sessions whose session_meta cwd matches the project
allowlist. Codex injects harness context (<environment_context>,
<user_instructions>, AGENTS.md text, turn context) as user-role messages —
those are stripped structurally and rejected as harness_context.
"""

from __future__ import annotations

import fnmatch
from pathlib import Path

from .. import schema
from ..watermarks import WatermarkStore
from . import (
    CollectorResult,
    build_observation,
    classify_memory_intent,
    discover_files,
    host_name,
    read_new_jsonl,
    reject,
)

# cwd patterns (fnmatch, case-insensitive on windows-style paths) that mark a
# session as belonging to the reviewed project scope.
DEFAULT_CWD_PATTERNS = ("*/codes/AgentX",)

# session_meta.source / originator values that mark non-interactive sessions.
AUTOMATION_SOURCE_MARKERS = ("exec", "cron", "ci", "headless", "scheduled")


def default_root() -> Path:
    return Path.home() / ".codex" / "sessions"


def _norm(path_text: str) -> str:
    return str(path_text or "").replace("\\", "/").lower()


def _cwd_allowed(cwd: str, patterns: tuple[str, ...]) -> bool:
    normalized = _norm(cwd)
    return any(fnmatch.fnmatch(normalized, _norm(pat)) for pat in patterns)


def collect(
    *,
    root: Path | None = None,
    store: WatermarkStore,
    cwd_patterns: tuple[str, ...] = DEFAULT_CWD_PATTERNS,
    lookback_days: int = schema.DEFAULT_LOOKBACK_DAYS,
    max_files: int = schema.MAX_FILES_PER_COLLECTOR,
) -> CollectorResult:
    base = Path(root) if root else default_root()
    result = CollectorResult(runtime="codex", host=host_name())
    result.watermarkBefore = store.token()

    if not base.exists():
        result.errors.append(f"sessions root missing: {base}")
        return result

    files = discover_files(
        base,
        ("*/*/*/rollout-*.jsonl", "rollout-*.jsonl"),
        lookback_days=lookback_days,
        max_files=max_files,
    )
    result.sourceFilesSeen = len(files)

    for path in files:
        source_key = str(path.relative_to(base)).replace("\\", "/")
        session_allowed: bool | None = None
        session_kind_reject: str | None = None
        prior = store.get(source_key) or {}
        prior_meta = prior.get("meta") if isinstance(prior.get("meta"), dict) else {}
        if "cwdAllowed" in prior_meta:
            session_allowed = bool(prior_meta.get("cwdAllowed"))
            session_kind_reject = prior_meta.get("kindReject") or None

        session_id = path.stem
        for event in read_new_jsonl(path, store, result, source_key=source_key):
            payload = event.get("payload")
            if not isinstance(payload, dict):
                reject(result, "malformed")
                continue

            if event.get("type") == "session_meta":
                inner = payload.get("payload") if isinstance(payload.get("payload"), dict) else payload
                session_id = str(inner.get("session_id") or session_id)
                cwd = str(inner.get("cwd") or "")
                session_allowed = _cwd_allowed(cwd, cwd_patterns)
                source_markers = f"{inner.get('source') or ''} {inner.get('originator') or ''}".lower()
                if any(marker in source_markers for marker in AUTOMATION_SOURCE_MARKERS):
                    session_kind_reject = "cron_or_automation"
                continue

            if event.get("type") != "response_item" or payload.get("type") != "message":
                # reasoning / tool calls / token counts / event_msg stream
                ptype = str(payload.get("type") or "")
                if ptype in ("function_call_output", "custom_tool_call_output", "local_shell_call_output"):
                    reject(result, "tool_output")
                continue

            role = payload.get("role")
            if role == "assistant":
                reject(result, "assistant_claim")
                continue
            if role in ("developer", "system"):
                reject(result, "system")
                continue
            if role != "user":
                reject(result, "unknown_kind")
                continue
            if session_kind_reject:
                reject(result, session_kind_reject)
                continue
            if session_allowed is False:
                reject(result, "project_not_allowed")
                continue
            if session_allowed is None:
                # No session_meta seen (and none cached): classify conservatively.
                reject(result, "unknown_kind")
                continue

            parts = []
            content = payload.get("content")
            if isinstance(content, list):
                for item in content:
                    if isinstance(item, dict) and item.get("type") == "input_text":
                        parts.append(str(item.get("text") or ""))
            text = "\n".join(p for p in parts if p).strip()
            build_observation(
                result,
                text=text,
                trust=classify_memory_intent(text),
                session_id=session_id,
                event_id=str(payload.get("id") or ""),
                observed_at=str(event.get("timestamp") or ""),
                source_ref=source_key,
            )

        staged = result.stagedWatermarks.get(source_key)
        if staged is not None:
            meta = dict(staged.get("meta") or {})
            if session_allowed is not None:
                meta["cwdAllowed"] = bool(session_allowed)
            if session_kind_reject:
                meta["kindReject"] = session_kind_reject
            staged["meta"] = meta
            staged["sessionId"] = session_id

    result.watermarkAfter = f"staged:{len(result.stagedWatermarks)}"
    return result
