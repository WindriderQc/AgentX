#!/usr/bin/env python3
"""Fail closed when the Gmail Secretary OAuth path cannot reach Gmail."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Any

MAILBOX_BACKLOG_QUERY = 'in:anywhere -in:spam -in:trash -in:drafts -in:sent -label:"Secretary/Processed"'
# OpenClaw 2026.9.4 hardcodes MAX_CONSECUTIVE_RUN_FAILURES = 10 and disables any
# recurring job that reaches it. Both Secretary jobs died silently that way on
# 2026-09-16/17 during an inference outage; see revive/yield below.
OPENCLAW_AUTO_DISABLE_LIMIT = 10

class GmailSecretaryProbeError(RuntimeError):
    """Raised when the bounded Gmail authorization probe fails."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--account", required=True)
    parser.add_argument("--gog", default="gog")
    parser.add_argument(
        "--keyring-password-file", default=str(Path.home() / ".config/gogcli/keyring-password")
    )
    parser.add_argument(
        "--audit-log", default=str(Path.home() / ".openclaw/logs/gmail-secretary.jsonl")
    )
    parser.add_argument("--timeout-seconds", type=int, default=20)
    parser.add_argument("--audit-stale-seconds", type=int, default=7200)
    parser.add_argument("--incomplete-grace-seconds", type=int, default=300)
    parser.add_argument("--openclaw", default="openclaw")
    parser.add_argument(
        "--triage-job-id", required=True
    )
    parser.add_argument(
        "--watchdog-job-id", required=True
    )
    parser.add_argument("--revive-retry-seconds", type=int, default=3600)
    parser.add_argument("--catchup-every", default="5m")
    parser.add_argument("--steady-every", default="1h")
    parser.add_argument("--evidence-status", default=str(Path.home() / ".local/share/agentx/secretary-evidence/native-status.json"))
    return parser.parse_args()


def gmail_environment(password_file: Path) -> dict[str, str]:
    try:
        password = password_file.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise GmailSecretaryProbeError("cannot read the Gmail keyring password") from exc
    if not password:
        raise GmailSecretaryProbeError("the Gmail keyring password is empty")
    env = os.environ.copy()
    env["GOG_KEYRING_BACKEND"] = "file"
    env["GOG_KEYRING_PASSWORD"] = password
    return env


def failure_detail(stdout: str, stderr: str, returncode: int) -> str:
    raw = " ".join((stderr or stdout).split())
    lowered = raw.lower()
    if "invalid_grant" in lowered or "expired or revoked" in lowered:
        return "Gmail OAuth grant expired or revoked"
    if "no auth for" in lowered:
        return "Gmail authorization is missing from the gog keyring; the owner must run gog auth add"
    if "rate limit" in lowered or "ratelimit" in lowered or "quota" in lowered:
        return "Gmail API quota or rate limit blocked the probe"
    if "timeout" in lowered or "timed out" in lowered:
        return "Gmail API probe timed out"
    return f"Gmail API probe exited {returncode}"


def run_probe(args: argparse.Namespace) -> int:
    command = [
        args.gog,
        "--readonly",
        "--gmail-no-send",
        "--no-input",
        "--json",
        "--results-only",
        "--enable-commands-exact=gmail.messages.search",
        f"--account={args.account}",
        "--select=id",
        "gmail",
        "messages",
        "search",
        MAILBOX_BACKLOG_QUERY,
        "--max=1",
        "--timezone=America/Toronto",
    ]
    try:
        result = subprocess.run(
            command,
            env=gmail_environment(Path(args.keyring_password_file)),
            text=True,
            capture_output=True,
            check=False,
            timeout=max(1, args.timeout_seconds),
        )
    except subprocess.TimeoutExpired as exc:
        raise GmailSecretaryProbeError("Gmail API probe timed out") from exc
    if result.returncode != 0:
        raise GmailSecretaryProbeError(
            failure_detail(result.stdout, result.stderr, result.returncode)
        )
    try:
        payload: Any = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise GmailSecretaryProbeError("Gmail API probe returned invalid JSON") from exc
    if not isinstance(payload, list):
        raise GmailSecretaryProbeError("Gmail API probe returned an unexpected result")
    return len(payload)


def parse_audit_time(value: Any) -> datetime:
    if not isinstance(value, str):
        raise GmailSecretaryProbeError("Gmail Secretary audit timestamp is missing")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise GmailSecretaryProbeError("Gmail Secretary audit timestamp is invalid") from exc


def read_audit_records(audit_log: Path) -> list[dict[str, Any]]:
    try:
        lines = audit_log.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise GmailSecretaryProbeError("cannot read the Gmail Secretary audit log") from exc
    records: list[dict[str, Any]] = []
    for line in lines[-2000:]:
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            records.append(value)
    return records


def latest_backlog_record(
    records: list[dict[str, Any]],
) -> tuple[int, dict[str, Any]]:
    backlog_indexes = [
        index
        for index, record in enumerate(records)
        if record.get("tool") == "gmail_secretary_backlog_next"
    ]
    if not backlog_indexes:
        raise GmailSecretaryProbeError("Gmail Secretary has no backlog audit record")
    index = backlog_indexes[-1]
    return index, records[index]


def check_audit_records_health(
    records: list[dict[str, Any]],
    *,
    now: datetime | None = None,
    stale_seconds: int = 7200,
    incomplete_grace_seconds: int = 300,
) -> str:
    backlog_index, backlog = latest_backlog_record(records)
    backlog_time = parse_audit_time(backlog.get("at"))
    current = now or datetime.now(timezone.utc)
    age_seconds = max(0, int((current - backlog_time).total_seconds()))
    if age_seconds > max(1, stale_seconds):
        raise GmailSecretaryProbeError("Gmail Secretary backlog audit is stale")
    if backlog.get("status") != "ok":
        raise GmailSecretaryProbeError("the latest Gmail Secretary backlog lookup failed")
    if backlog.get("outcome") == "empty":
        return "empty"
    completed = any(
        record.get("tool") == "gmail_secretary_apply_triage"
        and record.get("status") == "ok"
        for record in records[backlog_index + 1 :]
    )
    if completed:
        return "complete"
    if age_seconds <= max(1, incomplete_grace_seconds):
        return "in_progress"
    raise GmailSecretaryProbeError(
        "the latest Gmail Secretary run found a thread but did not complete triage"
    )


def check_audit_health(
    audit_log: Path,
    *,
    now: datetime | None = None,
    stale_seconds: int = 7200,
    incomplete_grace_seconds: int = 300,
) -> str:
    return check_audit_records_health(
        read_audit_records(audit_log),
        now=now,
        stale_seconds=stale_seconds,
        incomplete_grace_seconds=incomplete_grace_seconds,
    )


def desired_cadence(
    backlog: dict[str, Any],
    *,
    now: datetime | None = None,
    catchup_every: str = "5m",
    steady_every: str = "1h",
) -> str:
    if backlog.get("outcome") == "empty":
        return steady_every
    if backlog.get("outcome") != "ready":
        raise GmailSecretaryProbeError("Gmail Secretary backlog outcome is unavailable")
    return catchup_every


def check_evidence_health(records, status_file, *, now=None, stale_seconds=7200):
    current = now or datetime.now(timezone.utc)
    try:
        status = json.loads(Path(status_file).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise GmailSecretaryProbeError("Secretary deep-review progress is unavailable") from exc
    if (current - parse_audit_time(status.get("at"))).total_seconds() > stale_seconds:
        raise GmailSecretaryProbeError("Secretary deep-review progress is stale")
    evidence = [r for r in records if r.get("tool") == "gmail_secretary_evidence"]
    if not evidence or evidence[-1].get("status") != "ok":
        raise GmailSecretaryProbeError("Secretary deep-review tool failed or has no receipt")
    last = evidence[-1]
    if last.get("action") == "next" and last.get("outcome") != "empty":
        attempts = [r for r in evidence if r.get("action") == "next" and r.get("pageId") == last.get("pageId")]
        started = attempts[0] if attempts else last
        if (current - parse_audit_time(started.get("at"))).total_seconds() > 600:
            raise GmailSecretaryProbeError("Secretary read a source page without recording its review")
    return bool(status.get("pending"))


def duration_milliseconds(value: str) -> int:
    match = re.fullmatch(r"([1-9]\d*)([mh])", value)
    if not match:
        raise GmailSecretaryProbeError(f"unsupported Gmail Secretary cadence: {value}")
    multiplier = 60_000 if match.group(2) == "m" else 3_600_000
    return int(match.group(1)) * multiplier


def cron_job(openclaw: str, job_id: str, timeout_seconds: int = 20) -> dict[str, Any]:
    try:
        current = subprocess.run(
            [openclaw, "cron", "get", job_id],
            text=True,
            capture_output=True,
            check=False,
            timeout=max(1, timeout_seconds),
        )
    except subprocess.TimeoutExpired as exc:
        raise GmailSecretaryProbeError("OpenClaw cron lookup timed out") from exc
    if current.returncode != 0:
        raise GmailSecretaryProbeError("OpenClaw cron lookup failed")
    try:
        job: Any = json.loads(current.stdout)
    except json.JSONDecodeError as exc:
        raise GmailSecretaryProbeError("OpenClaw returned an invalid job") from exc
    if not isinstance(job, dict):
        raise GmailSecretaryProbeError("OpenClaw returned an invalid job")
    return job


def revive_auto_disabled(
    *,
    openclaw: str,
    job_id: str,
    now: datetime | None = None,
    retry_seconds: int = 3600,
    timeout_seconds: int = 20,
) -> str | None:
    """Re-enable the triage job after OpenClaw's consecutive-failure disable.

    An owner pause carries no autoDisabled marker and is never touched. Enabling
    resets OpenClaw's failure streak, so a still-broken dependency costs one
    short burst of failed turns per retry period instead of a permanent stop.
    """
    job = cron_job(openclaw, job_id, timeout_seconds)
    state = job.get("state") if isinstance(job.get("state"), dict) else {}
    marker = state.get("autoDisabled")
    if job.get("enabled") is not False or not isinstance(marker, dict)             or marker.get("reason") != "consecutive-failures":
        return None
    cause = " ".join(str(state.get("lastError") or "unknown error").split())[:160]
    note = f"OpenClaw auto-disabled the triage job after {marker.get('consecutiveErrors', '?')} failures ({cause})"
    current = now or datetime.now(timezone.utc)
    disabled_at = marker.get("atMs") if isinstance(marker.get("atMs"), (int, float)) else 0
    if current.timestamp() - disabled_at / 1000 < max(1, retry_seconds):
        return note + "; retry pending"
    try:
        enabled = subprocess.run(
            [openclaw, "cron", "enable", job_id],
            text=True,
            capture_output=True,
            check=False,
            timeout=max(1, timeout_seconds),
        )
    except subprocess.TimeoutExpired as exc:
        raise GmailSecretaryProbeError(note + "; re-enable timed out") from exc
    if enabled.returncode != 0:
        raise GmailSecretaryProbeError(note + "; re-enable failed")
    return note + "; re-enabled now"


def failure_exit_code(*, openclaw: str, job_id: str, timeout_seconds: int = 20) -> int:
    """Keep this watchdog schedulable through a sustained outage.

    A health check fails by design while its target is down, and OpenClaw
    disables a job at OPENCLAW_AUTO_DISABLE_LIMIT consecutive errors. Yield one
    non-error exit before that limit: the streak restarts and the job's existing
    failure alert keeps reminding after its cooldown.
    """
    try:
        state = cron_job(openclaw, job_id, timeout_seconds).get("state")
        streak = state.get("consecutiveErrors", 0) if isinstance(state, dict) else 0
    except GmailSecretaryProbeError:
        return 1
    return 0 if isinstance(streak, int) and streak >= OPENCLAW_AUTO_DISABLE_LIMIT - 2 else 1


def reconcile_cadence(
    *,
    openclaw: str,
    job_id: str,
    desired: str,
    timeout_seconds: int = 20,
) -> str:
    try:
        every_ms = cron_job(openclaw, job_id, timeout_seconds)["schedule"]["everyMs"]
    except (KeyError, TypeError) as exc:
        raise GmailSecretaryProbeError("OpenClaw returned an invalid triage schedule") from exc
    desired_ms = duration_milliseconds(desired)
    if every_ms == desired_ms:
        return desired
    try:
        edited = subprocess.run(
            [openclaw, "cron", "edit", job_id, "--every", desired],
            text=True,
            capture_output=True,
            check=False,
            timeout=max(1, timeout_seconds),
        )
    except subprocess.TimeoutExpired as exc:
        raise GmailSecretaryProbeError("OpenClaw cron update timed out") from exc
    if edited.returncode != 0:
        raise GmailSecretaryProbeError("OpenClaw cron update failed")
    return desired


def main() -> int:
    args = parse_args()
    revived = None
    try:
        revived = revive_auto_disabled(
            openclaw=args.openclaw,
            job_id=args.triage_job_id,
            retry_seconds=args.revive_retry_seconds,
            timeout_seconds=args.timeout_seconds,
        )
        count = run_probe(args)
        records = read_audit_records(Path(args.audit_log))
        audit = check_audit_records_health(
            records,
            stale_seconds=args.audit_stale_seconds,
            incomplete_grace_seconds=args.incomplete_grace_seconds,
        )
        evidence_pending = check_evidence_health(records, args.evidence_status, stale_seconds=args.audit_stale_seconds)
        cadence = reconcile_cadence(
            openclaw=args.openclaw,
            job_id=args.triage_job_id,
            desired=desired_cadence(
                {"outcome": "ready" if count or evidence_pending else "empty"},
                catchup_every=args.catchup_every,
                steady_every=args.steady_every,
            ),
            timeout_seconds=args.timeout_seconds,
        )
    except GmailSecretaryProbeError as exc:
        detail = f"{exc}; {revived}" if revived else str(exc)
        print(f"GMAIL_SECRETARY_HEALTH_FAILED: {detail}", file=sys.stderr)
        code = failure_exit_code(
            openclaw=args.openclaw,
            job_id=args.watchdog_job_id,
            timeout_seconds=args.timeout_seconds,
        )
        if code == 0:
            print("GMAIL_SECRETARY_HEALTH_STILL_FAILING yielded one non-error exit to stay scheduled")
        return code
    print(
        f"GMAIL_SECRETARY_HEALTH_OK pending_mail_sampled={count} "
        f"audit={audit} deep_review_pending={int(evidence_pending)} cadence={cadence}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
