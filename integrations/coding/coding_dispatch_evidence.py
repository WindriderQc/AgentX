"""Validation and evidence rules of the guarded ClawdX dispatch.

Pure checks on tasks, worker feedback, execution routes, cost and repository
evidence, and the notices and contract-matrix run built on them. The entry
script clawdx-guarded-dispatch.py imports them; it keeps the SSH, API
and orchestration code that the tests replace."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Mapping

try:
    from integrations.coding.coding_team_observability import (
        ObservabilityError,
        send_coding_team_telegram,
    )
    from integrations.coding.coding_team_deliverable import (
        build_verified_feedback,
    )
except ModuleNotFoundError:  # direct execution from the scripts directory
    from coding_team_observability import (  # type: ignore
        ObservabilityError,
        send_coding_team_telegram,
    )
    from coding_team_deliverable import (  # type: ignore
        build_verified_feedback,
    )


PIPELINE_ATTRIBUTION_ALIAS = "ollama/agentx-pipeline"


PASS_STATUSES = {"pass", "passed", "ok", "verified", "done"}


AUTOMATION_EVIDENCE_SCHEMA = "agentx.pipeline-automation-evidence/v1"


REPO_PATH_PATTERN = re.compile(
    r"(?<![/A-Za-z0-9_.-])([A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+)"
)


class PipelineApiError(RuntimeError):
    """Raised when the AgentX pipeline API cannot satisfy a request."""


class ResourcePreflightDeferred(PipelineApiError):
    """Raised before claim when shared inference capacity is busy or unknown."""


def utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def retry_after_delay(
    raw: str,
    headers: Mapping[str, str] | None = None,
    *,
    fallback: float = 1.5,
    max_wait: float = 60.0,
    now: datetime | None = None,
) -> float:
    value: Any = None
    if headers:
        value = headers.get("Retry-After")
    if value is None:
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = {}
        if isinstance(payload, dict):
            value = payload.get("retryAfter")
            data = payload.get("data")
            if value is None and isinstance(data, dict):
                value = data.get("retryAfter")

    delay = fallback
    if isinstance(value, (int, float)):
        delay = float(value)
    elif isinstance(value, str) and value.strip():
        candidate = value.strip()
        try:
            delay = float(candidate)
        except ValueError:
            try:
                target = datetime.fromisoformat(candidate.replace("Z", "+00:00"))
                current = now or datetime.now(timezone.utc)
                if target.tzinfo is None:
                    target = target.replace(tzinfo=timezone.utc)
                delay = (target - current).total_seconds()
            except ValueError:
                delay = fallback
    return max(0.0, min(delay, max_wait))


def tasks_from_envelope(envelope: dict[str, Any]) -> list[dict[str, Any]]:
    data = envelope.get("data")
    tasks = data.get("tasks") if isinstance(data, dict) else None
    if not isinstance(tasks, list):
        raise PipelineApiError("pipeline task list response is missing data.tasks")
    return [task for task in tasks if isinstance(task, dict)]


def select_task(tasks: list[dict[str, Any]], task_id: str) -> dict[str, Any]:
    matches = [task for task in tasks if str(task.get("pipelineId") or "") == task_id]
    if not matches:
        raise PipelineApiError(f"pipeline task {task_id} was not found")
    if len(matches) > 1:
        raise PipelineApiError(f"pipeline task {task_id} is duplicated")
    return matches[0]


def validate_attribution_args(args: argparse.Namespace) -> None:
    if not getattr(args, "attest_attribution", False):
        return
    if args.model != PIPELINE_ATTRIBUTION_ALIAS:
        raise PipelineApiError(
            f"--attest-attribution requires --model {PIPELINE_ATTRIBUTION_ALIAS}"
        )
    raw_attempt = getattr(args, "attribution_attempt", None)
    if raw_attempt is not None and (int(raw_attempt) < 1 or int(raw_attempt) > 10_000):
        raise PipelineApiError("--attribution-attempt must be from 1 through 10000")


def bounded_failure_code(value: str) -> str:
    head = str(value or "unknown").split(":", 1)[0].strip().lower()
    normalized = re.sub(r"[^a-z0-9._/-]+", "-", head).strip("-.")
    return (normalized or "unknown")[:160]


def coding_attempt_number(args: argparse.Namespace) -> int:
    value = getattr(args, "attribution_attempt", None)
    return value if isinstance(value, int) and 1 <= value <= 10 else 1


def notify_coding_event(args: argparse.Namespace, event: str) -> None:
    try:
        delivered = send_coding_team_telegram(
            event,
            str(args.task_id),
            attempt=coding_attempt_number(args),
            ui_base=str(getattr(args, "telegram_ui_base", "http://127.0.0.1:3180/pipeline")),
            enabled=bool(getattr(args, "telegram_notifications", False)),
        )
        print(f"coding_team_notification={'sent' if delivered else 'disabled'}")
    except ObservabilityError:
        # Notification delivery is an external supervision aid. Its fixed error
        # state is visible, but it cannot rewrite a verified coding outcome.
        print("coding_team_notification=failed")


def build_attempt_evidence(
    *,
    duration_ms: int,
    verification_status: str = "unknown",
    verification_duration_ms: int | None = None,
    changes: Mapping[str, int] | None = None,
    failures: list[str] | None = None,
    cost_observation: Mapping[str, Any] | None = None,
    cost_mode: str | None = None,
    local_energy: Mapping[str, Any] | None = None,
    worker_receipt_fingerprint: str | None = None,
    routing_evidence: Mapping[str, Any] | None = None,
    inference: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    change_metrics = changes or {}
    cost_nanodollars = None
    cost_kind = None
    cost_source = None
    cost_fingerprint = None
    if cost_observation is not None and cost_observation.get("costNanodollars") is not None:
        if cost_mode != "local-zero":
            raise PipelineApiError("live paid cost evidence is disabled without a broker SpendGrant")
        cost_nanodollars = int(cost_observation["costNanodollars"])
        cost_kind = "provider-spend"
        cost_source = cost_evidence_source()
        cost_fingerprint = str(cost_observation["fingerprint"])
    usage = {
        "durationMs": max(0, int(duration_ms)),
        "costNanodollars": cost_nanodollars,
        "costKind": cost_kind,
        "costSource": cost_source,
        "costEvidenceFingerprint": cost_fingerprint,
    }
    if cost_observation and "costStatus" in cost_observation:
        usage["costStatus"] = cost_observation["costStatus"]
    if local_energy is not None:
        usage["localEnergy"] = dict(local_energy)
    if worker_receipt_fingerprint is not None and not re.fullmatch(
        r"[0-9a-f]{64}", worker_receipt_fingerprint
    ):
        raise PipelineApiError("worker receipt fingerprint is invalid")
    return {
        "schema": AUTOMATION_EVIDENCE_SCHEMA,
        "verification": {
            "status": verification_status,
            "durationMs": verification_duration_ms,
            "testsPassed": None,
            "testsFailed": None,
        },
        "changes": {
            "filesChanged": change_metrics.get("filesChanged"),
            "bytesChanged": change_metrics.get("bytesChanged"),
        },
        "usage": usage,
        "failureCodes": sorted(
            {bounded_failure_code(failure) for failure in (failures or [])}
        ),
        "workerReceiptFingerprint": worker_receipt_fingerprint,
        "source": "clawdx-guarded/v1",
        **({"routing": dict(routing_evidence)} if routing_evidence else {}),
        **({"inference": dict(inference)} if inference else {}),
    }


def parse_criteria_verified(text: str) -> list[dict[str, Any]] | None:
    parsed: list[dict[str, Any]] | None = None
    for match in re.findall(r"```(?:json)?\s*(.*?)```", text, re.I | re.S):
        try:
            payload = json.loads(match)
        except json.JSONDecodeError:
            continue
        criteria = payload.get("criteria_verified") if isinstance(payload, dict) else None
        if isinstance(criteria, list):
            parsed = []
            for entry in criteria:
                if not isinstance(entry, dict):
                    parsed.append(
                        {
                            "id": None,
                            "status": None,
                            "_invalidEntryType": type(entry).__name__,
                        }
                    )
                    continue
                normalized = dict(entry)
                raw_id = normalized.get("id")
                if raw_id is None:
                    raw_id = normalized.get("criterion")
                criterion_id = raw_id.strip() if isinstance(raw_id, str) else ""
                normalized["id"] = criterion_id or None
                normalized.pop("criterion", None)
                parsed.append(normalized)
    return parsed


def criterion_identity_validation_errors(criteria: list[dict[str, Any]]) -> list[str]:
    criterion_ids = [entry.get("id") for entry in criteria]
    missing_ids = [index for index, value in enumerate(criterion_ids) if not value]
    if missing_ids:
        return [
            "criteria_verified entries lack a non-empty id at indices: "
            + ",".join(str(index) for index in missing_ids)
        ]
    duplicate_ids = sorted(
        criterion_id
        for criterion_id in set(criterion_ids)
        if criterion_ids.count(criterion_id) > 1
    )
    if duplicate_ids:
        return [
            "criteria_verified contains duplicate ids: " + ",".join(duplicate_ids)
        ]
    return []


def task_validation_requirements(spec: str) -> dict[str, Any]:
    allowed_paths: set[str] = set()
    lines = spec.splitlines()
    for line in lines:
        if not re.search(
            r"\b(?:create|modify|change|touch)\s+only\b"
            r"|\bonly\s+repository\s+change\b",
            line,
            re.I,
        ):
            continue
        allowed_paths.update(
            path.rstrip(".,;:!?)]}")
            for path in REPO_PATH_PATTERN.findall(line)
        )

    line_limit = None
    line_match = re.search(r"\bunder\s+(\d+)\s+lines?\b", spec, re.I)
    if line_match:
        line_limit = int(line_match.group(1))
    require_ascii = any(
        re.search(r"\bASCII\b", line, re.I)
        and re.search(
            r"\b(?:file|files|document|documents|note|notes|artifact|artifacts|content)\b",
            line,
            re.I,
        )
        for line in lines
    )
    return {
        "allowed_paths": allowed_paths,
        "require_ascii": require_ascii,
        "line_limit_exclusive": line_limit,
        "require_diff_check": "git diff --check" in spec,
    }


def repository_snapshot_validation_errors(
    spec: str,
    files: dict[str, bytes],
    *,
    max_changed_files: int,
    max_changed_bytes: int,
    exact_scope: set[str] | None = None,
    changed_byte_count: int | None = None,
    tracked_diff_check_output: str = "",
    allow_incomplete: bool = False,
) -> list[str]:
    errors: list[str] = []
    requirements = task_validation_requirements(spec)
    changed_paths = set(files)
    allowed_paths = exact_scope if exact_scope is not None else requirements["allowed_paths"]

    if not changed_paths and not allow_incomplete:
        errors.append("remote checkout has no changed files")
    if len(changed_paths) > max_changed_files:
        errors.append(
            f"changed file count {len(changed_paths)} exceeds cap {max_changed_files}"
        )
    if allowed_paths and (changed_paths - allowed_paths or (not allow_incomplete and changed_paths != allowed_paths)):
        unexpected = sorted(changed_paths - allowed_paths)
        missing = sorted(allowed_paths - changed_paths)
        errors.append(
            f"changed paths do not match task scope; unexpected={unexpected}, missing={missing}"
        )

    total_bytes = (
        changed_byte_count
        if changed_byte_count is not None
        else sum(len(content) for content in files.values())
    )
    if total_bytes > max_changed_bytes:
        errors.append(
            f"changed diff bytes {total_bytes} exceed cap {max_changed_bytes}"
        )

    if allow_incomplete:
        # A question or rejected patch can be empty/partial and still be repaired.
        # Keep repository scope and size bounds; behavioral checks belong after repair.
        return errors
    if tracked_diff_check_output.strip():
        errors.append(
            "git diff --check reported whitespace errors: "
            + tracked_diff_check_output.strip()[:500]
        )

    for path, content in sorted(files.items()):
        if requirements["require_ascii"]:
            bad = [
                index + 1
                for index, line in enumerate(content.splitlines())
                if any(byte not in {9} and not 32 <= byte <= 126 for byte in line)
            ]
            if bad:
                errors.append(f"{path} contains non-ASCII bytes on lines {bad[:10]}")

        limit = requirements["line_limit_exclusive"]
        if limit is not None:
            line_count = len(content.splitlines())
            if line_count >= limit:
                errors.append(
                    f"{path} has {line_count} lines; task requires under {limit}"
                )

        if requirements["require_diff_check"]:
            trailing = [
                index + 1
                for index, line in enumerate(content.splitlines())
                if line.rstrip(b" \t") != line
            ]
            if trailing:
                errors.append(
                    f"{path} has trailing whitespace on lines {trailing[:10]}"
                )
    return errors


def automation_scope_files(task: dict[str, Any]) -> list[str]:
    automation = task.get("automation")
    raw = automation.get("scope") if isinstance(automation, dict) else None
    if not isinstance(raw, list) or not 1 <= len(raw) <= 30:
        raise PipelineApiError(
            "task automation must declare between 1 and 30 exact scope files"
        )
    normalized: list[str] = []
    for index, value in enumerate(raw):
        text = str(value or "").strip()
        parsed = PurePosixPath(text)
        if (
            not text
            or len(text) > 300
            or parsed.is_absolute()
            or "\\" in text
            or any(part in ("", ".", "..") for part in parsed.parts)
        ):
            raise PipelineApiError(
                f"automation.scope[{index}] is not a safe repository-relative path"
            )
        normalized.append(text)
    if len(set(normalized)) != len(normalized):
        raise PipelineApiError("automation.scope contains duplicates")
    return sorted(normalized)


def run_contract_matrix(args: argparse.Namespace, root: Path, stamp: str) -> int:
    matrix_json = Path(
        args.matrix_json_output
        or root / ".agentx" / "scratch" / f"clawdx-guarded-dispatch-{stamp}-matrix.json"
    )
    remote_root = args.matrix_remote_root or f"/tmp/clawdx-contract-guard-{stamp}"
    cmd = [
        sys.executable,
        str(root / "integrations/coding" / "clawdx-contract-matrix.py"),
        "--host",
        args.host,
        "--remote-root",
        remote_root,
        "--session-prefix",
        f"{args.session_prefix}-preflight-{stamp}",
        "--json-output",
        str(matrix_json),
    ]
    if args.model:
        cmd.extend(["--model", f"selected={args.model}"])
    if args.thinking:
        cmd.extend(["--thinking", args.thinking])
    proc = subprocess.run(
        cmd,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if proc.stdout:
        sys.stdout.write(proc.stdout)
    if proc.stderr:
        sys.stderr.write(proc.stderr)
    print(f"matrix_json={matrix_json}")
    return proc.returncode


def openclaw_json(raw: str) -> dict[str, Any]:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise PipelineApiError(f"OpenClaw did not return JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise PipelineApiError("OpenClaw returned non-object JSON")
    return payload


def execution_route(payload: dict[str, Any]) -> tuple[str | None, str | None, bool]:
    trace = (((payload.get("result") or {}).get("meta") or {}).get("executionTrace") or {})
    if not isinstance(trace, dict):
        return None, None, False
    provider = trace.get("winnerProvider")
    model = trace.get("winnerModel")
    return (
        str(provider) if provider else None,
        str(model) if model else None,
        trace.get("fallbackUsed") is True,
    )


def task_cost_budget(task: Mapping[str, Any]) -> int:
    raw = (((task.get("automation") or {}).get("budgets") or {}).get("maxCostNanodollars"))
    if isinstance(raw, bool) or not isinstance(raw, int) or raw < 0:
        raise PipelineApiError("task automation cost budget is unavailable or invalid")
    return raw


def cost_evidence_failures(
    task: Mapping[str, Any],
    observation: Mapping[str, Any],
    *,
    mode: str,
    requested_model: str | None,
) -> list[str]:
    failures: list[str] = []
    try:
        raw_cost = observation.get("costNanodollars")
        cost = int(raw_cost) if raw_cost is not None else None
        calls = int(observation.get("calls"))
    except (TypeError, ValueError):
        return ["cost_evidence_invalid"]
    providers = {str(value) for value in observation.get("providers") or []}
    origins = {str(value) for value in observation.get("origins") or []}
    requested_provider = str(requested_model or "").partition("/")[0]
    if calls < 1 or (cost is not None and cost < 0) or not re.fullmatch(r"[a-f0-9]{64}", str(observation.get("fingerprint") or "")):
        failures.append("cost_evidence_invalid")
    if requested_provider and providers != {requested_provider}:
        failures.append("cost_provider_mismatch")
    if mode != "local-zero":
        failures.append("paid_execution_disabled")
    if cost is not None and cost != 0:
        failures.append("local_zero_cost_nonzero")
    if origins:
        failures.append("local_zero_has_billed_origin")
    if cost is not None and cost > task_cost_budget(task):
        failures.append("cost_budget_exceeded")
    return failures


def cost_evidence_source() -> str:
    return "openclaw-local-provider-spend/v1"


def execution_route_validation_errors(
    requested_model: str | None,
    winner_provider: str | None,
    winner_model: str | None,
    fallback_used: bool,
) -> list[str]:
    """Validate the OpenClaw catalog identity used for this dispatch.

    An attested Pipeline dispatch intentionally asks OpenClaw for the reserved
    ``agentx-pipeline`` alias. Core maps that alias to the qualified effective
    model inside the operator-protected lease and revalidates it for every
    request. The OpenClaw receipt must therefore prove the requested alias,
    never pretend that it directly selected Core's effective model.
    """
    if not requested_model:
        return []
    expected_provider, separator, expected_model = requested_model.partition("/")
    errors: list[str] = []
    if not separator or (winner_provider, winner_model) != (
        expected_provider,
        expected_model,
    ):
        errors.append(
            "winner_route_mismatch:"
            f"expected={requested_model},actual={winner_provider}/{winner_model}"
        )
    if fallback_used:
        errors.append("fallback_used_for_explicit_model")
    return errors


def attested_execution_validation_errors(
    requested_model: str | None,
    winner_provider: str | None,
    winner_model: str | None,
    fallback_used: bool,
    attribution_lease: Mapping[str, Any] | None,
    cost_observation: Mapping[str, Any] | None,
) -> list[str]:
    """Bind alias attribution to server and canonical session evidence.

    OpenClaw's optional client ``executionTrace`` is useful corroboration, but
    older CLI responses may omit it. The server lease is authoritative because
    each alias request revalidates the live task and qualified effective model.
    Matching its closed request count to the canonical OpenClaw session proves
    that every observed inference call crossed that lease.
    """
    errors: list[str] = []
    if requested_model != PIPELINE_ATTRIBUTION_ALIAS:
        return ["attribution_requested_model_invalid"]
    if not isinstance(attribution_lease, Mapping):
        return ["attribution_lease_evidence_invalid"]
    effective_model = str(attribution_lease.get("effectiveModel") or "").strip()
    request_count = attribution_lease.get("requestCount")
    if (
        not effective_model
        or isinstance(request_count, bool)
        or not isinstance(request_count, int)
        or request_count < 1
    ):
        errors.append("attribution_lease_evidence_invalid")

    calls = cost_observation.get("calls") if isinstance(cost_observation, Mapping) else None
    if (
        isinstance(calls, bool)
        or not isinstance(calls, int)
        or calls < 1
        or not isinstance(request_count, int)
        or isinstance(request_count, bool)
        or request_count != calls
    ):
        errors.append(
            "attribution_request_count_mismatch:"
            f"expected={request_count if isinstance(request_count, int) and not isinstance(request_count, bool) else 'valid server count'},"
            f"actual={calls if isinstance(calls, int) and not isinstance(calls, bool) else 'unavailable'}"
        )

    models = {
        str(value)
        for value in (
            cost_observation.get("models")
            if isinstance(cost_observation, Mapping)
            else []
        ) or []
    }
    expected_session_model = PIPELINE_ATTRIBUTION_ALIAS.partition("/")[2]
    if models != {expected_session_model}:
        actual_models = ",".join(sorted(models)) or "unavailable"
        errors.append(
            "attribution_session_model_mismatch:"
            f"expected={expected_session_model},actual={actual_models}"
        )

    trace_present = winner_provider is not None or winner_model is not None
    if trace_present:
        errors.extend(
            execution_route_validation_errors(
                requested_model,
                winner_provider,
                winner_model,
                fallback_used,
            )
        )
    elif fallback_used:
        errors.append("fallback_used_for_explicit_model")
    return errors


def tool_names(payload: dict[str, Any]) -> set[str]:
    summary = (((payload.get("result") or {}).get("meta") or {}).get("toolSummary") or {})
    if not isinstance(summary, dict):
        return set()
    names = {
        str(name)
        for name in summary.get("tools") or []
        if isinstance(name, str)
    }
    by_tool = summary.get("byTool")
    if isinstance(by_tool, dict):
        names.update(str(name) for name in by_tool)
    return names


def worker_workspace(remote_repo: str, agent: str) -> PurePosixPath:
    repository = PurePosixPath(remote_repo)
    if not repository.is_absolute() or ".." in repository.parts:
        raise PipelineApiError("worker repository must be an absolute native workspace path")
    for parent in repository.parents:
        if parent.name == f"workspace-{agent}" and parent.parent.name == ".openclaw":
            return parent
    raise PipelineApiError("remote repository must be a child of the selected worker file-tool sandbox")


def remote_feedback_path(agent: str, task_id: str, remote_repo: str) -> str:
    return str(worker_workspace(remote_repo, agent) / f".agentx-feedback-{task_id}.md")


def feedback_text_validation_errors(
    text: str,
    *,
    allow_pending_independent: bool = False,
) -> list[str]:
    criteria = parse_criteria_verified(text)
    if not criteria:
        return ["worker feedback lacks a parseable criteria_verified JSON block"]
    identity_errors = criterion_identity_validation_errors(criteria)
    if identity_errors:
        return identity_errors
    allowed = set(PASS_STATUSES)
    if allow_pending_independent:
        allowed.update({"pending", "pending_independent"})
    failing = [
        entry.get("id")
        for entry in criteria
        if str(entry.get("status") or "").lower() not in allowed
    ]
    if failing:
        return [f"criteria_verified contains non-passing entries: {failing}"]
    return []


def append_dispatcher_verification(
    worker_text: str,
    *,
    command: str,
    output: str,
) -> str:
    return build_verified_feedback(worker_text, command=command, output=output,
                                   parse_criteria=parse_criteria_verified)
