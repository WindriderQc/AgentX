"""Claude Code collector — reads harness session JSONL for allowed projects.

Sources (read-only): <claude_home>/projects/<project>/*.jsonl
Eligible: type=user events with userType=external, isSidechain=false, and
message.role=user text parts. Everything else (assistant turns, tool results,
sidechain/subagent traffic, attachments, harness wrappers, recalled context)
is excluded structurally before the shared sanitation pipeline runs.

The project's private auto-memory (memory/MEMORY.md index) is deduplication
context only — titles travel, bodies never do, and nothing is copied into
AgentX automatically.
"""

from __future__ import annotations

import fnmatch
from pathlib import Path

from .. import schema, sanitizer
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

# Directory-name patterns under <claude_home>/projects. The default targets the
# active checkout's project; the retired OneDrive project is detected for a
# drift finding but never collected.
DEFAULT_PROJECT_PATTERNS = ("*-codes-AgentX",)
LEGACY_PROJECT_PATTERNS = ("*OneDrive*AgentX*",)


def default_root() -> Path:
    return Path.home() / ".claude" / "projects"


def _event_text(event: dict) -> str | None:
    """Extract operator text from a user event; None marks a structural reject
    already counted by the caller."""
    message = event.get("message")
    if not isinstance(message, dict) or message.get("role") != "user":
        return None
    content = message.get("content")
    parts: list[str] = []
    if isinstance(content, str):
        parts.append(content)
    elif isinstance(content, list):
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(str(item.get("text") or ""))
            # tool_result / image / document parts are not operator prose.
    return "\n".join(p for p in parts if p).strip()


def collect(
    *,
    root: Path | None = None,
    store: WatermarkStore,
    project_patterns: tuple[str, ...] = DEFAULT_PROJECT_PATTERNS,
    lookback_days: int = schema.DEFAULT_LOOKBACK_DAYS,
    max_files: int = schema.MAX_FILES_PER_COLLECTOR,
) -> CollectorResult:
    base = Path(root) if root else default_root()
    result = CollectorResult(runtime="claude-code", host=host_name())
    result.watermarkBefore = store.token()

    if not base.exists():
        result.errors.append(f"projects root missing: {base}")
        return result

    projects = []
    for child in sorted(base.iterdir()):
        if not child.is_dir():
            continue
        name = child.name
        if any(fnmatch.fnmatch(name, pat) for pat in project_patterns):
            projects.append(child)
        elif any(fnmatch.fnmatch(name, pat) for pat in LEGACY_PROJECT_PATTERNS):
            if (child / "memory").exists():
                result.drift.append(
                    f"duplicate-project-memory: legacy project tree still present ({name})"
                )

    if not projects:
        result.errors.append("no allowed Claude projects found")
        return result

    per_project_files = max(1, max_files // len(projects))
    for project_dir in projects:
        result.project = project_dir.name
        _collect_project(project_dir, store, result, lookback_days, per_project_files)

    result.watermarkAfter = f"staged:{len(result.stagedWatermarks)}"
    return result


def _collect_project(
    project_dir: Path,
    store: WatermarkStore,
    result: CollectorResult,
    lookback_days: int,
    max_files: int,
) -> None:
    files = discover_files(
        project_dir,
        ("*.jsonl",),
        lookback_days=lookback_days,
        max_files=max_files,
    )
    result.sourceFilesSeen += len(files)

    for path in files:
        source_key = f"{project_dir.name}/{path.name}"
        for event in read_new_jsonl(path, store, result, source_key=source_key):
            etype = event.get("type")
            if etype != "user":
                if etype == "assistant":
                    reject(result, "assistant_claim")
                # attachment / last-prompt / queue-operation / mode etc. are
                # harness bookkeeping, not conversational evidence.
                elif etype in ("attachment", "last-prompt", "queue-operation",
                               "custom-title", "mode", "pr-link", "summary"):
                    reject(result, "harness_context")
                elif etype == "system":
                    reject(result, "system")
                else:
                    reject(result, "unknown_kind")
                continue
            if event.get("isSidechain"):
                reject(result, "subagent")
                continue
            if event.get("userType") != "external":
                reject(result, "cron_or_automation")
                continue
            text = _event_text(event)
            if text is None:
                reject(result, "malformed")
                continue
            build_observation(
                result,
                text=text,
                trust=classify_memory_intent(sanitizer.strip_harness_context(text) or text),
                session_id=str(event.get("sessionId") or path.stem),
                event_id=str(event.get("uuid") or ""),
                observed_at=str(event.get("timestamp") or ""),
                source_ref=source_key,
            )

    _load_dedup_context(project_dir, result)


def _load_dedup_context(project_dir: Path, result: CollectorResult) -> None:
    """Private MEMORY.md index lines (titles + hooks only) as dedup context."""
    memory_index = project_dir / "memory" / "MEMORY.md"
    if not memory_index.exists():
        return
    try:
        lines = memory_index.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if line.startswith("- ") and len(result.localDedupContext) < schema.MAX_DEDUP_CONTEXT_LINES:
            result.localDedupContext.append("claude-memory: " + sanitizer.redact(line))
