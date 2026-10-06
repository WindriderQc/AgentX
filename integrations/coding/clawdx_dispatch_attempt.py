"""One claimed ClawdX dispatch attempt: worker run under an attribution lease,
repository and feedback checks, independent verification, cost and energy
evidence, verification report and worker feedback.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shlex
import subprocess
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
        attempt_usage,
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
        attempt_usage,
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


def failed_test_output(output: str) -> bool:
    """Do not spend another worker turn on boot, configuration or zero-test errors."""
    jest = (re.search(r"^Test Suites:\s+[1-9]\d* failed\b", output, re.MULTILINE)
            and re.search(r"^Tests:\s+[1-9]\d* failed\b", output, re.MULTILINE))
    unittest = re.search(r"^FAILED \(failures=[1-9]\d*\)$", output, re.MULTILINE)
    return bool(jest or unittest)


def verification_repair_change_failures(
    before: dict[str, Any], after: dict[str, Any],
    old_feedback: str, new_feedback: str,
) -> list[str]:
    failures = []
    if before.get("files") == after.get("files"):
        failures.append("verification_repair_patch_unchanged")
    if old_feedback == new_feedback:
        failures.append("verification_repair_feedback_unchanged")
    return failures


def combine_local_energy(first: dict[str, Any] | None,
                         second: dict[str, Any] | None,
                         args: argparse.Namespace) -> dict[str, Any] | None:
    """Account for both sampled worker turns; never report only the first."""
    if first is None or second is None:
        return None
    if (first.get("measurementScope") != second.get("measurementScope")
            or first.get("source") != second.get("source")):
        return None
    duration = int(first["measurementDurationMs"]) + int(second["measurementDurationMs"])
    if duration <= 0:
        return None
    baseline = round(
        (int(first["baselineMilliwatts"]) * int(first["measurementDurationMs"])
         + int(second["baselineMilliwatts"]) * int(second["measurementDurationMs"])) / duration
    )
    evidence = {
        "measurementScope": first["measurementScope"],
        "energyMillijoules": int(first["energyMillijoules"]) + int(second["energyMillijoules"]),
        "measurementDurationMs": duration,
        "sampleCount": int(first["sampleCount"]) + int(second["sampleCount"]),
        "baselineMilliwatts": baseline,
        "source": first["source"],
    }
    evidence["evidenceFingerprint"] = hashlib.sha256(json.dumps(
        evidence, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")).hexdigest()
    return attach_tariff(
        evidence,
        currency=getattr(args, "electricity_tariff_currency", None),
        rate_nano_currency_units_per_kwh=getattr(
            args, "electricity_tariff_rate_nano_per_kwh", None
        ),
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

    def worker_command(worker_message: str, timeout_seconds: int) -> str:
        openclaw_cmd = ["openclaw", "agent", "--agent", args.agent]
        if args.model:
            openclaw_cmd.extend(["--model", args.model])
        openclaw_cmd.extend([
            "--session-key", session_key, "--message", worker_message,
            "--json", "--timeout", str(timeout_seconds),
        ])
        if args.thinking:
            openclaw_cmd.extend(["--thinking", args.thinking])
        return (f"cd {shlex.quote(args.remote_repo)} && "
                + " ".join(shlex.quote(part) for part in openclaw_cmd))

    remote_cmd = worker_command(message, args.timeout)
    request_id = f"guarded-dispatch:{args.task_id}:{stamp}"
    sampler = None
    local_energy: dict[str, Any] | None = None
    observed_energy_failures: list[str] = []
    try:
        sampler = local_energy_sampler(args)
        if sampler is not None:
            sampler.collect_baseline()
            sampler.start()
    except (ObservabilityError, OSError, subprocess.TimeoutExpired) as exc:
        print(f"telemetry_warning=local_energy_baseline_unavailable:{type(exc).__name__}")
        sampler = None
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
    args.observed_attempt_usage = attempt_usage(cost_observation, attribution=attribution_lease)
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
                attribution_lease=attribution_lease,
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
    repair_turn_ran = False
    repair_initial_snapshot: dict[str, Any] = {}
    preflight_feedback = ""
    repair_enabled = (getattr(args, "automated_lease", False)
                      and getattr(args, "verification_repair_turns", 0) == 1)
    if repair_enabled and verification_rc == 1 and not failures and failed_test_output(verification_text):
        # A test failure alone may be repaired. Refuse another model turn if
        # the first patch or its structured feedback already failed a guard.
        preflight_errors = dispatch_remote.validate_remote_repo(
            args.host, args.remote_repo, task,
            max_changed_files=args.max_changed_files,
            max_changed_bytes=args.max_changed_bytes,
            exact_scope=exact_scope,
            snapshot=repair_initial_snapshot,
        )
        try:
            preflight_feedback = dispatch_remote.read_remote_feedback(args.host, feedback_path)
            preflight_errors.extend(feedback_text_validation_errors(
                preflight_feedback, allow_pending_independent=True
            ))
        except PipelineApiError as exc:
            preflight_errors.append(str(exc))
        max_duration_ms = (task.get("automation") or {}).get("budgets", {}).get("maxDurationMs")
        remaining_ms = (max_duration_ms - elapsed_ms()
                        - args.independent_verification_timeout * 1000 - 30_000
                        if type(max_duration_ms) is int else 0)
        repair_timeout = min(180, max(0, getattr(args, "verification_repair_timeout", 0)),
                             remaining_ms // 1000)
        if preflight_errors:
            print("verification_repair=skipped_first_patch_guard_failed")
        elif repair_timeout < 30:
            print("verification_repair=skipped_insufficient_time")
        else:
            print("verification_repair=starting_bounded_worker_turn")
            repair_message = dispatch_message.build_message(
                task, api_base=args.api_base, remote_repo=args.remote_repo,
                agent=args.agent, worker_helper=args.worker_helper,
                repair_context=verification_text,
            )
            repair_args = argparse.Namespace(**{**vars(args), "timeout": repair_timeout})
            repair_sampler = None
            repair_energy = None
            repair_process = None
            repair_lease = None
            try:
                repair_sampler = local_energy_sampler(args)
                if repair_sampler is not None:
                    repair_sampler.collect_baseline()
                    repair_sampler.start()
            except (ObservabilityError, OSError, subprocess.TimeoutExpired):
                observed_energy_failures.append("local_energy_repair_evidence_unavailable")
                repair_sampler = None
            try:
                repair_process, repair_lease = dispatch_openclaw.run_openclaw_process(
                    repair_args, worker_command(repair_message, repair_timeout),
                    request_id=f"{request_id}:verification-repair-1",
                )
            except (subprocess.TimeoutExpired, dispatch_openclaw.WorkerCompletionUnknown):
                raise  # The same remote-completion fence applies to a repair turn.
            except (PipelineApiError, OSError) as exc:
                failures.append(f"worker_repair_process_failed:{type(exc).__name__}:{exc}")
                cost_observation = None
            finally:
                if repair_sampler is not None:
                    try:
                        repair_energy = repair_sampler.stop()
                    except ObservabilityError:
                        observed_energy_failures.append("local_energy_repair_evidence_unavailable")
                try:
                    local_energy = combine_local_energy(local_energy, repair_energy, args)
                except (ObservabilityError, KeyError, ValueError, TypeError):
                    local_energy = None
                if local_energy is None:
                    observed_energy_failures.append("local_energy_two_turn_evidence_unavailable")
                    print("telemetry_warning=local_energy_two_turn_evidence_unavailable")
            if repair_process is not None:
                repair_turn_ran = True
                if repair_process.stderr:
                    sys.stderr.write(repair_process.stderr)
                if args.json_output:
                    Path(args.json_output).write_text(repair_process.stdout or "", encoding="utf-8")
                if repair_process.returncode != 0:
                    failures.append(f"worker_repair_process_failed:exit={repair_process.returncode}")
                    cost_observation = None
                else:
                    try:
                        # The first session receipt no longer covers every call.
                        cost_observation = None
                        repair_payload = openclaw_json(repair_process.stdout)
                        names.update(tool_names(repair_payload))
                        repair_provider, repair_model, repair_fallback = execution_route(repair_payload)
                        if not getattr(args, "attest_attribution", False):
                            failures.extend(execution_route_validation_errors(
                                args.model, repair_provider, repair_model, repair_fallback
                            ))
                        if not isinstance(repair_lease, dict) or not isinstance(attribution_lease, dict) \
                                or repair_lease.get("effectiveModel") != attribution_lease.get("effectiveModel"):
                            failures.append("attribution_repair_model_mismatch")
                        else:
                            first_inference = attribution_lease.get("inference")
                            second_inference = repair_lease.get("inference")
                            combined_inference = None
                            if isinstance(first_inference, dict) and isinstance(second_inference, dict):
                                combined_inference = {
                                    "state": ("completed" if first_inference.get("state") == "completed"
                                              and second_inference.get("state") == "completed" else "unknown"),
                                    "attempts": (int(first_inference.get("attempts") or 0)
                                                 + int(second_inference.get("attempts") or 0)),
                                    "elapsedMs": (int(first_inference.get("elapsedMs") or 0)
                                                  + int(second_inference.get("elapsedMs") or 0)),
                                    "history": [*(first_inference.get("history") or []),
                                                *(second_inference.get("history") or [])],
                                    "workerTurns": 2,
                                }
                            attribution_lease = {
                                **{key: value for key, value in attribution_lease.items()
                                   if key != "inference"},
                                "requestCount": (attribution_lease["requestCount"]
                                                 + repair_lease["requestCount"]),
                                **({"inference": combined_inference} if combined_inference else {}),
                            }
                        cost_observation = dispatch_openclaw.read_openclaw_session_cost(
                            args.host, args.agent, session_key
                        )
                        failures.extend(cost_evidence_failures(
                            task, cost_observation, mode=cost_mode,
                            requested_model=args.model,
                        ))
                        if getattr(args, "attest_attribution", False):
                            failures.extend(attested_execution_validation_errors(
                                args.model, repair_provider, repair_model, repair_fallback,
                                attribution_lease, cost_observation,
                            ))
                        if lease_heartbeat:
                            lease_heartbeat.ensure_healthy()
                        if not failures:
                            routing_evidence = {
                                "status": "verified", "provider": "ollama",
                                "effectiveModel": attribution_lease["effectiveModel"],
                                "requestCount": attribution_lease["requestCount"],
                                "sessionCallCount": cost_observation["calls"],
                                "evidenceFingerprint": hashlib.sha256(json.dumps({
                                    "lease": attribution_lease,
                                    "session": cost_observation["fingerprint"],
                                }, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest(),
                            }
                            verification_started = time.monotonic()
                            verification_rc, verification_text = dispatch_remote.run_independent_verification(
                                args.host, args.remote_repo, args.independent_verification_command,
                                expected_revision=args.source_revision,
                                timeout=args.independent_verification_timeout,
                                output_path=verification_output,
                            )
                            verification_duration_ms += max(
                                0, round((time.monotonic() - verification_started) * 1000)
                            )
                            print("verification_repair=verified" if verification_rc == 0
                                  else "verification_repair=still_failing")
                    except (PipelineApiError, KeyError, ValueError, TypeError,
                            OSError, subprocess.TimeoutExpired) as exc:
                        failures.append(f"worker_repair_evidence_failed:{type(exc).__name__}:{exc}")
            if lease_heartbeat:
                lease_heartbeat.ensure_healthy()
    if verification_rc != 0:
        summary = verification_text.strip().replace("\n", " ")[-500:]
        failures.append(
            f"independent_verification_failed:exit={verification_rc},output={summary}"
        )
    else:
        print("independent_verification=pass")

    budget_ms = (task.get("automation") or {}).get("budgets", {}).get("maxDurationMs")
    if getattr(args, "automated_lease", False) and type(budget_ms) is int and elapsed_ms() > budget_ms:
        failures.append("attempt_duration_budget_exceeded")

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
        if repair_turn_ran:
            failures.extend(verification_repair_change_failures(
                repair_initial_snapshot, worker_snapshot, preflight_feedback, feedback_text,
            ))
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
                return 5
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
                    routing_evidence=routing_evidence,
                    failures=failures,
                    cost_observation=cost_observation,
                    cost_mode=cost_mode,
                    local_energy=local_energy,
                    attribution_lease=attribution_lease,
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
            attribution_lease=attribution_lease,
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
