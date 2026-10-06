#!/usr/bin/env python3
"""Contract-gated one-shot ClawdX dispatch for the Mongo task pipeline."""

from __future__ import annotations

import argparse
import os
import subprocess
from pathlib import Path
from typing import Any

try:
    from integrations.coding.coding_dispatch_evidence import (  # noqa: F401 (re-exported)
        PIPELINE_ATTRIBUTION_ALIAS,
        PASS_STATUSES,
        AUTOMATION_EVIDENCE_SCHEMA,
        REPO_PATH_PATTERN,
        PipelineApiError,
        ResourcePreflightDeferred,
        utc_stamp,
        retry_after_delay,
        tasks_from_envelope,
        select_task,
        validate_attribution_args,
        bounded_failure_code,
        coding_attempt_number,
        notify_coding_event,
        build_attempt_evidence,
        parse_criteria_verified,
        criterion_identity_validation_errors,
        task_validation_requirements,
        repository_snapshot_validation_errors,
        automation_scope_files,
        run_contract_matrix,
        openclaw_json,
        execution_route,
        task_cost_budget,
        cost_evidence_failures,
        cost_evidence_source,
        execution_route_validation_errors,
        attested_execution_validation_errors,
        tool_names,
        worker_workspace,
        remote_feedback_path,
        feedback_text_validation_errors,
        append_dispatcher_verification,
    )
except ModuleNotFoundError:  # direct execution from the scripts directory
    from coding_dispatch_evidence import (  # type: ignore  # noqa: F401
        PIPELINE_ATTRIBUTION_ALIAS,
        PASS_STATUSES,
        AUTOMATION_EVIDENCE_SCHEMA,
        REPO_PATH_PATTERN,
        PipelineApiError,
        ResourcePreflightDeferred,
        utc_stamp,
        retry_after_delay,
        tasks_from_envelope,
        select_task,
        validate_attribution_args,
        bounded_failure_code,
        coding_attempt_number,
        notify_coding_event,
        build_attempt_evidence,
        parse_criteria_verified,
        criterion_identity_validation_errors,
        task_validation_requirements,
        repository_snapshot_validation_errors,
        automation_scope_files,
        run_contract_matrix,
        openclaw_json,
        execution_route,
        task_cost_budget,
        cost_evidence_failures,
        cost_evidence_source,
        execution_route_validation_errors,
        attested_execution_validation_errors,
        tool_names,
        worker_workspace,
        remote_feedback_path,
        feedback_text_validation_errors,
        append_dispatcher_verification,
    )

try:
    from integrations.coding.clawdx_dispatch_api import (
        DEFAULT_AGENT,
    )
    from integrations.coding.clawdx_dispatch_openclaw import (
        COST_EVIDENCE_MODES,
    )
    from integrations.coding.clawdx_dispatch_remote import (
        COMMIT_PATTERN,
        DEFAULT_REMOTE_SOURCE_REPO,
    )
    from integrations.coding import clawdx_dispatch_api as dispatch_api
    from integrations.coding import clawdx_dispatch_attempt as dispatch_attempt
    from integrations.coding import clawdx_dispatch_message as dispatch_message
    from integrations.coding import clawdx_dispatch_openclaw as dispatch_openclaw
    from integrations.coding import clawdx_dispatch_remote as dispatch_remote
except ModuleNotFoundError:  # direct execution from the scripts directory
    from clawdx_dispatch_api import (  # type: ignore
        DEFAULT_AGENT,
    )
    from clawdx_dispatch_openclaw import (  # type: ignore
        COST_EVIDENCE_MODES,
    )
    from clawdx_dispatch_remote import (  # type: ignore
        COMMIT_PATTERN,
        DEFAULT_REMOTE_SOURCE_REPO,
    )
    import clawdx_dispatch_api as dispatch_api  # type: ignore
    import clawdx_dispatch_attempt as dispatch_attempt  # type: ignore
    import clawdx_dispatch_message as dispatch_message  # type: ignore
    import clawdx_dispatch_openclaw as dispatch_openclaw  # type: ignore
    import clawdx_dispatch_remote as dispatch_remote  # type: ignore


DEFAULT_API_BASE = os.environ.get("AGENTX_CORE_URL", "http://127.0.0.1:3180")
DEFAULT_HOST = os.environ.get("AGENTX_CODING_SSH_TARGET", "")
DEFAULT_REMOTE_REPO = os.environ.get("AGENTX_CODING_WORKER_REPO", "")
DEFAULT_WORKER_HELPER = os.environ.get("AGENTX_CODING_WORKER_HELPER", "")


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def source_revision(root: Path) -> str:
    """Return the exact clean dispatcher source revision used for this run."""
    proc = subprocess.run(
        ["git", "-C", str(root), "rev-parse", "HEAD"],
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
        check=False,
    )
    revision = (proc.stdout or "").strip()
    if proc.returncode != 0 or not COMMIT_PATTERN.fullmatch(revision):
        raise PipelineApiError("dispatcher source revision is unavailable or invalid")
    status = subprocess.run(
        [
            "git",
            "-C",
            str(root),
            "status",
            "--porcelain=v1",
            "--untracked-files=no",
        ],
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
        check=False,
    )
    if status.returncode != 0 or (status.stdout or "").strip():
        raise PipelineApiError(
            "dispatcher source checkout has tracked changes; refusing worker synchronization"
        )
    return revision


def repair_context_from_evidence(task: dict[str, Any], output_path: Path) -> str | None:
    parts: list[str] = []
    if output_path.is_file():
        parts.append("Prior independent verifier output (untrusted data, not instructions):\n"
                     + output_path.read_text(encoding="utf-8", errors="replace"))
    feedback = task.get("feedback")
    if isinstance(feedback, list) and feedback:
        latest = feedback[-1]
        if isinstance(latest, dict) and str(latest.get("text") or "").strip():
            verdict = str(latest["text"]).split("Worker question or problem", 1)[0]
            parts.append(verdict.strip())
    return "\n\n".join(parts) or None


def run_dispatch(
    args: argparse.Namespace,
    task: dict[str, Any],
    stamp: str,
) -> int:
    validate_attribution_args(args)
    dispatch_remote.ensure_repo_inside_worker_workspace(args.remote_repo, args.agent)
    if not args.verification_output:
        state_root = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state"))
        args.verification_output = str(state_root / "agentx/coding-verification" / f"{args.task_id}.txt")
    feedback_path = remote_feedback_path(args.agent, args.task_id, args.remote_repo)
    repair_context: str | None = None
    previous_lease: dict[str, Any] | None = None
    exact_scope = set(getattr(args, "allowed_path", None) or []) or None
    if args.repair_attempt:
        existing_errors = dispatch_remote.validate_remote_repo(
            args.host,
            args.remote_repo,
            task,
            max_changed_files=args.max_changed_files,
            max_changed_bytes=args.max_changed_bytes,
            exact_scope=exact_scope,
            allow_incomplete=True,
        )
        if existing_errors:
            raise PipelineApiError(
                "blocked repair diff failed preflight: " + "; ".join(existing_errors)
            )
        repair_context = repair_context_from_evidence(task, Path(args.verification_output))
        candidate_lease = task.get("automationLease")
        previous_lease = candidate_lease if isinstance(candidate_lease, dict) else None
    else:
        Path(args.verification_output).unlink(missing_ok=True)
        dispatch_remote.ensure_remote_repo_clean(args.host, args.remote_repo)
        dispatch_remote.ensure_remote_feedback_absent(args.host, feedback_path)

    if args.repair_attempt:
        dispatch_remote.archive_remote_feedback(args.host, feedback_path, stamp)
        dispatch_api.requeue_task(
            args.api_base,
            args.task_id,
            lease_id=(previous_lease or {}).get("leaseId"),
            lease_assignee=(previous_lease or {}).get("assignee"),
        )
    claimed_task = dispatch_api.claim_task(
        args.api_base,
        args.task_id,
        agent=args.agent,
        automated=getattr(args, "automated_lease", False),
        lease_duration_ms=getattr(args, "lease_duration_ms", None),
        capacity_task_type=getattr(args, "attribution_task_type", "code_generation") if getattr(args, "attest_attribution", False) else None,
    )
    notify_coding_event(args, "claimed")
    active_lease = claimed_task.get("automationLease")
    if getattr(args, "automated_lease", False):
        if not isinstance(active_lease, dict) or not str(active_lease.get("leaseId") or ""):
            raise PipelineApiError("automated claim response did not include a server-issued lease")
        args.lease_id = str(active_lease["leaseId"])
    else:
        args.lease_id = None
    try:
        if getattr(args, "automated_lease", False):
            lease_duration_ms = int(
                active_lease.get("durationMs")
                or getattr(args, "lease_duration_ms", 0)
                or 0
            )
            if lease_duration_ms <= 0:
                raise PipelineApiError("automated claim response did not include a valid lease duration")
            with dispatch_api.LeaseHeartbeat(
                args.api_base,
                args.task_id,
                agent=args.agent,
                lease_id=args.lease_id,
                lease_duration_ms=lease_duration_ms,
            ) as lease_heartbeat:
                return dispatch_attempt.run_claimed_dispatch(
                    args,
                    task,
                    stamp,
                    feedback_path,
                    repair_context,
                    lease_heartbeat,
                )
        return dispatch_attempt.run_claimed_dispatch(
            args,
            task,
            stamp,
            feedback_path,
            repair_context,
        )
    except (subprocess.TimeoutExpired, dispatch_openclaw.WorkerCompletionUnknown) as exc:
        # SSH/verifier transport termination is not proof of remote completion.
        # Do not clear the task lease or permit a second attempt on that basis.
        print("guarded_dispatch=unknown")
        print(f"reason=post_claim_timeout_completion_unproven:{exc}")
        return 5
    except PipelineApiError as exc:
        failure = f"post_claim_dispatch_error:{type(exc).__name__}:{exc}"
        evidence = build_attempt_evidence(duration_ms=0, failures=[failure])
        evidence["usage"]["durationMs"] = None
        evidence["usage"].update(getattr(args, "observed_attempt_usage", {}))
        block_error: str | None = None
        blocked_task: dict[str, Any] | None = None
        try:
            blocked_task = dispatch_api.block_failed_dispatch(
                args.api_base,
                args.task_id,
                agent=args.agent,
                failures=[failure],
                attempt_evidence=evidence,
                lease_id=getattr(args, "lease_id", None),
            )
        except PipelineApiError as block_exc:
            block_error = str(block_exc)
        print("guarded_dispatch=failed")
        print(f"reason={failure}")
        if block_error:
            print(f"guard_block_feedback_error={block_error}")
        else:
            print(f"task_status={blocked_task.get('status')}")
        notify_coding_event(
            args,
            "lease-stale" if "heartbeat" in str(exc).lower() else "blocked",
        )
        return 2


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a contract-gated one-shot ClawdX Mongo pipeline dispatch."
    )
    parser.add_argument("--task-id", required=True, help="Mongo pipeline id, e.g. 0377")
    parser.add_argument("--api-base", default=DEFAULT_API_BASE)
    parser.add_argument("--host", default=DEFAULT_HOST, help="SSH target")
    parser.add_argument("--remote-repo", default=DEFAULT_REMOTE_REPO)
    parser.add_argument("--source-repo", default=DEFAULT_REMOTE_SOURCE_REPO)
    parser.add_argument("--repository", choices=["agentx"], default="agentx")
    parser.add_argument("--agent", default=DEFAULT_AGENT)
    parser.add_argument("--worker-helper", default=DEFAULT_WORKER_HELPER)
    parser.add_argument("--max-changed-files", type=int, default=8)
    parser.add_argument("--max-changed-bytes", type=int, default=100_000)
    parser.add_argument(
        "--allowed-path",
        action="append",
        help="Exact repository path authorized by the sealed automation scope",
    )
    parser.add_argument("--model", help="Optional OpenClaw model override")
    parser.add_argument(
        "--cost-evidence-mode",
        choices=sorted(COST_EVIDENCE_MODES),
        help="Required authoritative cost contract for live dispatch",
    )
    parser.add_argument(
        "--attest-attribution",
        action="store_true",
        help="Open a short-lived server-side Pipeline attribution lease for the reserved model alias",
    )
    parser.add_argument(
        "--attribution-task-type",
        choices=["daily_operator", "code_generation", "master_brain"],
        default="code_generation",
    )
    parser.add_argument(
        "--attribution-attempt",
        type=int,
        help="Optional expected attempt; the server derives and verifies the authoritative value",
    )
    parser.add_argument(
        "--thinking",
        choices=["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max"],
    )
    parser.add_argument("--session-prefix", default="guarded-dispatch")
    parser.add_argument("--session-key")
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument(
        "--automated-lease",
        action="store_true",
        help="Request a server-issued autonomous claim lease and bind final feedback to it",
    )
    parser.add_argument(
        "--lease-duration-ms",
        type=int,
        help="Lease duration bounded by the task automation intent",
    )
    parser.add_argument(
        "--allow-dispatch",
        action="store_true",
        help="Actually dispatch after the contract matrix passes",
    )
    parser.add_argument("--task-worktree", action="store_true", help="Use a task-bound worktree inside the reviewed worker workspace")
    parser.add_argument("--matrix-remote-root")
    parser.add_argument("--matrix-json-output")
    parser.add_argument("--json-output")
    parser.add_argument(
        "--run-contract-matrix",
        action="store_true",
        help="Run the slow capability/safety matrix before dispatch",
    )
    parser.add_argument(
        "--independent-verification-command",
        help="Required live-dispatch command run by the dispatcher after the worker stops",
    )
    parser.add_argument("--independent-verification-timeout", type=int, default=900)
    parser.add_argument("--verification-repair-turns", type=int, choices=[0, 1], default=0)
    parser.add_argument("--verification-repair-timeout", type=int, default=180)
    parser.add_argument("--verification-output")
    parser.add_argument("--energy-meter-host", help="SSH target exposing nvidia-smi power.draw")
    parser.add_argument("--energy-gpu-index", type=int, action="append")
    parser.add_argument("--energy-baseline-seconds", type=float, default=10.0)
    parser.add_argument("--energy-sample-interval-seconds", type=float, default=1.0)
    parser.add_argument("--electricity-tariff-currency")
    parser.add_argument("--electricity-tariff-rate-nano-per-kwh", type=int)
    parser.add_argument(
        "--telegram-notifications",
        action="store_true",
        help="Send fixed event-only Telegram messages using private environment credentials",
    )
    parser.add_argument(
        "--telegram-ui-base",
        default="http://127.0.0.1:3180/pipeline",
        help="Operator Pipeline link included in fixed event-only notifications",
    )
    parser.add_argument(
        "--repair-attempt",
        action="store_true",
        help="Resume a blocked task from its bounded dirty diff and prior verifier output",
    )
    return parser.parse_args()


def return_preflight_problem(args, task, error, *, deferred=False) -> None:
    """Return a launch problem without consuming an attempt or overwriting a newer claim."""
    if not getattr(args, "allow_dispatch", False) or not isinstance(task, dict):
        return
    if task.get("status") != "queued" or task.get("assignee") is not None or not task.get("updatedAt"):
        return
    try:
        dispatch_api.api_json(args.api_base, f"/api/pipeline/tasks/{args.task_id}/feedback", method="POST", timeout=10, payload={
            "status": "deferred" if deferred else "blocked", "by": "guarded-dispatch", "expectedQueuedUpdatedAt": task["updatedAt"],
            "text": "The team could not start this task. No coding attempt was consumed.\n\n"
                    + str(error)[:1000] + ("\n\nThe task remains queued. Retry when capacity is available." if deferred
                                         else "\n\nResolve this problem, then reply and resume this same ticket."),
        })
    except (PipelineApiError, subprocess.TimeoutExpired):
        print("preflight_feedback=not_recorded_task_changed_or_api_unavailable")


def main() -> int:
    args = parse_args()
    root = repo_root()
    stamp = utc_stamp()
    task = None
    try:
        task = dispatch_api.fetch_task(args.api_base, args.task_id, agent=args.agent)
        print(f"task_id={task.get('pipelineId')}")
        print(f"task_title={task.get('title')}")
        print(f"task_status={task.get('status')}")
        print(f"task_assignee={task.get('assignee')}")
        scope_files = automation_scope_files(task)
        supplied_scope = getattr(args, "allowed_path", None)
        if (
            getattr(args, "automated_lease", False)
            and supplied_scope is not None
            and sorted(supplied_scope) != scope_files
        ):
            raise PipelineApiError(
                "dispatcher allowed paths differ from the sealed task automation scope"
            )
        args.allowed_path = scope_files
        if args.repair_attempt:
            previous = (task.get("automationAttempts") or [{}])[-1]
            queued_repair = task.get("status") == "queued" and task.get("assignee") is None \
                and previous.get("assignee") == args.agent \
                and previous.get("finalState") in {"blocked", "review", "released"} \
                and previous.get("reviewOutcome") != "accepted"
            if not queued_repair and (task.get("status") != "blocked" or task.get("assignee") != args.agent):
                raise PipelineApiError(
                    "repair requires the same worker's blocked task or requeued nonaccepted attempt"
                )
        elif task.get("status") != "queued" or task.get("assignee") is not None:
            raise PipelineApiError("task must be queued and unassigned before dispatch")

        if args.run_contract_matrix:
            preflight = run_contract_matrix(args, root, stamp)
            if preflight != 0:
                print("guarded_dispatch=blocked")
                print("reason=contract_matrix_failed")
                return_preflight_problem(args, task, "Contract checks failed before execution.")
                return preflight
        else:
            print("contract_matrix=skipped")
        if not args.allow_dispatch:
            print("guarded_dispatch=dry_run_pass")
            print("dispatch=skipped")
            print("reason=missing --allow-dispatch")
            return 0
        dispatch_openclaw.validate_cost_preflight(args, task)
        if not args.independent_verification_command:
            raise PipelineApiError(
                "--independent-verification-command is required with --allow-dispatch"
            )
        revision = source_revision(root)
        if not args.repair_attempt:
            dispatch_remote.synchronize_remote_checkout(args.host, args.remote_repo, revision,
                                        source_repo=getattr(args, "source_repo", DEFAULT_REMOTE_SOURCE_REPO))
        if getattr(args, "task_worktree", False):
            args.remote_repo = dispatch_remote.task_worktrees.prepare_remote_worktree(
                dispatch_remote.ssh_run, args.host, args.remote_repo, args.task_id, revision, args.agent)
        dispatch_remote.validate_remote_project_checkout(args.host, args.remote_repo, revision)
        args.source_revision = revision
        source_files = dispatch_message.authority_source_files(task)
        dispatch_remote.validate_remote_authority_sources(args.host, args.remote_repo, source_files)
        if not args.repair_attempt:
            dispatch_remote.validate_independent_verification_baseline(
                args.host,
                args.remote_repo,
                args.independent_verification_command,
                expected_revision=revision,
                timeout=args.independent_verification_timeout,
            )
        else:
            # The preserved patch may fail tests: repairing that failure is the
            # purpose of this attempt. Post-worker verification stays mandatory.
            print("independent_verification_preflight=deferred_until_repair")
        session_key = getattr(args, "session_key", None) or (
            f"{getattr(args, 'session_prefix', 'guarded-dispatch')}-{args.task_id}-{stamp}"
        )
        dispatch_openclaw.validate_openclaw_dispatch_preflight(
            args.host,
            args.agent,
            session_key,
            args.model,
        )
        args.session_key = session_key
        return run_dispatch(args, task, stamp)
    except dispatch_api.ClaimOutcomeUnknown as exc:
        print("guarded_dispatch=unknown")
        print(f"reason={exc}")
        return 5
    except ResourcePreflightDeferred as exc:
        print("guarded_dispatch=deferred")
        print(f"reason={exc}")
        return_preflight_problem(args, task, exc, deferred=True)
        return 4
    except (PipelineApiError, subprocess.TimeoutExpired) as exc:
        print("guarded_dispatch=failed")
        print(f"reason={exc}")
        return_preflight_problem(args, task, exc)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
