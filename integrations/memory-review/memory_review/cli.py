"""Ecosystem Memory Review CLI (schedule-ready, confidence-tiered).

Commands:
  collect          run one or more collectors locally; --dry-run never mutates
  run              full shadow/review orchestration against AgentX Core
  report           render a run report from Core state into the local reports dir
  digest           print the read-only briefing digest (for OpenClaw surfaces)
  watermarks       show or reset local watermark state (explicit recovery path)

Nothing here applies or approves candidates. Product Core evaluates the
standing policy and owns every semantic adapter; this CLI only collects,
synthesizes, submits, and renders receipts.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import COLLECTOR_VERSION, PROMPT_VERSION, reporting, schema, synthesis
from .client import AgentXRejected, AgentXUnavailable, MemoryReviewClient
from .collectors import claude as claude_collector
from .collectors import codex as codex_collector
from .collectors import git as git_collector
from .collectors import hermes as hermes_collector
from .collectors import openclaw as openclaw_collector
from .watermarks import WatermarkStore, default_state_dir

RUNTIME_COLLECTORS = ("claude-code", "codex", "openclaw", "hermes", "git")


def _add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--state-dir", type=Path, default=None,
                        help="watermark/report state dir (default ~/.agentx/memory-review)")
    parser.add_argument("--lookback-days", type=int, default=schema.DEFAULT_LOOKBACK_DAYS)
    parser.add_argument("--max-files", type=int, default=schema.MAX_FILES_PER_COLLECTOR)
    parser.add_argument("--claude-root", type=Path, default=None)
    parser.add_argument("--claude-project", action="append", default=None,
                        help="fnmatch pattern for allowed Claude project dirs (repeatable)")
    parser.add_argument("--codex-root", type=Path, default=None)
    parser.add_argument("--codex-cwd", action="append", default=None,
                        help="fnmatch pattern for allowed Codex session cwds (repeatable)")
    parser.add_argument("--openclaw-home", type=Path, default=None)
    parser.add_argument("--openclaw-agent", action="append", default=None)
    parser.add_argument("--openclaw-member-agent", action="append", default=None,
                        help="agent serving the household's family pages: its turns are "
                             "household-member statements, never the owner's (repeatable)")
    parser.add_argument("--hermes-home", type=Path, default=None)
    parser.add_argument("--git-repo", action="append", type=Path, default=None,
                        help="repository whose accepted history is verified evidence (repeatable)")
    parser.add_argument(
        "--git-ref", default=os.environ.get("AGENTX_MEMORY_REVIEW_GIT_REF", "main"),
        help="local accepted integration ref observed by the git collector (default main)",
    )


def _collect_one(runtime: str, args: argparse.Namespace, store: WatermarkStore):
    if runtime == "claude-code":
        return claude_collector.collect(
            root=args.claude_root, store=store,
            project_patterns=tuple(args.claude_project or claude_collector.DEFAULT_PROJECT_PATTERNS),
            lookback_days=args.lookback_days, max_files=args.max_files,
        )
    if runtime == "codex":
        return codex_collector.collect(
            root=args.codex_root, store=store,
            cwd_patterns=tuple(args.codex_cwd or codex_collector.DEFAULT_CWD_PATTERNS),
            lookback_days=args.lookback_days, max_files=args.max_files,
        )
    if runtime == "openclaw":
        return openclaw_collector.collect(
            home=args.openclaw_home, store=store,
            agents=tuple(args.openclaw_agent or ("main",)),
            member_agents=tuple(args.openclaw_member_agent or ()),
            lookback_days=args.lookback_days, max_files=args.max_files,
        )
    if runtime == "git":
        return git_collector.collect(
            repos=args.git_repo, store=store,
            lookback_days=args.lookback_days, max_files=args.max_files,
            accepted_ref=args.git_ref,
        )
    if runtime == "hermes":
        return hermes_collector.collect(
            home=args.hermes_home, store=store,
            lookback_days=args.lookback_days, max_files=args.max_files,
        )
    raise ValueError(f"unknown runtime {runtime}")


def _print_summary(result, show_observations: bool) -> None:
    payload = result.collector_payload()
    print(f"[{payload['runtime']}] files={payload['sourceFilesSeen']} "
          f"events={payload['sourceEventsSeen']} eligible={payload['eligibleObservations']} "
          f"rejected={payload['rejectedObservations']}")
    if payload["rejectionCounts"]:
        print(f"  rejections: {payload['rejectionCounts']}")
    for err in payload["errors"]:
        print(f"  error: {err}")
    for drift in payload["drift"]:
        print(f"  drift: {drift}")
    if show_observations:
        for obs in result.observations:
            print(f"  - ({obs.trust}) {obs.text[:160]!r}")


def cmd_collect(args: argparse.Namespace) -> int:
    runtimes = args.runtime or ["claude-code"]
    if runtimes == ["all"]:
        runtimes = list(RUNTIME_COLLECTORS)
    exit_code = 0
    for runtime in runtimes:
        store = WatermarkStore(runtime, args.state_dir)
        result = _collect_one(runtime, args, store)
        _print_summary(result, args.show_observations)
        if args.dry_run:
            print(f"  dry-run: watermarks unchanged ({store.token()})")
        else:
            # A standalone collect without a server submission must not advance
            # watermarks either — acceptance is the only advancement trigger.
            print("  note: watermarks advance only after AgentX accepts a batch (use `run`).")
        if result.errors:
            exit_code = 1
    return exit_code


def _window(args: argparse.Namespace) -> dict:
    now = datetime.now(timezone.utc)
    return {
        "from": (now - timedelta(days=args.lookback_days)).isoformat(),
        "to": now.isoformat(),
        "timezone": "America/Toronto",
    }


SYNTHESIS_EXCHANGES_KEPT = 40


def _keep_synthesis_exchanges(state_dir: Path, run_id: str, exchanges: list) -> None:
    """Keep what was asked and answered, beside the watermarks and as private
    as they are. Without it a run that proposes nothing cannot be explained."""
    if not exchanges:
        return
    try:
        folder = Path(state_dir) / "synthesis"
        folder.mkdir(parents=True, exist_ok=True)
        os.chmod(folder, 0o700)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        path = folder / f"{run_id}-{stamp}.json"
        with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w", encoding="utf-8") as handle:
            json.dump({"runId": run_id, "promptVersion": PROMPT_VERSION, "exchanges": exchanges},
                      handle, ensure_ascii=False)
        for old in sorted(folder.glob("*.json"), key=lambda item: item.stat().st_mtime)[:-SYNTHESIS_EXCHANGES_KEPT]:
            old.unlink()
        print(f"synthesis exchange kept: {path}")
    except OSError as exc:
        print(f"synthesis exchange not kept: {exc}")


def _finish_run(client: MemoryReviewClient, run_id: str, state_dir: Path,
                args: argparse.Namespace) -> int:
    """Idempotently finalize and synthesize one accepted run."""
    model_info = {"provider": "agentx-hermes-proxy", "model": args.model, "temperature": 0}
    try:
        finalized = client.finalize_collection(run_id)
    except (AgentXUnavailable, AgentXRejected) as exc:
        print(f"finalize failed for {run_id} (run stays retryable): {exc}")
        return 1
    status = finalized.get("status")
    print(f"collection finalized: run={run_id} status={status}")

    if status == "completed":
        print("no eligible observations - model not called; run completed empty.")
        _write_local_report(client, run_id, state_dir)
        return 0

    exchanges: list = []
    try:
        bundle = client.synthesis_input(run_id)
        synthesis_receipt: dict = {}
        try:
            candidates = synthesis.synthesize(
                bundle,
                base_url=args.agentx_url, model=args.model,
                max_tokens=args.max_tokens, timeout=args.inference_timeout,
                receipt=synthesis_receipt, exchanges=exchanges,
            )
        finally:
            _keep_synthesis_exchanges(state_dir, run_id, exchanges)
        if synthesis_receipt.get("notSubmitted"):
            print(f"candidate bound of {schema.MAX_CANDIDATES_PER_RUN} per run reached: "
                  f"{synthesis_receipt['notSubmitted']} weaker candidate(s) were not submitted")
        if candidates is None:
            print("synthesis input empty - model not called.")
            _write_local_report(client, run_id, state_dir)
            return 0
        receipt = client.submit_candidates(run_id, candidates, PROMPT_VERSION, model_info)
        print(f"candidates submitted: {receipt.get('accepted', len(candidates))} "
              f"(suppressed={receipt.get('suppressed', 0)}) -> status {receipt.get('status')}")
    except (synthesis.SynthesisError, schema.SynthesisOutputError) as exc:
        print(f"synthesis failed; observations retained, run marked retryable: {exc}")
        try:
            client.fail_run(run_id, "synthesis", str(exc))
        except (AgentXUnavailable, AgentXRejected):
            pass
        return 1
    except (AgentXUnavailable, AgentXRejected) as exc:
        print(f"candidate submission failed (run stays retryable): {exc}")
        return 1

    _write_local_report(client, run_id, state_dir)
    return 0


def _recover_open_runs(client: MemoryReviewClient, current_run_key: str,
                       state_dir: Path, args: argparse.Namespace) -> int:
    """Finish older daily reconciliations before opening today's window."""
    try:
        runs = client.list_runs(limit=100).get("runs") or []
    except (AgentXUnavailable, AgentXRejected) as exc:
        print(f"prior-run recovery unavailable; continuing current reconciliation: {exc}")
        return 1
    open_runs = [run for run in reversed(runs)
                 if (run.get("status") in {"collecting", "synthesizing"}
                     and run.get("runKey") != current_run_key)
                 or (run.get("status") == "failed" and run.get("mode") == "shadow"
                     and (run.get("failure") or {}).get("stage") == "synthesis"
                     and (run.get("failure") or {}).get("retryable") is True)]
    failed = False
    for run in open_runs:
        run_id = str(run.get("runId") or "")
        if not run_id:
            continue
        print(f"recovering unfinished prior reconciliation {run_id}")
        failed = bool(_finish_run(client, run_id, state_dir, args)) or failed
    return 1 if failed else 0


def cmd_run(args: argparse.Namespace) -> int:
    """Full orchestration: open -> collect -> finalize -> synthesize ->
    submit for Core policy evaluation -> report."""
    if not args.dry_run and not args.submit_only and not str(args.model or "").strip():
        print(
            "memory-review: no synthesis model configured; set "
            "AGENTX_MEMORY_REVIEW_MODEL or pass --model after verifying the live ecosystem registry"
        )
        return 1
    client = MemoryReviewClient(args.agentx_url, timeout=args.timeout)
    state_dir = args.state_dir or default_state_dir()
    runtimes = args.runtime or ["all"]
    if runtimes == ["all"]:
        runtimes = list(RUNTIME_COLLECTORS)

    run_key = args.run_key or f"memory-review-{datetime.now(timezone.utc).strftime('%Y%m%d')}"

    if args.dry_run:
        print(f"dry-run: would open run {run_key} (mode={args.mode}) on {args.agentx_url}")
        for runtime in runtimes:
            store = WatermarkStore(runtime, state_dir)
            result = _collect_one(runtime, args, store)
            _print_summary(result, args.show_observations)
        print("dry-run: no server writes, no watermark changes, no model call")
        return 0

    recovery_failed = False
    if not args.submit_only:
        recovery_failed = bool(_recover_open_runs(client, run_key, state_dir, args))

    try:
        run = client.open_run(
            run_key=run_key, mode=args.mode, window=_window(args),
            collector_version=COLLECTOR_VERSION, prompt_version=PROMPT_VERSION,
            model={"provider": "agentx-hermes-proxy", "model": args.model, "temperature": 0},
        )
    except (AgentXUnavailable, AgentXRejected) as exc:
        print(f"memory-review: cannot open run: {exc}")
        return 1
    run_id = run.get("runId") or run.get("run", {}).get("runId")
    if not run_id:
        print("memory-review: server did not return a runId")
        return 1
    print(f"run {run_id} open (mode={args.mode})")

    if run.get("status") in {"ready_for_review", "partially_reviewed"}:
        print("synthesis already finished; existing candidates remain for review.")
        _write_local_report(client, run_id, state_dir)
        return 1 if recovery_failed else 0
    if run.get("status") == "synthesizing" and not args.submit_only:
        finish_failed = bool(_finish_run(client, run_id, state_dir, args))
        return 1 if recovery_failed or finish_failed else 0

    had_errors = False
    for runtime in runtimes:
        store = WatermarkStore(runtime, state_dir)
        try:
            result = _collect_one(runtime, args, store)
        except Exception as exc:  # a broken collector must not sink the others
            print(f"[{runtime}] collector failed: {exc}")
            had_errors = True
            continue
        _print_summary(result, False)
        try:
            observations = [obs.to_payload() for obs in result.observations]
            for start in range(0, max(1, len(observations)), schema.MAX_OBSERVATIONS_PER_BATCH):
                batch = observations[start:start + schema.MAX_OBSERVATIONS_PER_BATCH]
                receipt = client.submit_observations(run_id, result.collector_payload(), batch)
                print(f"  submitted {len(batch)}: accepted={receipt.get('accepted')} "
                      f"duplicates={receipt.get('duplicates')}")
            store.commit(result.stagedWatermarks)
            print(f"  watermarks committed ({store.token()})")
        except AgentXRejected as exc:
            print(f"  [{runtime}] rejected by server, watermarks NOT advanced: {exc}")
            had_errors = True
        except AgentXUnavailable as exc:
            print(f"  [{runtime}] server unavailable, watermarks NOT advanced: {exc}")
            had_errors = True

    if args.submit_only:
        print("submit-only: observations accepted; run left collecting for the reconciliation host")
        return 1 if had_errors else 0
    finish_failed = bool(_finish_run(client, run_id, state_dir, args))
    return 1 if had_errors or recovery_failed or finish_failed else 0


def _write_local_report(client: MemoryReviewClient, run_id: str, state_dir: Path) -> None:
    try:
        run = client.get_run(run_id)
        target = reporting.write_report(state_dir, run)
        print(f"report written: {target}")
        print(reporting.render_digest(run))
    except (AgentXUnavailable, AgentXRejected) as exc:
        print(f"report skipped (server unavailable): {exc}")


def cmd_report(args: argparse.Namespace) -> int:
    client = MemoryReviewClient(args.agentx_url, timeout=args.timeout)
    state_dir = args.state_dir or default_state_dir()
    try:
        if args.run_id:
            run = client.get_run(args.run_id)
        else:
            runs = client.list_runs(limit=1).get("runs") or []
            if not runs:
                print("no runs recorded")
                return 0
            run = client.get_run(runs[0]["runId"])
    except (AgentXUnavailable, AgentXRejected) as exc:
        print(f"report failed: {exc}")
        return 1
    target = reporting.write_report(state_dir, run)
    print(f"report written: {target}")
    return 0


def cmd_digest(args: argparse.Namespace) -> int:
    client = MemoryReviewClient(args.agentx_url, timeout=args.timeout)
    try:
        digest = client.digest()
    except (AgentXUnavailable, AgentXRejected) as exc:
        print(f"Memory review digest unavailable: {exc}")
        return 1
    text = digest.get("text")
    print(text if text else json.dumps(digest, indent=1))
    return 0


def cmd_watermarks(args: argparse.Namespace) -> int:
    runtimes = args.runtime or list(RUNTIME_COLLECTORS)
    for runtime in runtimes:
        store = WatermarkStore(runtime, args.state_dir)
        if args.action == "show":
            print(f"[{runtime}] {store.token()} ({len(store.entries)} sources) at {store.path}")
            if args.verbose:
                for key, entry in sorted(store.entries.items()):
                    print(f"  {key}: offset={entry.get('offset')} size={entry.get('size')} "
                          f"updated={entry.get('updatedAt')}")
        elif args.action == "reset":
            removed = store.reset(args.source)
            print(f"[{runtime}] reset {removed} watermark entr{'y' if removed == 1 else 'ies'}"
                  + (f" (source={args.source})" if args.source else " (all)"))
    return 0



def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="memory_review", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_collect = sub.add_parser("collect", help="run collectors locally")
    p_collect.add_argument("--runtime", action="append",
                           choices=list(RUNTIME_COLLECTORS) + ["all"])
    p_collect.add_argument("--dry-run", action="store_true")
    p_collect.add_argument("--show-observations", action="store_true",
                           help="print eligible observation texts (already sanitized)")
    _add_common(p_collect)
    p_collect.set_defaults(func=cmd_collect)

    p_run = sub.add_parser("run", help="full orchestration against AgentX")
    p_run.add_argument("--runtime", action="append",
                       choices=list(RUNTIME_COLLECTORS) + ["all"])
    p_run.add_argument("--mode", choices=["shadow", "review"], default="shadow",
                       help="apply mode is a server-side gate, never a CLI flag")
    p_run.add_argument("--agentx-url", default="http://127.0.0.1:3180")
    p_run.add_argument("--run-key", default=None)
    p_run.add_argument(
        "--model", default=os.environ.get("AGENTX_MEMORY_REVIEW_MODEL", synthesis.DEFAULT_MODEL),
        help="verified canonical Hermes model id (or AGENTX_MEMORY_REVIEW_MODEL)",
    )
    p_run.add_argument("--max-tokens", type=int, default=synthesis.DEFAULT_MAX_TOKENS)
    p_run.add_argument("--timeout", type=int, default=30)
    p_run.add_argument("--inference-timeout", type=int, default=synthesis.DEFAULT_TIMEOUT_S)
    p_run.add_argument("--dry-run", action="store_true")
    p_run.add_argument(
        "--submit-only", action="store_true",
        help="collect/submit and leave the shared run open; do not finalize or call a model",
    )
    p_run.add_argument("--show-observations", action="store_true")
    _add_common(p_run)
    p_run.set_defaults(func=cmd_run)

    p_report = sub.add_parser("report", help="render a run report locally")
    p_report.add_argument("--run-id", default=None)
    p_report.add_argument("--agentx-url", default="http://127.0.0.1:3180")
    p_report.add_argument("--timeout", type=int, default=30)
    p_report.add_argument("--state-dir", type=Path, default=None)
    p_report.set_defaults(func=cmd_report)

    p_digest = sub.add_parser("digest", help="read-only briefing digest")
    p_digest.add_argument("--agentx-url", default="http://127.0.0.1:3180")
    p_digest.add_argument("--timeout", type=int, default=30)
    p_digest.set_defaults(func=cmd_digest)

    p_wm = sub.add_parser("watermarks", help="inspect/reset local watermarks")
    p_wm.add_argument("action", choices=["show", "reset"])
    p_wm.add_argument("--runtime", action="append", choices=list(RUNTIME_COLLECTORS))
    p_wm.add_argument("--source", default=None, help="reset a single source key")
    p_wm.add_argument("--verbose", action="store_true")
    p_wm.add_argument("--state-dir", type=Path, default=None)
    p_wm.set_defaults(func=cmd_watermarks)

    return parser


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
