"""Read native world evidence offline; never infer action success from a rollout.

Clawblox SQLite inputs prove attempts only. GraphysX NDJSON action rows also
carry the result of that particular command. Neither reader invokes a model.
"""
from __future__ import annotations

import json
import math
import re
import sqlite3
from collections import Counter
from pathlib import Path

ACTION = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")


def read_actions(path: Path, *, agent=None, start_tick=None, end_tick=None):
    if any(t is not None and (isinstance(t, bool) or not isinstance(t, int) or t < 0)
           for t in (start_tick, end_tick)) or (start_tick is not None and end_tick is not None and start_tick > end_tick):
        raise ValueError("recording tick bounds must be nonnegative and ordered")
    if not path.is_file(): raise ValueError("world recording is missing")
    selected = lambda tick: (start_tick is None or tick >= start_tick) and (end_tick is None or tick <= end_tick)
    actions, results = Counter(), Counter()
    unknown_place, malformed, rewinds = 0, 0, 0
    if path.suffix == '.clawrec':
        try:
            with sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True) as db:
                # A local recording has one player. A name is not a native UUID;
                # reject mixed-player evidence rather than attributing all inputs.
                identities = {r[0] for r in db.execute('SELECT DISTINCT agent_id FROM inputs')}
                if len(identities) > 1:
                    raise ValueError("mixed-agent Clawblox recording cannot be attributed by name")
                for tick, kind in db.execute('SELECT tick,input_type FROM inputs ORDER BY tick'):
                    if not isinstance(tick, int) or not isinstance(kind, str) or not ACTION.fullmatch(kind):
                        malformed += 1
                    elif selected(tick): actions[kind] += 1
        except sqlite3.Error as error:
            raise ValueError("invalid Clawblox input recording") from error
        source, result_evidence = 'clawblox-sqlite', False
        unknown_place = actions['Place']
    else:
        if not isinstance(agent, str) or not agent.strip():
            raise ValueError("GraphysX recording requires the exact agent name")
        hello, rows, last_tick = False, [], None
        with path.open(errors='replace') as stream:
            for line in stream:
                if not line.strip(): continue
                try: entry = json.loads(line)
                except ValueError:
                    malformed += 1
                    continue
                if not isinstance(entry, dict):
                    malformed += 1
                    continue
                tick = entry.get('tick')
                if not isinstance(tick, int) or isinstance(tick, bool) or tick < 0:
                    malformed += 1
                    continue
                if entry.get('kind') == 'hello':
                    if entry.get('format') != 'graphysx-world-stream/v1':
                        raise ValueError("unsupported GraphysX recording format")
                    if hello:
                        # A resumed branch supersedes every old action after
                        # this tick, as in GraphysX's native replay parser.
                        rows = [r for r in rows if r['tick'] <= tick]
                        rewinds += 1
                    hello, last_tick = True, tick
                elif not hello:
                    raise ValueError("GraphysX recording has no initial hello")
                elif entry.get('kind') == 'action':
                    if last_tick is not None and tick < last_tick:
                        raise ValueError("world actions are not ordered within a recording branch")
                    last_tick = tick
                    rows.append(entry)
        if not hello: raise ValueError("GraphysX recording has no initial hello")
        for entry in rows:
            if entry.get('agent') != agent or not selected(entry['tick']): continue
            command = entry.get('input')
            kind = command.get('type') if isinstance(command, dict) else None
            if not isinstance(kind, str) or not ACTION.fullmatch(kind):
                malformed += 1
                continue
            actions[kind] += 1
            result = entry.get('result')
            exact = isinstance(result, str) and (result == kind + 'Success' or result.startswith(kind + 'Failed:'))
            if exact: results[result] += 1
            elif kind == 'Place': unknown_place += 1
        source, result_evidence = 'graphysx-ndjson', True
    complete = malformed == 0
    return {'source': source, 'complete': complete, 'malformedRows': malformed,
            'agent': agent, 'startTick': start_tick, 'endTick': end_tick, 'rewinds': rewinds,
            'actions': dict(actions), 'totalActions': sum(actions.values()),
            'results': dict(results) if result_evidence else None,
            'placeResultsComplete': complete and result_evidence and unknown_place == 0}


def run_hours(receipt, state):
    """Native episode windows exclude context-reset downtime and final cleanup."""
    from datetime import datetime

    def duration(start, end):
        try:
            a, b = (datetime.fromisoformat(str(v).replace('Z', '+00:00')) for v in (start, end))
            seconds = (b - a).total_seconds()
            return seconds / 3600 if math.isfinite(seconds) and seconds > 0 else None
        except (ValueError, TypeError): return None

    episodes = receipt.get('episodes')
    if isinstance(episodes, list) and episodes:
        values = [duration(e.get('startedAt'), e.get('endedAt')) if isinstance(e, dict) else None for e in episodes]
        return (sum(values), 'native-episodes') if all(v is not None for v in values) else (None, 'incomplete-episodes')
    value = duration(state.get('startedAt') or receipt.get('started_at'), state.get('endedAt') or receipt.get('ended_at'))
    return value, 'native-run-window' if value is not None else 'unavailable'
