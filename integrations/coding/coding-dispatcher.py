#!/usr/bin/env python3
"""Deterministic, fail-closed admission and one-shot coding dispatch.

Shadow mode is the default and performs no pipeline mutation, worker launch, Git
write, PR operation, scheduler change, merge, or deployment. Canary mode is
available only when both the reviewed configuration and the command line enable
it, and it delegates execution to the existing guarded ClawdX dispatcher.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import ssl
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlencode, urljoin, urlparse
from urllib.request import Request, urlopen

try:
    from integrations.coding import coding_dispatch_budget as dispatch_budget, coding_task_worktrees as task_worktrees
except ModuleNotFoundError:
    import coding_dispatch_budget as dispatch_budget
    import coding_task_worktrees as task_worktrees

CONFIG_SCHEMA = "agentx.coding-dispatcher-config/v1"
AUTOMATION_SCHEMA = "agentx.pipeline-automation/v1"
REPORT_SCHEMA = "agentx.coding-dispatcher-report/v1"
REQUIRED_HUMAN_GATES = frozenset({"review", "merge"})
DATA_CLASSIFICATIONS = frozenset({"public", "internal", "confidential", "restricted"})
CHANGE_OPERATIONS = frozenset({"create", "update", "delete"})
DEFAULT_CONFIG = Path(os.environ.get("AGENTX_CODING_CONFIG") or (
    str(Path(os.environ["AGENTX_INSTANCE_ROOT"]) / "config/coding-dispatcher.json")
    if os.environ.get("AGENTX_INSTANCE_ROOT") else str(Path.home() / ".config/agentx/coding-dispatcher.json")))
DEFAULT_GUARD = Path(__file__).resolve().with_name("clawdx-guarded-dispatch.py")


class DispatcherError(RuntimeError):
    """Fail-closed configuration, API, or admission error."""


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def isoformat(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_timestamp(value: Any) -> datetime | None:
    if value in (None, ""):
        return None
    text = str(value).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise DispatcherError(f"invalid ISO timestamp: {value!r}") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def stable_fingerprint(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def bounded_identifier(value: Any, name: str, maximum: int = 240) -> str:
    text = str(value or "").strip()
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:/-")
    if not text or len(text) > maximum or text[0] not in allowed or any(char not in allowed for char in text):
        raise DispatcherError(f"{name} must be a bounded identifier")
    return text


def repository_path(value: Any, name: str) -> str:
    text = str(value or "").strip()
    parts = text.split("/")
    if (
        not text
        or len(text) > 300
        or "\\" in text
        or any(ord(character) < 32 or ord(character) == 127 for character in text)
        or text.startswith("/")
        or (len(text) > 1 and text[1] == ":")
        or any(part in ("", ".", "..") for part in parts)
    ):
        raise DispatcherError(f"{name} must be an unambiguous repository-relative POSIX path")
    return text


def unique_sorted(values: Any, name: str, normalize, *, minimum: int = 1, maximum: int = 64) -> list[str]:
    if not isinstance(values, list) or not minimum <= len(values) <= maximum:
        raise DispatcherError(f"{name} must contain between {minimum} and {maximum} entries")
    normalized = [normalize(value, f"{name}[{index}]") for index, value in enumerate(values)]
    if len(set(normalized)) != len(normalized):
        raise DispatcherError(f"{name} must not contain duplicates")
    return sorted(normalized)


def bounded_integer(value: Any, name: str, *, minimum: int, maximum: int) -> int:
    if isinstance(value, bool):
        raise DispatcherError(f"{name} must be an integer")
    try:
        normalized = int(value)
    except (TypeError, ValueError) as exc:
        raise DispatcherError(f"{name} must be an integer") from exc
    if normalized != value or not minimum <= normalized <= maximum:
        raise DispatcherError(f"{name} must be between {minimum} and {maximum}")
    return normalized


def normalize_automation(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise DispatcherError("automation intent is absent or not an object")
    if raw.get("schema") != AUTOMATION_SCHEMA:
        raise DispatcherError(f"automation.schema must be {AUTOMATION_SCHEMA}")
    mode = str(raw.get("mode") or "").strip()
    if mode == "manual":
        normalized = {"schema": AUTOMATION_SCHEMA, "mode": "manual"}
    elif mode == "review_only":
        budgets_raw = raw.get("budgets")
        if not isinstance(budgets_raw, dict):
            raise DispatcherError("automation.budgets must be an object")
        data_classification = bounded_identifier(
            raw.get("dataClassification"), "automation.dataClassification", 80
        )
        if data_classification not in DATA_CLASSIFICATIONS:
            raise DispatcherError("automation.dataClassification is unsupported")
        operations = unique_sorted(
            raw.get("operations"),
            "automation.operations",
            lambda value, name: bounded_identifier(value, name, 40),
            maximum=len(CHANGE_OPERATIONS),
        )
        if any(operation not in CHANGE_OPERATIONS for operation in operations):
            raise DispatcherError("automation.operations contains an unsupported operation")
        human_gates = unique_sorted(
            raw.get("humanGates"),
            "automation.humanGates",
            lambda value, name: bounded_identifier(value, name, 80),
            minimum=2,
            maximum=4,
        )
        if not REQUIRED_HUMAN_GATES.issubset(human_gates):
            raise DispatcherError("automation.humanGates must include review and merge")
        normalized = {
            "schema": AUTOMATION_SCHEMA,
            "mode": mode,
            "policyRef": bounded_identifier(raw.get("policyRef"), "automation.policyRef"),
            "dataClassification": data_classification,
            "operations": operations,
            "scope": unique_sorted(
                raw.get("scope"), "automation.scope", repository_path, maximum=30
            ),
            "lockKeys": unique_sorted(
                raw.get("lockKeys"),
                "automation.lockKeys",
                lambda value, name: bounded_identifier(value, name),
                maximum=30,
            ),
            "executionProfile": bounded_identifier(
                raw.get("executionProfile"), "automation.executionProfile"
            ),
            "verificationProfile": bounded_identifier(
                raw.get("verificationProfile"), "automation.verificationProfile"
            ),
            "budgets": {
                "maxDurationMs": bounded_integer(
                    budgets_raw.get("maxDurationMs"),
                    "automation.budgets.maxDurationMs",
                    minimum=1,
                    maximum=604_800_000,
                ),
                "maxAttempts": bounded_integer(
                    budgets_raw.get("maxAttempts"),
                    "automation.budgets.maxAttempts",
                    minimum=1,
                    maximum=10,
                ),
                "maxCostNanodollars": bounded_integer(
                    budgets_raw.get("maxCostNanodollars"),
                    "automation.budgets.maxCostNanodollars",
                    minimum=0,
                    maximum=9_000_000_000_000_000,
                ),
            },
            "humanGates": human_gates,
        }
        if raw.get("sourceFiles") is not None:
            normalized["sourceFiles"] = unique_sorted(
                raw.get("sourceFiles"),
                "automation.sourceFiles",
                repository_path,
                maximum=30,
            )
    else:
        raise DispatcherError("automation.mode must be manual or review_only")

    computed = stable_fingerprint(normalized)
    supplied = str(raw.get("fingerprint") or "").strip()
    if supplied and supplied != computed:
        raise DispatcherError("automation fingerprint does not match normalized intent")
    return {**normalized, "fingerprint": computed}


def path_matches_prefix(path: str, prefix: str) -> bool:
    normalized = prefix.rstrip("/")
    return path == normalized or path.startswith(normalized + "/")


def load_config(path: Path) -> dict[str, Any]:
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DispatcherError(f"cannot load dispatcher config {path}: {exc}") from exc
    if not isinstance(config, dict) or config.get("schema") != CONFIG_SCHEMA:
        raise DispatcherError(f"config.schema must be {CONFIG_SCHEMA}")
    if not isinstance(config.get("enabled"), bool):
        raise DispatcherError("config.enabled must be boolean")
    if config.get("defaultMode") != "shadow":
        raise DispatcherError("config.defaultMode must remain shadow in v1")
    if bounded_integer(config.get("maxConcurrent"), "config.maxConcurrent", minimum=1, maximum=1) != 1:
        raise DispatcherError("v1 supports exactly one concurrent autonomous worker")
    bounded_integer(config.get("maxCandidates"), "config.maxCandidates", minimum=1, maximum=1000)
    for key in ("policies", "executionProfiles", "verificationProfiles"):
        if not isinstance(config.get(key), dict):
            raise DispatcherError(f"config.{key} must be an object")
    return config


class PipelineClient:
    def __init__(self, api_base: str, *, ca_file: str | None = None, timeout: int = 20):
        self.api_base = api_base.rstrip("/") + "/"
        self.timeout = timeout
        parsed = urlparse(self.api_base)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise DispatcherError("apiBase must be an absolute HTTP(S) URL")
        self.origin = f"{parsed.scheme}://{parsed.netloc}"
        self.context = None
        if parsed.scheme == "https":
            self.context = ssl.create_default_context(cafile=ca_file or None)

    def request_json(self, path: str) -> dict[str, Any]:
        request = Request(
            urljoin(self.api_base, path.lstrip("/")),
            headers={
                "Accept": "application/json",
                "Origin": self.origin,
                "Referer": self.origin + "/pipeline",
                "Sec-Fetch-Site": "same-origin",
            },
            method="GET",
        )
        try:
            with urlopen(request, timeout=self.timeout, context=self.context) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except Exception as exc:
            raise DispatcherError(f"pipeline read failed: {type(exc).__name__}: {exc}") from exc
        if not isinstance(payload, dict) or payload.get("ok") is not True:
            raise DispatcherError("pipeline returned an invalid or unsuccessful envelope")
        return payload

    def list_tasks(self, limit: int) -> list[dict[str, Any]]:
        query = urlencode({"includeDone": "true", "limit": str(limit), "view": "summary"})
        payload = self.request_json(f"/api/pipeline/tasks?{query}")
        tasks = payload.get("data", {}).get("tasks")
        if not isinstance(tasks, list) or any(not isinstance(task, dict) for task in tasks):
            raise DispatcherError("pipeline task envelope is missing data.tasks")
        evidence = payload.get("data", {}).get("evidence")
        if not isinstance(evidence, dict) or not isinstance(evidence.get("rows"), dict):
            raise DispatcherError("pipeline task envelope is missing bounded list evidence")
        if evidence["rows"].get("truncated") is not False:
            raise DispatcherError("pipeline task list is truncated; autonomous admission cannot prove dependency state")
        return tasks


def load_tasks_file(path: Path) -> list[dict[str, Any]]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DispatcherError(f"cannot load tasks fixture {path}: {exc}") from exc
    if isinstance(payload, list):
        tasks = payload
    else:
        tasks = payload.get("data", {}).get("tasks") if isinstance(payload, dict) else None
    if not isinstance(tasks, list) or any(not isinstance(task, dict) for task in tasks):
        raise DispatcherError("tasks fixture must be a list or an AgentX data.tasks envelope")
    return tasks


def reason(code: str, detail: str) -> dict[str, str]:
    return {"code": code, "detail": detail}


def task_sort_key(task: dict[str, Any]) -> tuple[Any, ...]:
    priority = task.get("priority") if isinstance(task.get("priority"), int) else 3
    due_at = str(task.get("dueAt") or "9999-12-31T23:59:59Z")
    return priority, due_at, str(task.get("pipelineId") or "")


def task_is_private(task: dict[str, Any]) -> bool:
    service = str(task.get("service") or "").strip().lower()
    source = str(task.get("source") or "").strip().lower()
    return (
        service in {"personal", "family"}
        or source == "idea-drop"
        or source.startswith("household-")
    )


def active_automation_state(tasks: list[dict[str, Any]]) -> tuple[int, set[str]]:
    active_count = 0
    active_locks: set[str] = set()
    for task in tasks:
        if task.get("status") != "in_progress":
            continue
        try:
            automation = normalize_automation(task.get("automation"))
        except DispatcherError:
            continue
        if automation.get("mode") != "review_only":
            continue
        active_count += 1
        active_locks.update(automation.get("lockKeys") or [])
    return active_count, active_locks


def evaluate_task(
    task: dict[str, Any],
    *,
    config: dict[str, Any],
    statuses: dict[str, str],
    active_count: int,
    active_locks: set[str],
    now: datetime,
) -> dict[str, Any]:
    reasons: list[dict[str, str]] = []
    try:
        automation = normalize_automation(task.get("automation"))
    except DispatcherError as exc:
        automation = None
        reasons.append(reason("automation_invalid", str(exc)))

    if task.get("status") != "queued" or task.get("assignee") not in (None, ""):
        reasons.append(reason("task_unavailable", "task is not queued and unassigned"))
    if str(task.get("risk") or "").lower() != "low":
        reasons.append(reason("risk_not_low", "autonomous coding requires explicit low risk"))

    not_before = parse_timestamp(task.get("notBefore"))
    if not_before and not_before > now:
        reasons.append(reason("not_before", f"task is deferred until {isoformat(not_before)}"))
    incomplete = [
        str(dependency)
        for dependency in task.get("dependsOn") or []
        if statuses.get(str(dependency)) != "done"
    ]
    if incomplete:
        reasons.append(reason("dependencies_incomplete", "incomplete dependencies: " + ",".join(incomplete)))

    policy = None
    if automation:
        if automation.get("mode") != "review_only":
            reasons.append(reason("automation_manual", "task is explicitly manual-only"))
        else:
            policy = config["policies"].get(automation["policyRef"])
            if not isinstance(policy, dict):
                reasons.append(reason("policy_unknown", "policyRef is not configured in this AgentX instance"))

    if policy:
        if policy.get("repository") != "agentx":
            reasons.append(reason("repository_not_canonical", "retarget the task explicitly to AgentX before dispatch"))
        required_fields = {
            "repository",
            "allowedPathPrefixes",
            "protectedPathPrefixes",
            "allowedDataClassifications",
            "allowedOperations",
            "executionProfiles",
            "verificationProfiles",
            "ceilings",
            "requireAuthoritySources",
        }
        missing = sorted(required_fields - set(policy))
        if missing:
            reasons.append(reason("policy_invalid", "missing policy fields: " + ",".join(missing)))
        else:
            ceilings = policy.get("ceilings") or {}
            source_files = automation.get("sourceFiles") or []
            if policy.get("requireAuthoritySources") is not True:
                reasons.append(reason(
                    "policy_invalid",
                    "requireAuthoritySources must be true for autonomous coding",
                ))
            elif not source_files:
                reasons.append(reason(
                    "authority_sources_missing",
                    "autonomous coding requires explicit repository authority source files",
                ))
            elif len(source_files) > int(ceilings.get("maxSourceFiles", 0)):
                reasons.append(reason(
                    "authority_sources_too_large",
                    "authority source files exceed the policy ceiling",
                ))
            if automation["dataClassification"] not in policy["allowedDataClassifications"]:
                reasons.append(reason("data_classification_denied", "policy does not allow this data classification"))
            denied_operations = sorted(set(automation["operations"]) - set(policy["allowedOperations"]))
            if denied_operations:
                reasons.append(reason("operation_denied", "disallowed operations: " + ",".join(denied_operations)))
            if automation["executionProfile"] not in policy["executionProfiles"]:
                reasons.append(reason("execution_profile_denied", "execution profile is not allowlisted by policy"))
            if automation["verificationProfile"] not in policy["verificationProfiles"]:
                reasons.append(reason("verification_profile_denied", "verification profile is not allowlisted by policy"))
            if automation["executionProfile"] not in config["executionProfiles"]:
                reasons.append(reason("execution_profile_missing", "execution profile has no configured adapter"))
            else:
                execution_profile = config["executionProfiles"][automation["executionProfile"]]
                cost_mode = str(execution_profile.get("costEvidenceMode") or "")
                cost_budget = automation["budgets"]["maxCostNanodollars"]
                if cost_mode == "local-zero":
                    if cost_budget != 0:
                        reasons.append(reason(
                            "cost_budget_mode_mismatch",
                            "local-zero execution requires maxCostNanodollars=0",
                        ))
                    if execution_profile.get("model") != "ollama/agentx-pipeline" \
                            or execution_profile.get("attestAttribution") is not True:
                        reasons.append(reason(
                            "execution_profile_invalid",
                            "local-zero execution must use the attested AgentX Pipeline alias",
                        ))
                else:
                    reasons.append(reason(
                        "paid_execution_disabled",
                        "live paid execution requires a future broker-validated SpendGrant contract",
                    ))
            if automation["verificationProfile"] not in config["verificationProfiles"]:
                reasons.append(reason("verification_profile_missing", "verification profile has no configured verifier"))

            scope = automation["scope"]
            if len(scope) > int(ceilings.get("maxScopeFiles", 0)):
                reasons.append(reason("scope_too_large", "scope exceeds the policy file ceiling"))
            outside = [
                path for path in scope
                if not any(path_matches_prefix(path, prefix) for prefix in policy["allowedPathPrefixes"])
            ]
            if outside:
                reasons.append(reason("scope_not_allowlisted", "paths outside allowlist: " + ",".join(outside)))
            protected = [
                path for path in scope
                if any(path_matches_prefix(path, prefix) for prefix in policy["protectedPathPrefixes"])
            ]
            if protected:
                reasons.append(reason("protected_scope", "protected paths: " + ",".join(protected)))

            budgets = automation["budgets"]
            for field in ("maxDurationMs", "maxAttempts", "maxCostNanodollars"):
                if budgets[field] > int(ceilings.get(field, -1)):
                    reasons.append(reason("budget_exceeds_policy", f"{field} exceeds policy ceiling"))
            if int(task.get("automationAttemptCount") or 0) >= budgets["maxAttempts"]:
                reasons.append(reason("attempt_budget_exhausted", "maximum autonomous attempts reached"))

            conflicts = sorted(set(automation["lockKeys"]) & active_locks)
            if conflicts:
                reasons.append(reason("resource_lock_conflict", "active locks: " + ",".join(conflicts)))

    if active_count >= config["maxConcurrent"]:
        reasons.append(reason("concurrency_limit", "the v1 autonomous worker slot is occupied"))

    return {
        "pipelineId": str(task.get("pipelineId") or ""),
        "title": str(task.get("title") or "")[:160],
        "admissible": not reasons,
        "policyRef": automation.get("policyRef") if automation else None,
        "repository": policy.get("repository") if policy else None,
        "scope": automation.get("scope", []) if automation else [],
        "sourceFiles": automation.get("sourceFiles", []) if automation else [],
        "lockKeys": automation.get("lockKeys", []) if automation else [],
        "reasons": reasons,
    }


@dataclass(frozen=True)
class DispatchResult:
    adapter: str
    exit_code: int


class WorkerAdapter:
    name = "abstract"

    def run(self, task: dict[str, Any], automation: dict[str, Any]) -> DispatchResult:
        raise NotImplementedError


class ClawdXGuardedAdapter(WorkerAdapter):
    name = "clawdx-guarded"

    def __init__(
        self,
        *,
        execution_profile: dict[str, Any],
        verification_profile: dict[str, Any],
        guard_path: Path = DEFAULT_GUARD,
    ):
        self.execution = execution_profile
        self.verification = verification_profile
        self.guard_path = guard_path

    def command(self, task: dict[str, Any], automation: dict[str, Any]) -> list[str]:
        required_execution = {
            "pipelineApiBase",
            "host",
            "remoteRepo",
            "agent",
            "workerHelper",
            "costEvidenceMode",
            "localEnergyEvidence",
            "telegramNotifications",
        }
        missing_execution = sorted(required_execution - set(self.execution))
        if missing_execution:
            raise DispatcherError("execution profile missing: " + ",".join(missing_execution))
        remote_repo, agent = task_worktrees.reviewed_profile(self.execution, DispatcherError)

        command = [
            sys.executable,
            str(self.guard_path),
            "--api-base",
            str(self.execution["pipelineApiBase"]),
            "--task-id",
            str(task["pipelineId"]),
            "--host",
            str(self.execution["host"]),
            "--remote-repo",
            remote_repo,
            "--agent",
            agent,
            "--worker-helper",
            str(self.execution["workerHelper"]),
            "--max-changed-files",
            str(self.verification["maxChangedFiles"]),
            "--max-changed-bytes",
            str(self.verification["maxChangedBytes"]),
            "--independent-verification-command",
            str(self.verification["command"]),
            "--independent-verification-timeout",
            str(self.verification["timeoutSeconds"]),
            "--timeout",
            str(dispatch_budget.worker_timeout(self.execution, automation)),
            "--automated-lease",
            "--lease-duration-ms",
            str(automation["budgets"]["maxDurationMs"]),
            "--cost-evidence-mode",
            str(self.execution["costEvidenceMode"]),
            "--allow-dispatch",
            *(["--task-worktree"] if self.execution.get("taskWorktree") else []),
        ]
        repair_turns = self.verification.get("repairTurns", 0)
        if type(repair_turns) is not int or repair_turns not in (0, 1):
            raise DispatcherError("verification repairTurns must be 0 or 1")
        if repair_turns:
            command.extend(["--verification-repair-turns", "1"])
        energy = self.execution["localEnergyEvidence"]
        if not isinstance(energy, dict) or energy.get("measurementScope") != "gpu-incremental-lower-bound":
            raise DispatcherError("localEnergyEvidence must use gpu-incremental-lower-bound")
        meter_host = str(energy.get("meterHost") or "").strip()
        gpu_indices = energy.get("gpuIndices")
        if not meter_host or not isinstance(gpu_indices, list) or not gpu_indices:
            raise DispatcherError("localEnergyEvidence requires a meterHost and gpuIndices")
        command.extend([
            "--energy-meter-host",
            meter_host,
            "--energy-baseline-seconds",
            str(energy.get("baselineSeconds", 10)),
            "--energy-sample-interval-seconds",
            str(energy.get("sampleIntervalSeconds", 1)),
        ])
        for gpu_index in gpu_indices:
            if not isinstance(gpu_index, int) or isinstance(gpu_index, bool) or gpu_index < 0:
                raise DispatcherError("localEnergyEvidence gpuIndices must be non-negative integers")
            command.extend(["--energy-gpu-index", str(gpu_index)])
        tariff_currency = energy.get("tariffCurrency")
        tariff_rate = energy.get("tariffRateNanoCurrencyUnitsPerKwh")
        if (tariff_currency is None) != (tariff_rate is None):
            raise DispatcherError("localEnergyEvidence tariff currency and rate must be configured together")
        if tariff_currency is not None:
            command.extend([
                "--electricity-tariff-currency",
                str(tariff_currency),
                "--electricity-tariff-rate-nano-per-kwh",
                str(tariff_rate),
            ])
        notifications = self.execution["telegramNotifications"]
        if not isinstance(notifications, dict) or not str(notifications.get("uiBase") or "").strip():
            raise DispatcherError("telegramNotifications requires an explicit uiBase")
        command.extend(["--telegram-ui-base", str(notifications["uiBase"])])
        if notifications.get("enabled") is True:
            command.append("--telegram-notifications")
        if self.execution.get("model"):
            command.extend(["--model", str(self.execution["model"])])
        if self.execution.get("repository"):
            command.extend(["--repository", str(self.execution["repository"])])
        if self.execution.get("sourceRepo"):
            command.extend(["--source-repo", str(self.execution["sourceRepo"])])
        if self.execution.get("thinking"):
            command.extend(["--thinking", str(self.execution["thinking"])])
        if self.execution.get("attestAttribution") is True:
            command.extend([
                "--attest-attribution",
                "--attribution-attempt",
                str(int(task.get("automationAttemptCount") or 0) + 1),
            ])
        for path in automation["scope"]:
            command.extend(["--allowed-path", path])
        if int(task.get("automationAttemptCount") or 0) > 0:
            command.append("--repair-attempt")
        return command

    def run(self, task: dict[str, Any], automation: dict[str, Any]) -> DispatchResult:
        try:
            timeout = dispatch_budget.dispatcher_timeout(self.execution, self.verification, automation)
            exit_code = dispatch_budget.run_guard(self.command(task, automation), timeout)
            return DispatchResult(adapter=self.name, exit_code=exit_code)
        except ValueError as exc:
            raise DispatcherError(str(exc)) from exc


def build_adapter(
    *,
    config: dict[str, Any],
    automation: dict[str, Any],
    guard_path: Path = DEFAULT_GUARD,
) -> WorkerAdapter:
    execution = config["executionProfiles"].get(automation["executionProfile"])
    verification = config["verificationProfiles"].get(automation["verificationProfile"])
    if not isinstance(execution, dict) or not isinstance(verification, dict):
        raise DispatcherError("selected execution or verification profile is missing")
    adapter = execution.get("adapter")
    if adapter != "clawdx-guarded":
        raise DispatcherError(f"unsupported worker adapter: {adapter!r}")
    return ClawdXGuardedAdapter(
        execution_profile={**execution, "repository": config["policies"][automation["policyRef"]]["repository"]},
        verification_profile=verification,
        guard_path=guard_path,
    )


def build_report(
    tasks: list[dict[str, Any]],
    *,
    config: dict[str, Any],
    mode: str,
    now: datetime,
) -> dict[str, Any]:
    scoped_tasks = [
        task for task in tasks
        if not task_is_private(task)
    ]
    statuses = {
        str(task.get("pipelineId") or ""): str(task.get("status") or "")
        for task in scoped_tasks
    }
    active_count, active_locks = active_automation_state(scoped_tasks)
    queued = sorted(
        (task for task in scoped_tasks if task.get("status") == "queued"),
        key=task_sort_key,
    )
    decisions = [
        evaluate_task(
            task,
            config=config,
            statuses=statuses,
            active_count=active_count,
            active_locks=active_locks,
            now=now,
        )
        for task in queued
    ]
    admissible = sum(1 for decision in decisions if decision["admissible"])
    return {
        "schema": REPORT_SCHEMA,
        "observedAt": isoformat(now),
        "mode": mode,
        "configurationEnabled": config["enabled"],
        "mutationAuthorized": False,
        "summary": {
            "observedTasks": len(scoped_tasks),
            "excludedPrivateTasks": len(tasks) - len(scoped_tasks),
            "queuedTasks": len(queued),
            "admissibleTasks": admissible,
            "manualOrIneligibleTasks": len(decisions) - admissible,
            "activeAutomatedTasks": active_count,
            "maxConcurrent": config["maxConcurrent"],
        },
        "decisions": decisions,
        "dispatch": {
            "attempted": False,
            "reason": "shadow_mode" if mode == "shadow" else "awaiting_canary_gate",
        },
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="AgentX coding admission and guarded one-shot dispatcher")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--mode", choices=["shadow", "canary"])
    parser.add_argument("--task-id", help="Required exact pipeline id for canary mode")
    parser.add_argument(
        "--select-first-admissible",
        action="store_true",
        help="Select exactly the first admissible queued task in deterministic order",
    )
    parser.add_argument("--allow-dispatch", action="store_true", help="Required second gate for canary execution")
    parser.add_argument("--tasks-file", type=Path, help="Offline task list/envelope for deterministic checks")
    parser.add_argument("--ca-file", default=os.environ.get("AGENTX_CA_FILE"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        config = load_config(args.config.resolve())
        mode = args.mode or config["defaultMode"]
        if args.tasks_file:
            tasks = load_tasks_file(args.tasks_file.resolve())
        else:
            client = PipelineClient(config["apiBase"], ca_file=args.ca_file)
            tasks = client.list_tasks(config["maxCandidates"])
        now = utc_now()
        report = build_report(tasks, config=config, mode=mode, now=now)

        if mode == "shadow":
            print(json.dumps(report, indent=2, sort_keys=True))
            return 0
        if not config["enabled"]:
            raise DispatcherError("canary dispatch is disabled by reviewed configuration")
        if not args.allow_dispatch:
            raise DispatcherError("canary dispatch requires --allow-dispatch")
        if bool(args.task_id) == bool(args.select_first_admissible):
            raise DispatcherError(
                "canary dispatch requires exactly one of --task-id or --select-first-admissible"
            )

        selected_task_id = args.task_id
        if args.select_first_admissible:
            selected = next(
                (item for item in report["decisions"] if item["admissible"]),
                None,
            )
            if selected is None:
                report["dispatch"] = {
                    "attempted": False,
                    "reason": "no_admissible_task",
                }
                print(json.dumps(report, indent=2, sort_keys=True))
                return 0
            selected_task_id = selected["pipelineId"]

        decision = next(
            (item for item in report["decisions"] if item["pipelineId"] == selected_task_id),
            None,
        )
        if not decision:
            raise DispatcherError(f"canary task {selected_task_id} is not queued")
        if not decision["admissible"]:
            codes = ",".join(item["code"] for item in decision["reasons"])
            raise DispatcherError(f"canary task {selected_task_id} is not admissible: {codes}")
        task = next(task for task in tasks if str(task.get("pipelineId")) == selected_task_id)
        automation = normalize_automation(task.get("automation"))
        adapter = build_adapter(config=config, automation=automation)
        result = adapter.run(task, automation)
        report["mutationAuthorized"] = True
        report["dispatch"] = {
            "attempted": True,
            "taskId": selected_task_id,
            "adapter": result.adapter,
            "exitCode": result.exit_code,
            "stoppedAt": dispatch_budget.stopped_at(result.exit_code),
        }
        print(json.dumps(report, indent=2, sort_keys=True))
        return result.exit_code if result.exit_code in {0, dispatch_budget.DEFERRED_EXIT, dispatch_budget.UNKNOWN_EXIT} else 3
    except DispatcherError as exc:
        print(json.dumps({"schema": REPORT_SCHEMA, "ok": False, "error": str(exc)}, sort_keys=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
