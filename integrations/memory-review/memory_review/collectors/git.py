"""Observed accepted-project-event collector.

Every other collector reads a session transcript and must prove that a human
said something. This one reads no transcript at all: its evidence is the
accepted integration history of a repository, which is verifiable after the
fact by sha and cannot be fabricated by an assistant claim inside a chat.

Why this lane exists. Across 34 production runs the session collectors produced
exactly one eligible observation, because the central trust model accepts only
an explicit memory request and the owner states facts declaratively rather than
asking for them to be remembered. `verified_git_or_test_outcome` is already
accepted by the central API but no collector emitted it. A merged commit is a
decision the owner actually accepted, so it carries the evidence the chat lane
was never going to produce.

Scope and conservatism:

* Only first-parent history of the checked-out branch is read. That is the
  accepted integration line — merges and direct commits — so work that only
  ever existed inside an unmerged branch is not treated as a decision.
* The claim is the compact decision (subject plus the first body paragraph),
  never the whole commit body, and generated trailers are stripped. Long
  rationale stays in git where it is already durable.
* Nothing here writes: `git log` only, no network, no credential.
"""

from __future__ import annotations

import re
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .. import schema
from ..watermarks import WatermarkStore
from . import CollectorResult, build_observation, host_name, reject

RUNTIME = "git"
TRUST = "observed_project_event"

# Bounded well under sanitizer.PASTED_LENGTH_THRESHOLD (2500) and
# schema.OBSERVATION_TEXT_MAX (1200): a decision, not a rationale dump.
CLAIM_MAX = 800

_RECORD_SEP = "\x1e"
_FIELD_SEP = "\x1f"
_LOG_FORMAT = _FIELD_SEP.join(["%H", "%cI", "%s", "%b"]) + _RECORD_SEP

# Integration bookkeeping, not a decision. A `Merge pull request` commit is
# kept: its body carries the accepted PR title.
_NOISE_SUBJECT = re.compile(
    r"^(?:Merge branch\b|Merge remote-tracking\b|Merge commit\b|fixup!|squash!|wip\b"
    # Automated worker bookkeeping: one commit per promotion attempt,
    # carrying no durable decision of its own.
    r"|chore\(coding-team\): promote task \d+ attempt \d+)",
    re.IGNORECASE,
)
_PR_MERGE_SUBJECT = re.compile(r"^Merge pull request #\d+ from \S+\s*$", re.IGNORECASE)

# Generated/attribution trailers carry no durable meaning.
_TRAILER = re.compile(
    r"^(?:Co-Authored-By|Signed-off-by|Co-authored-by|Reviewed-by|Refs|Closes|Fixes"
    r"|Generated with|\N{ROBOT FACE}.*Generated with)\b.*$",
    re.IGNORECASE | re.MULTILINE,
)


def _run_git(repo: Path, args: list[str]) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=str(repo),
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    ).stdout


def _claim(subject: str, body: str) -> str:
    """Compact decision text: the PR/commit subject plus its first paragraph."""
    body = _TRAILER.sub("", body or "").strip()
    if _PR_MERGE_SUBJECT.match(subject or "") and body:
        # GitHub puts the accepted PR title on the first body line.
        lines = [line for line in body.split("\n") if line.strip()]
        subject, body = lines[0].strip(), "\n".join(lines[1:]).strip()
    paragraph = body.split("\n\n", 1)[0].strip() if body else ""
    claim = f"{subject.strip()}\n\n{paragraph}".strip() if paragraph else subject.strip()
    return claim[:CLAIM_MAX].strip()


def _parse_log(raw: str):
    for record in raw.split(_RECORD_SEP):
        record = record.strip("\n")
        if not record.strip():
            continue
        parts = record.split(_FIELD_SEP)
        if len(parts) < 3:
            continue
        sha, committed_at, subject = parts[0].strip(), parts[1].strip(), parts[2]
        body = parts[3] if len(parts) > 3 else ""
        if sha:
            yield sha, committed_at, subject, body


def default_repos() -> tuple[Path, ...]:
    import os

    root = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    return (Path(root),)


def collect(
    *,
    repos=None,
    store: WatermarkStore,
    lookback_days: int = schema.DEFAULT_LOOKBACK_DAYS,
    max_files: int = schema.MAX_FILES_PER_COLLECTOR,
    accepted_ref: str = "main",
) -> CollectorResult:
    # `max_files` bounds how many repositories are read; commits are bounded by
    # the observation budget instead, so a normal day is never truncated.
    result = CollectorResult(
        runtime=RUNTIME,
        host=host_name(),
        agentOrProfile="git-history",
    )
    result.watermarkBefore = store.token()

    targets = tuple(repos) if repos else default_repos()
    since = (datetime.now(timezone.utc) - timedelta(days=max(1, lookback_days))).strftime(
        "%Y-%m-%dT%H:%M:%S"
    )

    for repo in targets[: max(1, max_files)]:
        repo = Path(repo)
        try:
            top = _run_git(repo, ["rev-parse", "--show-toplevel"]).strip()
        except (OSError, subprocess.CalledProcessError) as exc:
            result.errors.append(f"{repo.name}: not a readable git repository ({exc})")
            continue

        repo = Path(top)
        key = repo.name
        # build_observation snapshots result.project, so update it for every
        # repository rather than attributing all observations to the first one.
        result.project = key
        result.sourceFilesSeen += 1

        try:
            accepted_commit = _run_git(
                repo, ["rev-parse", "--verify", f"{accepted_ref}^{{commit}}"]
            ).strip()
        except (OSError, subprocess.CalledProcessError) as exc:
            result.errors.append(
                f"{key}: accepted ref {accepted_ref!r} is not a commit ({exc})"
            )
            continue

        entry = store.get(key) or {}
        last_commit = str(entry.get("lastCommit") or "")

        # `<sha>..HEAD` yields only what is new since the accepted watermark. A
        # rewritten or missing sha falls back to the time window rather than
        # replaying the whole history.
        selector = accepted_commit
        if last_commit:
            try:
                _run_git(repo, ["cat-file", "-e", f"{last_commit}^{{commit}}"])
                _run_git(repo, ["merge-base", "--is-ancestor", last_commit, accepted_commit])
                selector = f"{last_commit}..{accepted_commit}"
            except (OSError, subprocess.CalledProcessError):
                result.drift.append(
                    f"{key}: watermark commit missing or outside {accepted_ref}, using time window"
                )

        try:
            remaining = schema.MAX_OBSERVATIONS_PER_COLLECTOR - result.sourceEventsSeen
            if remaining <= 0:
                result.drift.append("git event budget exhausted; backlog will continue next run")
                break
            count = int(_run_git(repo, [
                "rev-list", "--first-parent", "--count", f"--since={since}", selector,
            ]).strip() or "0")
            # git log limits newest-first before --reverse. Skipping the newest
            # overflow selects the oldest page, so the watermark advances
            # contiguously and never drops a large first-run backlog.
            skip = max(0, count - remaining)
            raw = _run_git(repo, [
                "log", "--first-parent", f"--since={since}",
                f"--skip={skip}", f"--max-count={remaining}", "--reverse",
                f"--format={_LOG_FORMAT}", selector,
            ])
        except (OSError, subprocess.CalledProcessError) as exc:
            result.errors.append(f"{key}: git log failed ({exc})")
            continue

        newest = ""
        for sha, committed_at, subject, body in _parse_log(raw):
            result.sourceEventsSeen += 1
            newest = sha  # page is oldest-first; retain the newest scanned sha
            claim = _claim(subject, body)
            if _NOISE_SUBJECT.match(claim):
                reject(result, "cron_or_automation")
                continue
            build_observation(
                result,
                text=claim,
                trust=TRUST,
                session_id=key,
                event_id=sha,
                observed_at=committed_at,
                source_ref=f"{key}@{sha[:12]}",
            )

        # Stage only when this repo actually produced a new head; an empty
        # window must not move the watermark forward.
        if newest:
            result.stagedWatermarks[key] = {
                "lastCommit": newest,
                "acceptedRef": accepted_ref,
            }
            if count > remaining:
                result.drift.append(
                    f"{key}: {count - remaining} newer accepted event(s) remain queued"
                )
        elif entry:
            result.stagedWatermarks[key] = dict(entry)

    result.watermarkAfter = store.token()
    return result
