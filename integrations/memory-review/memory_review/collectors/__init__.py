"""Shared machinery for the runtime collectors.

Every collector is read-only, incremental (watermark-driven), bounded, and
funnels each raw message through one policy pipeline (`build_observation`) so
trust classification, stripping, secret rejection, and truncation cannot drift
between runtimes.
"""

from __future__ import annotations

import json
import os
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from .. import schema, sanitizer
from ..watermarks import WatermarkStore, head_signature, head_window


@dataclass
class CollectorResult:
    runtime: str
    host: str
    agentOrProfile: str = ""
    project: str = ""
    observations: list = field(default_factory=list)
    rejectionCounts: Counter = field(default_factory=Counter)
    sourceFilesSeen: int = 0
    sourceEventsSeen: int = 0
    errors: list = field(default_factory=list)
    drift: list = field(default_factory=list)
    localDedupContext: list = field(default_factory=list)
    stagedWatermarks: dict = field(default_factory=dict)
    watermarkBefore: str = ""
    watermarkAfter: str = ""

    def collector_payload(self) -> dict:
        return {
            "runtime": schema.agentx_runtime(self.runtime),
            "host": self.host,
            "agentOrProfile": self.agentOrProfile or None,
            "project": self.project or None,
            "watermarkBefore": self.watermarkBefore,
            "watermarkAfter": self.watermarkAfter,
            "sourceFilesSeen": self.sourceFilesSeen,
            "sourceEventsSeen": self.sourceEventsSeen,
            "eligibleObservations": len(self.observations),
            "rejectedObservations": int(sum(self.rejectionCounts.values())),
            "rejectionCounts": dict(self.rejectionCounts),
            "errors": [str(e)[:300] for e in self.errors][:20],
            "drift": [str(d)[:300] for d in self.drift][:10],
            # Runtime-local memory text never crosses the host boundary. These
            # opaque hashes are audit/dedup hints only; they are not evidence
            # and are never sent to the synthesis model.
            "localDedupContext": [
                "sha256:" + schema.content_hash(str(x))
                for x in self.localDedupContext[: schema.MAX_DEDUP_CONTEXT_LINES]
            ],
        }


def reject(result: CollectorResult, reason: str) -> None:
    if reason not in schema.REJECTION_REASONS:
        reason = "unknown_kind"
    result.rejectionCounts[reason] += 1


def build_observation(
    result: CollectorResult,
    *,
    text: str,
    trust: str,
    session_id: str,
    event_id: str,
    observed_at: str,
    source_ref: str,
) -> None:
    """One pipeline for every raw message. Appends an eligible observation or
    counts a rejection — nothing else escapes a collector."""
    raw = str(text or "")
    if not raw.strip():
        reject(result, "empty")
        return

    value, had_invisible = sanitizer.strip_invisible(raw)
    value = sanitizer.strip_harness_context(value)
    if not value:
        reject(result, "harness_context")
        return
    if sanitizer.is_previous_proposal(value):
        reject(result, "previous_proposal")
        return
    if sanitizer.contains_secret(value):
        # Reject outright; never submit (even redacted). Counts only.
        reject(result, "secret_like")
        return
    if sanitizer.looks_pasted(value):
        # Bulk pasted/quoted content must not inherit owner trust. It is
        # counted, not centralized: ineligible classes never leave the host.
        # (Checked before the injection scan: an opaque bulk paste is a
        # provenance problem first, whatever else it contains.)
        reject(result, "pasted_untrusted")
        return
    if sanitizer.find_injection(value):
        reject(result, "injection_suspect")
        return
    if sanitizer.has_control_chars(value):
        reject(result, "invisible_unicode")
        return

    taints: list[str] = []
    if had_invisible:
        taints.append("invisible_unicode_stripped")
    effective_trust = trust

    if effective_trust in ("explicit_owner_instruction", "unknown"):
        # A role=user envelope proves neither ownership nor durability. V1
        # centralizes only an explicit memory request (or separately verified
        # runtime/git evidence), never every ordinary user utterance.
        reject(result, "not_explicit_memory_request")
        return
    if effective_trust == "explicit_memory_request":
        claim = explicit_memory_claim(value)
        if not claim:
            reject(result, "not_explicit_memory_request")
            return
        value = claim

    if effective_trust not in schema.TRUST_ELIGIBLE:
        # Ineligible classes are counted by their reason at the call site;
        # reaching here with one is a collector bug.
        reject(result, "unknown_kind")
        return

    if len(result.observations) >= schema.MAX_OBSERVATIONS_PER_COLLECTOR:
        reject(result, "oversize")
        return

    result.observations.append(
        schema.Observation(
            runtime=result.runtime,
            host=result.host,
            agentOrProfile=result.agentOrProfile,
            project=result.project,
            text=value,
            trust=effective_trust,
            taints=taints,
            sessionId=str(session_id or ""),
            eventId=str(event_id or ""),
            observedAt=str(observed_at or ""),
            sourceRef=str(source_ref or ""),
        )
    )


# An explicit memory request often arrives after a short lead-in ("ok parfait,
# retiens que ..."), or on a later line of a longer message. The original
# patterns were anchored to the very start of the whole message, so those turns
# were dropped: across 34 production runs, 1008 owner messages were rejected as
# `not_explicit_memory_request` while only one observation ever became eligible.
#
# Widening stays inside the same invariant: the trigger phrase must still be an
# explicit, unambiguous request, and only the claim that follows it is kept --
# never the surrounding turn. An ordinary sentence that merely mentions memory
# ("I don't remember that file") still does not match, because the lead-in must
# end at a comma or colon and the trigger must begin the clause after it.
_LEAD_IN = r"(?:[^,:\n]{0,60}?[,:]\s+)?"
_APOS = r"['’]?"

_MEMORY_REQUEST_TRIGGERS = (
    r"/remember(?:\s+this)?",
    r"(?:please\s+)?remember\s+(?:this|that)",
    r"please\s+remember",
    r"keep\s+in\s+mind\s+that",
    r"don" + _APOS + r"t\s+forget\s+that",
    r"for\s+the\s+record",
    r"make\s+a\s+note\s+that",
    r"note\s+for\s+later",
    r"(?:souviens-toi|retiens)(?:\s+que)?",
    r"rappelle-toi\s+que",
    r"n" + _APOS + r"oublie\s+pas\s+que",
    r"[aà]\s+retenir",
    r"pour\s+m[ée]moire",
    r"note\s+pour\s+plus\s+tard",
)

_MEMORY_REQUEST_PATTERNS = tuple(
    re.compile(rf"^{_LEAD_IN}{trigger}\s*[:,-]?\s*(?P<claim>.*?)\s*$", re.IGNORECASE)
    for trigger in _MEMORY_REQUEST_TRIGGERS
)


def explicit_memory_claim(text: str) -> str | None:
    """Return only the requested durable claim, never the surrounding turn."""
    value = re.sub(r"^(?:\s*#{1,6}[^\n]*\n){1,3}", "", str(text or ""))
    lines = value.split("\n")
    for index, line in enumerate(lines):
        for pattern in _MEMORY_REQUEST_PATTERNS:
            match = pattern.match(line)
            if not match:
                continue
            claim = (match.group("claim") or "").strip()
            if not claim:
                # "remember this:" introducing a block on the following lines.
                claim = "\n".join(lines[index + 1:]).strip()
            if claim:
                return claim
    return None


def classify_memory_intent(text: str) -> str:
    """Classify an already authenticated owner turn.

    Call sites first prove an external local user, allowed project/session, and
    non-automation provenance. The sanitizer then rejects paste/injection/
    secret shapes. Explicit memory intent remains stronger evidence, while an
    ordinary declaration becomes observed owner evidence for model-assisted
    extraction and confidence-tiered policy — not an automatic hard fact.
    """
    return "explicit_memory_request" if explicit_memory_claim(text) else "authenticated_owner_statement"

def discover_files(
    root: Path,
    patterns: tuple[str, ...],
    *,
    exclude_substrings: tuple[str, ...] = (),
    lookback_days: int = schema.DEFAULT_LOOKBACK_DAYS,
    max_files: int = schema.MAX_FILES_PER_COLLECTOR,
    now: float | None = None,
) -> list[Path]:
    """Bounded newest-first discovery. A multi-gigabyte history is never
    scanned by default: only files touched inside the lookback window count;
    historical backfill is an explicit separate command."""
    if not root.exists():
        return []
    candidates: list[Path] = []
    for pattern in patterns:
        try:
            candidates.extend(root.glob(pattern))
        except OSError:
            continue
    horizon = (now or datetime.now(timezone.utc).timestamp()) - lookback_days * 86400
    picked = []
    for path in candidates:
        name = path.name
        if any(sub in name for sub in exclude_substrings):
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        if not path.is_file() or stat.st_mtime < horizon:
            continue
        picked.append((stat.st_mtime, path))
    picked.sort(key=lambda pair: pair[0], reverse=True)
    return [path for _, path in picked[:max_files]]


def read_new_jsonl(
    path: Path,
    store: WatermarkStore,
    result: CollectorResult,
    *,
    source_key: str | None = None,
    max_bytes: int = schema.MAX_NEW_BYTES_PER_FILE,
    max_events: int = schema.MAX_EVENTS_PER_FILE,
):
    """Yield parsed events appearing after the recorded watermark, then stage
    (but do not persist) the new position on `result.stagedWatermarks`.

    Handles rotation (head-signature change), truncation/shrink (restart at 0),
    partial trailing lines (position only advances past complete lines), and
    malformed JSON lines (counted, skipped).
    """
    key = source_key or path.name
    try:
        stat = path.stat()
    except OSError as exc:
        result.errors.append(f"{path.name}: stat failed ({exc})")
        return

    entry = store.get(key) or {}
    offset = int(entry.get("offset") or 0)
    prior_sig = entry.get("sig")
    prior_sig_len = int(entry.get("sigLen") or 0)
    rotated = bool(
        prior_sig
        and prior_sig_len
        and head_signature(path, prior_sig_len) != prior_sig
    )
    if not entry:
        offset = 0
    elif stat.st_size < int(entry.get("size") or 0) or rotated:
        # rotated or reset: rescan from the top (server dedup keeps it idempotent)
        offset = 0
    elif offset >= stat.st_size and stat.st_size == int(entry.get("size") or 0) and stat.st_mtime_ns == int(
        entry.get("mtimeNs") or 0
    ):
        # unchanged — nothing new, keep the entry as-is
        result.stagedWatermarks[key] = dict(entry)
        return

    consumed = offset
    events_read = 0
    meta = entry.get("meta") if isinstance(entry.get("meta"), dict) else {}
    discarding_oversize_line = bool(meta.get("discardingOversizeLine"))
    try:
        with path.open("rb") as handle:
            handle.seek(offset)
            budget = max_bytes
            while events_read < max_events and budget > 0:
                line = handle.readline(budget)
                if not line:
                    break
                if discarding_oversize_line:
                    consumed += len(line)
                    budget -= len(line)
                    if line.endswith(b"\n"):
                        discarding_oversize_line = False
                    continue
                if not line.endswith(b"\n"):
                    if len(line) >= budget:
                        # A single embedded event exceeds the per-run byte
                        # budget. Advance through it in bounded chunks while
                        # remembering that subsequent chunks are discard-only.
                        consumed += len(line)
                        budget -= len(line)
                        discarding_oversize_line = True
                        reject(result, "oversize")
                    break  # ordinary partial trailing line: re-read next run
                budget -= len(line)
                consumed += len(line)
                text = line.decode("utf-8", errors="replace").strip()
                if not text:
                    continue
                events_read += 1
                result.sourceEventsSeen += 1
                try:
                    event = json.loads(text)
                except json.JSONDecodeError:
                    reject(result, "malformed")
                    continue
                if isinstance(event, dict):
                    yield event
                else:
                    reject(result, "malformed")
    except OSError as exc:
        result.errors.append(f"{path.name}: read failed ({exc})")
        return

    meta = dict(meta)
    if discarding_oversize_line:
        meta["discardingOversizeLine"] = True
    else:
        meta.pop("discardingOversizeLine", None)
    sig_len = head_window(stat.st_size)
    result.stagedWatermarks[key] = {
        "size": stat.st_size,
        "mtimeNs": stat.st_mtime_ns,
        "offset": consumed,
        "sig": head_signature(path, sig_len),
        "sigLen": sig_len,
        "sessionId": entry.get("sessionId") or path.stem,
        "meta": meta,
    }


def host_name() -> str:
    return os.environ.get("AGENTX_MEMORY_REVIEW_HOST") or os.environ.get(
        "COMPUTERNAME", os.environ.get("HOSTNAME", "unknown-host")
    ).lower()
