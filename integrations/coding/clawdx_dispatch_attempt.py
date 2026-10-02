"""One claimed ClawdX dispatch attempt: worker run under an attribution lease,
repository and feedback checks, independent verification, cost and energy
evidence, verification report and worker feedback.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shlex
import sys
import time
from pathlib import Path
from typing import Any

try:
    from integrations.coding.coding_dispatch_evidence import (
        PipelineApiError,
        append_dispatcher_verification,
        attested_execution_validation_errors,
        build_attempt_evidence,
        coding_attempt_number,
        cost_evidence_failures,
        cost_evidence_source,
        execution_route,
        execution_route_validation_errors,
        feedback_text_validation_errors,
        notify_coding_event,
        openclaw_json,
        tool_names,
    )
    from integrations.coding.coding_team_deliverable import (
        ReportOutcomeUnknown,
        register_verification_report,
    )
    from integrations.coding.coding_team_observability import (
        NvidiaSmiEnergySampler,
        ObservabilityError,
        attach_tariff,
    )
    from integrations.coding.coding_team_promotion import (
        PromotionError,
        worker_snapshot_fingerprint,
    )
    from integrations.coding import clawdx_dispatch_api as dispatch_api
    from integrations.coding import clawdx_dispatch_message as dispatch_message
    from integrations.coding import clawdx_dispatch_openclaw as dispatch_openclaw
    from integrations.coding import clawdx_dispatch_remote as dispatch_remote
except ModuleNotFoundError:  # direct execution from the scripts directory
    from coding_dispatch_evidence import (  # type: ignore
        PipelineApiError,
        append_dispatcher_verification,
        attested_execution_validation_errors,
        build_attempt_evidence,
        coding_attempt_number,
        cost_evidence_failures,
        cost_evidence_source,
        execution_route,
        execution_route_validation_errors,
        feedback_text_validation_errors,
        notify_coding_event,
        openclaw_json,
        tool_names,
    )
    from coding_team_deliverable import (  # type: ignore
        ReportOutcomeUnknown,
        register_verification_report,
    )
    from coding_team_observability import (  # type: ignore
        NvidiaSmiEnergySampler,
        ObservabilityError,
        attach_tariff,
    )
    from coding_team_promotion import (  # type: ignore
        PromotionError,
        worker_snapshot_fingerprint,
    )
    import clawdx_dispatch_api as dispatch_api  # type: ignore
    import clawdx_dispatch_message as dispatch_message  # type: ignore
    import clawdx_dispatch_openclaw as dispatch_openclaw  # type: ignore
    import clawdx_dispatch_remote as dispatch_remote  # type: ignore


def local_energy_sampler(args: argparse.Namespace) -> NvidiaSmiEnergySampler | None:
    host = str(getattr(args, "energy_meter_host", "") or "").strip()
    if not host:
        return None
    return NvidiaSmiEnergySampler(
        host,
        tuple(getattr(args, "energy_gpu_index", None) or (0,)),
        baseline_seconds=float(getattr(args, "energy_baseline_seconds", 10.0)),
        interval_seconds=float(getattr(args, "energy_sample_interval_seconds", 1.0)),
    )


def run_claimed_dispatch(
    args: argparse.Namespace,
    task: dict[str, Any],
    stamp: str,
    feedback_path: str,
    repair_context: str | None,
    lease_heartbeat: dispatch_api.LeaseHeartbeat | None = None,
) -> int:
    """Execute the worker and every post-claim acceptance gate."""
    attempt_started = time.monotonic()
    exact_scope = set(getattr(args, "allowed_path", None) or []) or None

    def elapsed_ms() -> int:
        return max(0, round((time.monotonic() - attempt_started) * 1000))

    message = dispatch_message.build_message(
        task,
        api_base=args.api_base,
        remote_repo=args.remote_repo,
        agent=args.agent,
        worker_helper=args.worker_helper,
        repair_context=repair_context,
    )
    session_key = args.session_key or f"{args.session_prefix}-{args.task_id}-{stamp}"

    openclaw_cmd = ["openclaw", "agent", "--agent", args.agent]
    if args.model:
        openclaw_cmd.extend(["--model", args.model])
    openclaw_cmd.extend(
        [
            "--session-key",
            session_key,
            "--message",
            message,
            "--json",
            "--timeout",
            str(args.timeout),
        ]
    )
    if args.thinking:
        openclaw_cmd.extend(["--thinking", args.thinking])

    remote_cmd = (
        f"cd {shlex.quote(args.remote_repo)} && "
        + " ".join(shlex.quote(part) for part in openclaw_cmd)
    )
    request_id = f"guarded-dispatch:{args.task_id}:{stamp}"
    sampler = local_energy_sampler(args)
    local_energy: dict[str, Any] | None = None
    observed_energy_failures: list[str] = []
    if sampler is not None:
        try:
            sampler.collect_baseline()
            sampler.start()
        except ObservabilityError as exc:
            raise PipelineApiError(str(exc)) from exc
    try:
        proc, attribution_lease = dispatch_openclaw.run_openclaw_process(
            args,
            remote_cmd,
            request_id=request_id,
        )
    finally:
        if sampler is not None:
            try:
                local_energy = sampler.stop()
                local_energy = attach_tariff(
                    local_energy,
                    currency=getattr(args, "electricity_tariff_currency", None),
                    rate_nano_currency_units_per_kwh=getattr(
                        args,
                        "electricity_tariff_rate_nano_per_kwh",
                        None,
                    ),
                )
            except ObservabilityError:
                observed_energy_failures.append("local_energy_evidence_unavailable")
    cost_mode = str(args.cost_evidence_mode)
    cost_observation: dict[str, Any] | None = None
    observed_cost_failures: list[str] = []
    try:
        cost_observation = dispatch_openclaw.read_openclaw_session_cost(
            args.host,
            args.agent,
            session_key,
        )
        observed_cost_failures.extend(
            cost_evidence_failures(
                task,
                cost_observation,
                mode=cost_mode,
                requested_model=args.model,
            )
        )
        print(f"cost_nanodollars={cost_observation['costNanodollars']}")
        print(f"cost_source={cost_evidence_source()}")
    except PipelineApiError:
        # Monetary telemetry is optional. Missing session identity/call proof
        # still fails the separate attribution validation below.
        print("cost_status=unknown")
    if local_energy is not None:
        print(f"local_energy_millijoules={local_energy['energyMillijoules']}")
        print(f"local_energy_scope={local_energy['measurementScope']}")
        tariff = local_energy.get("tariff")
        if isinstance(tariff, dict):
            print(f"electricity_cost_currency={tariff['currency']}")
            print(f"electricity_cost_nano_units={tariff['estimatedCostNanoCurrencyUnits']}")
        else:
            print("electricity_cost=unknown_tariff_not_configured")
    if lease_heartbeat:
        lease_heartbeat.ensure_healthy()
    if proc.stderr:
        sys.stderr.write(proc.stderr)
    if args.json_output:
        output = Path(args.json_output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(proc.stdout or "", encoding="utf-8")
        print(f"dispatch_json={output}")
    if proc.returncode != 0:
        failures = [
            f"worker_process_failed:exit={proc.returncode}",
            *observed_cost_failures,
        ]
        blocked_task = dispatch_api.block_failed_dispatch(
            args.api_base,
            args.task_id,
            agent=args.agent,
            failures=failures,
            lease_id=getattr(args, "lease_id", None),
            attempt_evidence=build_attempt_evidence(
                duration_ms=elapsed_ms(),
                failures=failures,
                cost_observation=cost_observation,
                cost_mode=cost_mode,
                local_energy=local_energy,
                inference=(attribution_lease or {}).get("inference"),
            ),
        )
        sys.stdout.write(proc.stdout)
        print("guarded_dispatch=failed")
        print(f"reason={failures[0]}")
        print(f"task_status={blocked_task.get('status')}")
        notify_coding_event(args, "blocked")
        return proc.returncode or 1

    payload = openclaw_json(proc.stdout)
    names = tool_names(payload)
    winner_provider, winner_model, fallback_used = execution_route(payload)
    if getattr(args, "attest_attribution", False):
        failures = attested_execution_validation_errors(
            args.model,
            winner_provider,
            winner_model,
            fallback_used,
            attribution_lease,
            cost_observation,
        )
    else:
        failures = execution_route_validation_errors(
            args.model,
            winner_provider,
            winner_model,
            fallback_used,
        )
    failures.extend(observed_cost_failures)
    for warning in observed_energy_failures:
        print(f"telemetry_warning={warning}")
    routing_evidence = None
    if getattr(args, "attest_attribution", False) and not failures:
        routing_evidence = {
            "status": "verified", "provider": "ollama",
            "effectiveModel": attribution_lease["effectiveModel"],
            "requestCount": attribution_lease["requestCount"],
            "sessionCallCount": cost_observation["calls"],
            "evidenceFingerprint": hashlib.sha256(json.dumps({
                "lease": attribution_lease, "session": cost_observation["fingerprint"],
            }, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest(),
        }

    verification_output = Path(args.verification_output) if args.verification_output else None
    verification_started = time.monotonic()
    verification_rc, verification_text = dispatch_remote.run_independent_verification(
        args.host,
        args.remote_repo,
        args.independent_verification_command,
        expected_revision=args.source_revision,
        timeout=args.independent_verification_timeout,
        output_path=verification_output,
    )
    verification_duration_ms = max(
        0, round((time.monotonic() - verification_started) * 1000)
    )
    if lease_heartbeat:
        lease_heartbeat.ensure_healthy()
    if verification_rc != 0:
        summary = verification_text.strip().replace("\n", " ")[-500:]
        failures.append(
            f"independent_verification_failed:exit={verification_rc},output={summary}"
        )
    else:
        print("independent_verification=pass")

    change_metrics: dict[str, int] = {}
    worker_snapshot: dict[str, Any] = {}
    failures.extend(
        dispatch_remote.validate_remote_repo(
            args.host,
            args.remote_repo,
            task,
            max_changed_files=args.max_changed_files,
            max_changed_bytes=args.max_changed_bytes,
            exact_scope=exact_scope,
            metrics=change_metrics,
            snapshot=worker_snapshot,
        )
    )
    worker_receipt_fingerprint: str | None = None
    if not failures:
        try:
            worker_receipt_fingerprint = worker_snapshot_fingerprint(
                pipeline_id=str(args.task_id),
                attempt=coding_attempt_number(args),
                assignee=str(args.agent),
                base_revision=str(getattr(args, "source_revision", "")),
                files=worker_snapshot.get("files") or {},
            )
        except PromotionError as exc:
            failures.append(f"worker_snapshot_receipt_failed:{exc}")
    feedback_text = ""
    try:
        feedback_text = dispatch_remote.read_remote_feedback(args.host, feedback_path)
        failures.extend(
            feedback_text_validation_errors(
                feedback_text,
                allow_pending_independent=True,
            )
        )
    except PipelineApiError as exc:
        failures.append(str(exc))
    if not failures:
        feedback_text = append_dispatcher_verification(
            feedback_text,
            command=args.independent_verification_command,
            output=verification_text,
        )
        if getattr(args, "lease_id", None):
            try:
                report = register_verification_report(
                    dispatch_api.api_json, args.api_base, args.task_id,
                    agent=args.agent, attempt=coding_attempt_number(args),
                    lease_id=args.lease_id, text=feedback_text,
                )
                print(f"verification_deliverable={report['ref']}")
            except ReportOutcomeUnknown as exc:
                print(f"verification_deliverable_unknown={exc}")
                return 4
            except (PipelineApiError, ValueError, KeyError) as exc:
                failures.append(f"verification_deliverable_failed:{exc}")
    if failures:
        if lease_heartbeat:
            lease_heartbeat.ensure_healthy()
        block_error: str | None = None
        blocked_task: dict[str, Any] | None = None
        try:
            blocked_task = dispatch_api.block_failed_dispatch(
                args.api_base,
                args.task_id,
                agent=args.agent,
                failures=failures,
                worker_feedback=feedback_text,
                lease_id=getattr(args, "lease_id", None),
                attempt_evidence=build_attempt_evidence(
                    duration_ms=elapsed_ms(),
                    verification_status=(
                        "passed" if verification_rc == 0 else "failed"
                    ),
                    verification_duration_ms=verification_duration_ms,
                    changes=change_metrics,
                    failures=failures,
                    cost_observation=cost_observation,
                    cost_mode=cost_mode,
                    local_energy=local_energy,
                    inference=(attribution_lease or {}).get("inference"),
                ),
                timeout=30,
            )
        except PipelineApiError as exc:
            block_error = str(exc)
        print("guarded_dispatch=failed")
        for failure in failures:
            print(f"reason={failure}")
        if block_error:
            print(f"guard_block_feedback_error={block_error}")
        else:
            print(f"task_status={blocked_task.get('status')}")
        print(f"tools={','.join(sorted(names))}")
        print(f"session_key={session_key}")
        notify_coding_event(args, "blocked")
        return 3

    if lease_heartbeat:
        lease_heartbeat.ensure_healthy()
    final_task = dispatch_api.submit_worker_feedback(
        args.api_base,
        args.task_id,
        agent=args.agent,
        text=feedback_text,
        lease_id=getattr(args, "lease_id", None),
        attempt_evidence=build_attempt_evidence(
            duration_ms=elapsed_ms(),
            verification_status="passed",
            verification_duration_ms=verification_duration_ms,
            changes=change_metrics,
            cost_observation=cost_observation,
            cost_mode=cost_mode,
            local_energy=local_energy,
            worker_receipt_fingerprint=worker_receipt_fingerprint,
            routing_evidence=routing_evidence,
            inference=(attribution_lease or {}).get("inference"),
        ),
    )
    failures.extend(dispatch_message.feedback_validation_errors(final_task, args.agent))
    if failures:
        print("guarded_dispatch=failed")
        for failure in failures:
            print(f"reason={failure}")
        print(f"task_status={final_task.get('status')}")
        print(f"session_key={session_key}")
        return 3

    print("guarded_dispatch=complete")
    print(f"task_status={final_task.get('status')}")
    print(f"session_key={session_key}")
    notify_coding_event(args, "review-ready")
    return 0
