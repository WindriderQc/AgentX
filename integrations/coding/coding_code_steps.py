"""Runner-owned planning contract for bounded autonomous code steps.

The planning model proposes JSON, but it never expands task scope or decides
how much work a turn may receive.  This module derives those limits from the
selected lane capability and returns a small, canonical, dependency-ordered
plan that the runner can persist and execute one step at a time.
"""
from __future__ import annotations

import json
import posixpath
import re


PLAN_SCHEMA = "agentx.coding-code-plan/v1"
MAX_PLAN_BYTES = 64 * 1024
MAX_STEPS = 16
MAX_TEXT = 2_000
_STEP_ID = re.compile(r"step-(0[1-9]|1[0-6])")


class CodePlanError(ValueError):
    """A proposed code plan is malformed or exceeds runner-owned bounds."""


def _integer(value, default):
    return value if type(value) is int and value > 0 else default


def _capability_context(capability):
    if not isinstance(capability, dict):
        return 24_576, "default"
    agent = capability.get("agent")
    if isinstance(agent, dict):
        value = agent.get("recommendedStepContext")
        if type(value) is int and value > 0:
            return value, "agent_workload"
    value = capability.get("recommendedStepContext")
    if type(value) is int and value > 0:
        return value, "agent_workload"
    context = capability.get("context")
    if isinstance(context, dict):
        value = context.get("knee")
        if type(value) is int and value > 0:
            return value, "speed_knee"
    return 24_576, "default"


def step_budget(capability=None):
    """Return stable plan limits derived from the selected coding lane.

    Context is deliberately clamped: an unreasonably large lane description
    must not turn one step into the original unbounded coding session.  Explicit
    lower limits in the capability may tighten, but never enlarge, these bounds.
    """
    context, source = _capability_context(capability)
    context = max(8_192, min(65_536, context))
    scale = max(1, context // 8_192)
    result = {
        "stepContext": context,
        "maxSteps": MAX_STEPS,
        "maxFilesPerStep": min(8, scale + 1),
        "maxTestsPerStep": min(6, max(2, scale)),
        "maxObjectiveChars": min(MAX_TEXT, max(600, context // 16)),
        "source": source,
    }
    limits = None
    if isinstance(capability, dict) and isinstance(capability.get("agent"), dict):
        limits = capability["agent"].get("codeStepLimits")
    if limits is None and isinstance(capability, dict):
        limits = capability.get("codeStepLimits")
    if isinstance(limits, dict):
        for field in ("maxSteps", "maxFilesPerStep", "maxTestsPerStep", "maxObjectiveChars"):
            if type(limits.get(field)) is int and limits[field] > 0:
                result[field] = min(result[field], limits[field])
    return result


def repository_path(value, label="path"):
    """Canonicalize one exact repository-relative path or refuse it."""
    if not isinstance(value, str) or not value or len(value) > 500:
        raise CodePlanError(f"{label} must be a nonempty repository-relative path")
    if "\x00" in value or "\\" in value or value.startswith(("/", "~")):
        raise CodePlanError(f"{label} must be a repository-relative POSIX path")
    if value != value.strip() or value.endswith("/"):
        raise CodePlanError(f"{label} is not canonical")
    parts = value.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise CodePlanError(f"{label} cannot contain empty, dot, or parent components")
    normalized = posixpath.normpath(value)
    if normalized != value:
        raise CodePlanError(f"{label} is not canonical")
    return value


def _text(value, label, limit):
    if not isinstance(value, str) or not value.strip():
        raise CodePlanError(f"{label} must be a nonempty string")
    value = value.strip()
    if len(value) > limit:
        raise CodePlanError(f"{label} exceeds {limit} characters")
    return value


def _title(value, label):
    value = _text(value, label, 160)
    if re.search(r"[\x00-\x1f\x7f]", value):
        raise CodePlanError(f"{label} must be one display line")
    return value


def parse_plan_json(value):
    """Parse a bounded JSON object, accepting a fenced model response."""
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        raise CodePlanError("the plan must be a JSON object")
    if len(value.encode("utf-8")) > MAX_PLAN_BYTES:
        raise CodePlanError(f"the plan exceeds {MAX_PLAN_BYTES} bytes")
    text = value.strip()
    fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", text, re.I | re.S)
    if fenced:
        text = fenced.group(1)
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as error:
        raise CodePlanError(f"the plan is not valid JSON: {error.msg}") from error
    if not isinstance(parsed, dict):
        raise CodePlanError("the plan must be a JSON object")
    return parsed


def validate_plan(value, allowed_paths, lane_capability=None):
    """Validate and canonicalize a planner result without mutating it."""
    plan = parse_plan_json(value)
    if set(plan) != {"schema", "summary", "steps"}:
        raise CodePlanError("the plan must contain only schema, summary, and steps")
    if plan.get("schema") != PLAN_SCHEMA:
        raise CodePlanError(f"schema must be {PLAN_SCHEMA}")
    allowed = {repository_path(path, "authorized path") for path in allowed_paths}
    if not allowed:
        raise CodePlanError("the task has no authorized paths")
    budget = step_budget(lane_capability)
    rows = plan.get("steps")
    if not isinstance(rows, list) or not 1 <= len(rows) <= budget["maxSteps"]:
        raise CodePlanError(f"steps must contain 1-{budget['maxSteps']} entries")

    canonical = {"schema": PLAN_SCHEMA, "summary": _text(plan.get("summary"), "summary", MAX_TEXT), "steps": []}
    seen_ids = set()
    prior_paths = {}
    for index, row in enumerate(rows, 1):
        label = f"step {index}"
        if not isinstance(row, dict) or set(row) != {"id", "title", "objective", "paths", "testTargets", "dependsOn"}:
            raise CodePlanError(f"{label} must contain only id, title, objective, paths, testTargets, and dependsOn")
        step_id = row.get("id")
        expected = f"step-{index:02d}"
        if step_id != expected or not _STEP_ID.fullmatch(step_id or ""):
            raise CodePlanError(f"{label} id must be {expected}")
        paths = row.get("paths")
        if not isinstance(paths, list) or not 1 <= len(paths) <= budget["maxFilesPerStep"]:
            raise CodePlanError(f"{step_id} paths must contain 1-{budget['maxFilesPerStep']} entries")
        clean_paths = [repository_path(path, f"{step_id} path") for path in paths]
        if len(set(clean_paths)) != len(clean_paths):
            raise CodePlanError(f"{step_id} paths must be distinct")
        outside = sorted(set(clean_paths) - allowed)
        if outside:
            raise CodePlanError(f"{step_id} exceeds the authorized path scope: {', '.join(outside)}")
        tests = row.get("testTargets")
        if not isinstance(tests, list) or not 1 <= len(tests) <= budget["maxTestsPerStep"]:
            raise CodePlanError(f"{step_id} testTargets must contain 1-{budget['maxTestsPerStep']} entries")
        clean_tests = [repository_path(test, f"{step_id} test target") for test in tests]
        if len(set(clean_tests)) != len(clean_tests):
            raise CodePlanError(f"{step_id} testTargets must be distinct")
        dependencies = row.get("dependsOn")
        if not isinstance(dependencies, list) or any(not isinstance(dep, str) for dep in dependencies):
            raise CodePlanError(f"{step_id} dependsOn must be a list of earlier step ids")
        if len(set(dependencies)) != len(dependencies) or any(dep not in seen_ids for dep in dependencies):
            raise CodePlanError(f"{step_id} dependencies must be distinct earlier step ids")
        # Reusing a file is permitted only when the new step explicitly follows
        # every earlier step that owned it. This retains a total order for that
        # file while still allowing implementation followed by cleanup.
        required = {prior_paths[path] for path in clean_paths if path in prior_paths}
        if not required.issubset(set(dependencies)):
            raise CodePlanError(f"{step_id} must depend on earlier steps that use the same paths")
        for path in clean_paths:
            prior_paths[path] = step_id
        canonical["steps"].append({
            "id": step_id,
            "title": _title(row.get("title"), f"{step_id} title"),
            "objective": _text(row.get("objective"), f"{step_id} objective", budget["maxObjectiveChars"]),
            "paths": clean_paths,
            "testTargets": clean_tests,
            "dependsOn": list(dependencies),
        })
        seen_ids.add(step_id)
    return canonical


def _json_for_prompt(value, limit=12_000):
    text = json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2)
    if len(text) > limit:
        raise CodePlanError("planner context exceeds its bounded prompt allowance")
    return text


def plan_prompt(task, manifest, output_path, budget):
    """Build the fresh planning turn; the runner validates its output later."""
    output_path = str(output_path)
    paths = (manifest.get("paths") or manifest.get("scope")) if isinstance(manifest, dict) else manifest
    paths = [repository_path(path, "manifest path") for path in (paths or [])]
    if not paths:
        raise CodePlanError("the task manifest has no paths")
    safe_budget = {key: budget[key] for key in ("stepContext", "maxSteps", "maxFilesPerStep", "maxTestsPerStep", "maxObjectiveChars") if key in budget}
    template = {
        "schema": PLAN_SCHEMA,
        "summary": "bounded implementation summary",
        "steps": [{"id": "step-01", "title": "short title", "objective": "one independently testable change",
                   "paths": [paths[0]], "testTargets": ["path/to/focused_test.py"], "dependsOn": []}],
    }
    return (
        "Create a bounded implementation plan. Do not edit source files.\n"
        "The read-only repository is /workspace; manifest paths are relative to /workspace. "
        "Your current directory is a separate writable deliverable directory, not the repository.\n"
        "Use only exact paths from the manifest. Order dependencies backward; a step may depend only on earlier ids. "
        "Every step must be independently testable and name at least one focused test.\n"
        "The runner requires passing focused tests before committing each step. Keep a source fix and its "
        "regression tests in the same step; do not create a failing-test-only step or a verification-only step. "
        "Independent pre-patch checks are external acceptance evidence, not a separate failing commit.\n"
        f"Runner limits:\n{_json_for_prompt(safe_budget)}\n"
        f"Task:\n{_json_for_prompt(task)}\n"
        f"Authorized manifest:\n{_json_for_prompt({'paths': paths})}\n"
        f"Write exactly one JSON object to {output_path} with this shape:\n{_json_for_prompt(template)}\n"
        "Do not include prose or Markdown fences in the file."
    )


def step_prompt(task, step, ledger_summary, verification_profile):
    """Build one fresh implementation turn without prior model conversation."""
    if not isinstance(step, dict) or not isinstance(step.get("paths"), list):
        raise CodePlanError("step prompt needs a validated step")
    retry = ("This is a retry after the runner rejected an earlier attempt. Re-check the assigned focused test "
             "targets and correct the implementation instead of repeating it.\n"
             if step.get("attempts", 0) > 1 else "")
    return (
        "Implement exactly one runner-owned code step in the prepared repository.\n"
        "Edit only the authorized paths below. Do not commit, push, publish, or alter runner receipts; the runner owns Git and verification.\n"
        + retry +
        f"Task:\n{_json_for_prompt(task)}\n"
        f"Step:\n{_json_for_prompt(step)}\n"
        f"Verified dependency summary:\n{_json_for_prompt(ledger_summary)}\n"
        f"Runner verification profile:\n{_json_for_prompt(verification_profile)}\n"
        "Finish after the scoped source change is ready for the runner's focused tests."
    )
