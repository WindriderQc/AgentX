"""Bound the dispatcher envelope and distinguish capacity from unknown execution."""
from __future__ import annotations

import math
import subprocess

DEFERRED_EXIT = 4
UNKNOWN_EXIT = 5


def positive_seconds(value, name):
    if type(value) is not int or value <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return value


def worker_timeout(execution, automation):
    configured = positive_seconds(execution.get("workerTimeoutSeconds", 900), "workerTimeoutSeconds")
    return min(configured, math.ceil(automation["budgets"]["maxDurationMs"] / 1000))


def dispatcher_timeout(execution, verification, automation):
    """Cover pre-claim baseline, the attempt and bounded post-worker evidence.

    This envelope is not an extension of the task's duration or worker budget.
    The guard still checks elapsed attempt time before accepting a patch.
    """
    verify = positive_seconds(verification["timeoutSeconds"], "verification timeoutSeconds")
    baseline = float(execution["localEnergyEvidence"].get("baselineSeconds", 10))
    interval = float(execution["localEnergyEvidence"].get("sampleIntervalSeconds", 1))
    if not math.isfinite(baseline) or not 2 <= baseline <= 120:
        raise ValueError("energy baselineSeconds must be between 2 and 120")
    if not math.isfinite(interval) or not 0.25 <= interval <= 10:
        raise ValueError("energy sampleIntervalSeconds must be between 0.25 and 10")
    # Each sample can spend the existing SSH reader timeout of 15 seconds.
    energy_baseline = 15 * max(3, round(baseline / interval)) + math.ceil(baseline)
    # Existing bounded setup: Git (60), sync (120), remote checks (90),
    # OpenClaw preflight (30). Allow the existing retry envelope (4*30+9)
    # for ten task/lease/report/feedback reads or mutations, plus SSH grace.
    setup_and_settlement = 60 + 120 + 90 + 30 + 10 * 129 + 90
    repair = 180 + verify if verification.get("repairTurns", 0) else 0
    return (setup_and_settlement + verify
            + math.ceil(automation["budgets"]["maxDurationMs"] / 1000)
            + energy_baseline + 30 + verify + repair)


def run_guard(command, timeout):
    try:
        return subprocess.run(command, shell=False, timeout=timeout, check=False).returncode
    except subprocess.TimeoutExpired:
        # Killing the local guard does not prove that a remote worker stopped.
        # Keep Core's task/automation lease and its recovery fence authoritative.
        print("guarded_dispatch=unknown")
        print("reason=dispatcher_envelope_timeout_remote_completion_unproven")
        return UNKNOWN_EXIT


def stopped_at(exit_code):
    return {0: "review", DEFERRED_EXIT: "deferred", UNKNOWN_EXIT: "unknown"}.get(
        exit_code, "blocked_or_failed"
    )
