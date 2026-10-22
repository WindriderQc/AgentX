"""Bound the public live projection of the runner-owned code-step ledger."""

from __future__ import annotations

import re


SCHEMA = "agentx.code-step-summary/v1"
STATES = ("pending", "running", "passed", "failed")
BUDGET_SOURCES = {"agent_workload", "speed_knee", "default"}
OUTCOMES = {"passed", "failed", "unknown"}
SHA256 = re.compile(r"[a-f0-9]{64}")
COMMIT = re.compile(r"[a-f0-9]{40}")
STEP_ID = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9._:/-]{0,79})")
PROFILE_ID = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9._:/-]{0,119})")
MAX_STEPS = 32
MAX_TESTS = 16
MAX_DURATION_MS = 604_800_000


def _integer(value, maximum):
    return value if type(value) is int and 0 <= value <= maximum else None


def project(value: object) -> dict | None:
    """Return only the bounded summary contract, or no projection if inconsistent."""
    if not isinstance(value, dict) or value.get("schema") != SCHEMA:
        return None
    fingerprint = value.get("planFingerprint")
    context = _integer(value.get("stepContext"), 2_000_000)
    source = value.get("budgetSource")
    rows = value.get("steps")
    counts = value.get("counts")
    if (not isinstance(fingerprint, str) or not SHA256.fullmatch(fingerprint) or context is None
            or not context or source not in BUDGET_SOURCES or not isinstance(rows, list) or not 1 <= len(rows) <= MAX_STEPS
            or not isinstance(counts, dict)):
        return None

    safe_rows, identifiers = [], set()
    for row in rows:
        if not isinstance(row, dict):
            return None
        identifier, title, state, tests = row.get("id"), row.get("title"), row.get("state"), row.get("tests")
        title = title.strip() if isinstance(title, str) else title
        if (not isinstance(identifier, str) or not STEP_ID.fullmatch(identifier) or identifier in identifiers
                or not isinstance(title, str) or not title or len(title) > 160 or re.search(r"[\x00-\x1f\x7f]", title)
                or state not in STATES or not isinstance(tests, list) or len(tests) > MAX_TESTS):
            return None
        safe_tests = []
        for test in tests:
            if not isinstance(test, dict):
                return None
            profile, outcome = test.get("profile"), test.get("outcome")
            if not isinstance(profile, str) or not PROFILE_ID.fullmatch(profile) or outcome not in OUTCOMES:
                return None
            safe_test = {"profile": profile, "outcome": outcome}
            if "durationMs" in test:
                duration = _integer(test["durationMs"], MAX_DURATION_MS)
                if duration is None:
                    return None
                safe_test["durationMs"] = duration
            safe_tests.append(safe_test)
        commit = row.get("commit")
        if state == "passed":
            if (not isinstance(commit, str) or not COMMIT.fullmatch(commit) or not safe_tests
                    or any(test["outcome"] != "passed" for test in safe_tests)):
                return None
        elif commit is not None:
            return None
        safe_row = {"id": identifier, "title": title, "state": state, "tests": safe_tests}
        if commit is not None:
            safe_row["commit"] = commit
        safe_rows.append(safe_row)
        identifiers.add(identifier)

    safe_counts = {state: _integer(counts.get(state), MAX_STEPS) for state in STATES}
    actual = {state: sum(row["state"] == state for row in safe_rows) for state in STATES}
    if None in safe_counts.values() or safe_counts != actual:
        return None
    running = [row["id"] for row in safe_rows if row["state"] == "running"]
    current = value.get("currentStep")
    if len(running) > 1 or (running and current != running[0]) or (not running and current is not None):
        return None
    return {"schema": SCHEMA, "planFingerprint": fingerprint, "stepContext": context,
            "budgetSource": source, "currentStep": current, "counts": safe_counts, "steps": safe_rows}
