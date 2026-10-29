#!/usr/bin/env python3
"""Model-free metrics of finished island runs, for comparing harnesses.

Reads only what a run already keeps: receipt/state/request, the agent's
rollouts (Codex native ones, or the DSH/pi turn loop's Codex-shaped ones)
and the memory left after the run. No model, no network, no world access.

    run_metrics.py RUN_DIR [RUN_DIR ...]          one JSON object per run
    run_metrics.py --summary RUN_DIR [...]        plus per-harness means

World actions are read from the tool calls that send a command to the world
(`/input`) and the action results in those calls' own outputs, so repeated
observations of an old result are not counted twice. Scripts that send many
commands in one call are counted by the results they print. It is a proxy,
the same for every harness; a human replay review stays the reference for
"invented games".
"""
from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

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


def parse_time(value):
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def run_metrics(run: Path) -> dict:
    receipt = read_json(run / "receipt.json") or {}
    state = read_json(run / "state.json") or {}
    request = read_json(run / "request.json") or {}
    events = state.get("events") or receipt.get("events") or []
    counts, results, actions, tokens = Counter(), Counter(), Counter(), Counter()
    calls, first, last = {}, None, None
    for path in rollout_files(run):
        for line in path.read_text(errors="replace").splitlines():
            try:
                value = json.loads(line)
            except ValueError:
                continue
            if not isinstance(value, dict):
                continue
            stamp = parse_time(value.get("timestamp")) if value.get("timestamp") else None
            if stamp:
                first, last = min(first or stamp, stamp), max(last or stamp, stamp)
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
    hours = (last - first).total_seconds() / 3600 if first and last and last > first else 0
    placed = results["PlaceSuccess"]
    place_failed = sum(n for k, n in results.items() if k.startswith("PlaceFailed"))
    episodic = run / "memory-after" / "EPISODIC_MEMORY.jsonl"
    per_hour = (lambda n: round(n / hours, 1)) if hours else (lambda n: None)
    return {
        "run": run.name,
        "harness": receipt.get("harness") or request.get("harness") or "codex",
        "agent": receipt.get("agent") or request.get("agent"),
        "memory": request.get("memory"),
        "minutes": receipt.get("minutes") or request.get("minutes"),
        "outcome": state.get("outcome") or receipt.get("outcome"),
        "netcheck": bool(receipt.get("netcheck") or request.get("netcheck")),
        "resumes": Counter(e.get("reason") for e in events if e.get("event") == "resumed"),
        "episodes": len(receipt.get("episodes") or []),
        "activeHours": round(hours, 2),
        **{key: counts[key] for key in ("modelResponses", "turns", "assistantMessages", "reasoning", "toolCalls",
                                        "worldCommandCalls", "turnErrors")},
        "modelResponsesPerHour": per_hour(counts["modelResponses"]),
        "toolCallsPerHour": per_hour(counts["toolCalls"]),
        "worldActions": dict(actions),
        "actionResults": dict(results),
        "placeSuccess": placed,
        "placeSuccessRate": round(placed / (placed + place_failed), 3) if placed + place_failed else None,
        "placeSuccessPerHour": per_hour(placed),
        "tokens": dict(tokens),
        "tokensPerHour": per_hour(tokens["input"] + tokens["output"]),
        "outputTokensPerPlace": round(tokens["output"] / placed, 1) if placed else None,
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
            values = [row[key] for row in group if row[key] is not None]
            out[harness][key] = {"mean": round(statistics.fmean(values), 3), "min": min(values), "max": max(values)} if values else None
    return out


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("runs", nargs="+", type=Path)
    p.add_argument("--summary", action="store_true")
    a = p.parse_args(argv)
    rows = [run_metrics(run) for run in a.runs]
    print(json.dumps({"runs": rows, **({"summary": summary(rows)} if a.summary else {})}, indent=2, default=dict))
    return 0


if __name__ == "__main__":
    sys.exit(main())
