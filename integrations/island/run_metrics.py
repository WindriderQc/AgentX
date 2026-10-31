#!/usr/bin/env python3
"""Model-free metrics of finished island runs, for comparing harnesses.

Reads only what a run already keeps: receipt/state/request, the agent's
rollouts (Codex native ones, or the DSH/pi turn loop's Codex-shaped ones)
and the memory left after the run. No model, no network, no world access.

    run_metrics.py RUN_DIR [RUN_DIR ...]          one JSON object per run
    run_metrics.py --summary RUN_DIR [...]        plus per-harness means

World actions come from native recordings. Pass --world-recording for a remote
GraphysX world; local Clawblox recordings are discovered in recordings/.
Missing evidence stays unknown. Tool-call counts remain diagnostic proxies;
a human replay review stays the reference for "invented games". Provider token
accounting belongs to Core, not the harness's incomplete rollout usage.
"""
from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from collections import Counter
from pathlib import Path

from world_metrics import read_actions, run_hours

ACTION = re.compile(r"\b(Place|Pickup|Throw|Drop|MoveTo|Jump|Chat)\b")
RESULT = re.compile(r"\b((?:Place|Pickup|Throw|Drop)(?:Success|Failed:[A-Za-z]+))\b")


def read_json(path: Path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def rollout_files(run: Path) -> list[Path]:
    files = []
    for agent in sorted((run / "agents").glob("*")):
        home = agent / "sandbox-home"
        files += sorted((home / ".codex" / "sessions").rglob("*.jsonl"))
        files += sorted((home / ".agentx-loop" / "sessions").glob("rollout-*.jsonl"))
    return files


def run_metrics(run: Path, *, recording=None, agent=None, start_tick=None, end_tick=None) -> dict:
    receipt = read_json(run / "receipt.json") or {}
    state = read_json(run / "state.json") or {}
    request = read_json(run / "request.json") or {}
    events = state.get("events") or receipt.get("events") or []
    counts, results, actions, tokens = Counter(), Counter(), Counter(), Counter()
    calls = {}
    for path in rollout_files(run):
        for line in path.read_text(errors="replace").splitlines():
            try:
                value = json.loads(line)
            except ValueError:
                continue
            if not isinstance(value, dict):
                continue
            payload = value.get("payload") if isinstance(value.get("payload"), dict) else {}
            kind = payload.get("type")
            if value.get("type") == "response_item":
                if kind == "message" and payload.get("role", "assistant") == "assistant":
                    counts["assistantMessages"] += 1
                elif kind == "reasoning":
                    counts["reasoning"] += 1
                elif kind in ("function_call", "custom_tool_call"):
                    counts["toolCalls"] += 1
                    arguments = str(payload.get("arguments") or payload.get("input") or "")
                    if "/input" in arguments:
                        calls[payload.get("call_id")] = True
                        counts["worldCommandCalls"] += 1
                        actions.update(ACTION.findall(arguments))
                elif kind in ("function_call_output", "custom_tool_call_output"):
                    if calls.get(payload.get("call_id")):
                        results.update(RESULT.findall(str(payload.get("output") or "")))
            elif value.get("type") == "event_msg":
                if kind == "task_complete":
                    counts["turns"] += 1
                elif kind == "error":
                    counts["turnErrors"] += 1
                elif kind == "token_count":
                    counts["modelResponses"] += 1
                    usage = (payload.get("info") or {}).get("last_token_usage") or {}
                    tokens["input"] += int(usage.get("input_tokens") or 0)
                    tokens["cachedInput"] += int(usage.get("cached_input_tokens") or 0)
                    tokens["output"] += int(usage.get("output_tokens") or 0)
    hours, duration_source = run_hours(receipt, state)
    outcome = state.get("outcome") or receipt.get("outcome")
    evidence = None
    evidence_error = None
    if outcome not in ('completed', 'failed', 'stopped'):
        evidence_error = 'run is not terminal'
    else:
        if recording is None:
            found = sorted((run / 'recordings').glob('*.clawrec'))
            if len(found) == 1: recording = found[0]
            else: evidence_error = 'world recording missing' if not found else 'multiple recordings need an explicit selection'
        if recording is not None:
            try:
                evidence = read_actions(Path(recording), agent=agent or request.get('agent') or receipt.get('agent'),
                                        start_tick=start_tick, end_tick=end_tick)
            except (OSError, ValueError) as error: evidence_error = str(error)
    world_results = evidence.get('results') if evidence else None
    place_known = bool(evidence and evidence['placeResultsComplete'])
    placed = (world_results or {}).get('PlaceSuccess', 0) if place_known else None
    place_failed = sum(n for k, n in (world_results or {}).items() if k.startswith('PlaceFailed:')) if place_known else None
    episodic = run / "memory-after" / "EPISODIC_MEMORY.jsonl"
    per_hour = (lambda n: round(n / hours, 1)) if hours else (lambda n: None)
    return {
        "run": run.name,
        "harness": receipt.get("harness") or request.get("harness") or "codex",
        "agent": receipt.get("agent") or request.get("agent"),
        "memory": request.get("memory"),
        "minutes": receipt.get("minutes") or request.get("minutes"),
        "outcome": outcome,
        "netcheck": bool(receipt.get("netcheck") or request.get("netcheck")),
        "resumes": Counter(e.get("reason") for e in events if e.get("event") == "resumed"),
        "episodes": len(receipt.get("episodes") or []),
        "activeHours": round(hours, 4) if hours is not None else None,
        "durationSource": duration_source,
        **{key: counts[key] for key in ("modelResponses", "turns", "assistantMessages", "reasoning", "toolCalls",
                                        "worldCommandCalls", "turnErrors")},
        "modelResponsesPerHour": per_hour(counts["modelResponses"]),
        "toolCallsPerHour": per_hour(counts["toolCalls"]),
        "worldMeasurement": {"evidence": evidence, "error": evidence_error},
        "worldActions": evidence['actions'] if evidence else None,
        "actionResults": world_results,
        "toolProxy": {"worldActions": dict(actions), "actionResults": dict(results)},
        "placeSuccess": placed,
        "placeSuccessRate": round(placed / (placed + place_failed), 3) if place_known and placed + place_failed else None,
        "placeSuccessPerHour": per_hour(placed) if place_known else None,
        "tokens": dict(tokens),
        "tokenSource": "harness-rollouts; use Core for provider accounting",
        "tokensPerHour": per_hour(tokens["input"] + tokens["output"]),
        "outputTokensPerPlace": None,
        "episodicEntries": sum(1 for line in episodic.read_text().splitlines() if line.strip()) if episodic.is_file() else None,
    }


def summary(rows: list[dict]) -> dict:
    keys = ("modelResponsesPerHour", "toolCallsPerHour", "placeSuccessPerHour", "placeSuccessRate", "tokensPerHour",
            "outputTokensPerPlace", "episodicEntries")
    out = {}
    for harness in sorted({row["harness"] for row in rows}):
        group = [row for row in rows if row["harness"] == harness and not row["netcheck"]]
        out[harness] = {"runs": len(group), "completed": sum(row["outcome"] == "completed" for row in group)}
        for key in keys:
            values = [row[key] for row in group if row[key] is not None and row['outcome'] == 'completed']
            out[harness][key] = {"n": len(values), "mean": round(statistics.fmean(values), 3), "min": min(values), "max": max(values)} if values else None
    return out


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("runs", nargs="+", type=Path)
    p.add_argument("--summary", action="store_true")
    p.add_argument("--world-recording", type=Path, help="native GraphysX NDJSON or explicit local Clawblox recording")
    p.add_argument("--agent", help="exact agent name in the remote recording; defaults to the run request")
    p.add_argument("--start-tick", type=int, help="inclusive recording boundary")
    p.add_argument("--end-tick", type=int, help="inclusive recording boundary")
    a = p.parse_args(argv)
    if len(a.runs) != 1 and any(v is not None for v in (a.world_recording, a.agent, a.start_tick, a.end_tick)):
        p.error('explicit recording selection needs exactly one run; never reuse one world across unrelated runs')
    rows = [run_metrics(run, recording=a.world_recording, agent=a.agent, start_tick=a.start_tick, end_tick=a.end_tick) for run in a.runs]
    print(json.dumps({"runs": rows, **({"summary": summary(rows)} if a.summary else {})}, indent=2, default=dict))
    return 0


if __name__ == "__main__":
    sys.exit(main())
