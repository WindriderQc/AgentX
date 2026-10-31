"""Incremental, bounded-memory observation of native session model activity.

Image tool results can exceed a log tail by megabytes. Skip oversized records
without forgetting the last genuine model record or rereading old image bytes.
Only one selected session is cached; an hourly reset starts its own observation.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import stat
import time
from pathlib import Path

MAX_RECORD = 65536
_selected = None
_cache = None


def latest_activity(sessions: Path, since: float | None = None):
    global _selected, _cache
    files = [p for p in sessions.rglob('*.jsonl') if p.is_file() and not p.is_symlink()] if sessions.is_dir() else []
    if since is not None: files = [p for p in files if p.stat().st_mtime >= since]
    if not files: return None
    newest = max(files, key=lambda p: p.stat().st_mtime)
    try: fd = os.open(newest, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError: return None
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode): return None
        identity = info.st_dev, info.st_ino
        same_prefix = True
        if _selected == newest and _cache and info.st_size >= _cache['offset']:
            stream.seek(max(0, _cache['offset'] - 32))
            same_prefix = stream.read(min(32, _cache['offset'])) == _cache['anchor']
        if (_selected != newest or not _cache or _cache['identity'] != identity
                or info.st_size < _cache['offset']
                or not same_prefix
                or (info.st_size == _cache['offset'] and info.st_mtime_ns != _cache['mtime'])):
            _selected = newest
            _cache = {'identity': identity, 'offset': 0, 'mtime': None, 'buffer': b'',
                      'discard': False, 'payload': {}, 'modelAt': None, 'anchor': b''}
        c = _cache
        stream.seek(c['offset'])
        # Snapshot the end: appending faster than we read cannot prolong a poll.
        remaining = info.st_size - c['offset']
        while remaining > 0:
            chunk = stream.read(min(MAX_RECORD, remaining))
            if not chunk: break
            c['offset'] += len(chunk)
            remaining -= len(chunk)
            for segment in chunk.splitlines(keepends=True):
                if not c['discard']:
                    if len(c['buffer']) + len(segment) > MAX_RECORD:
                        c['buffer'], c['discard'] = b'', True
                    else: c['buffer'] += segment
                if not segment.endswith(b'\n'): continue
                if not c['discard']:
                    try: value = json.loads(c['buffer'])
                    except (ValueError, UnicodeError): value = None
                    if isinstance(value, dict):
                        payload = value.get('payload')
                        payload = payload if isinstance(payload, dict) else {}
                        c['payload'] = payload
                        meaningful = (value.get('type') == 'response_item'
                                      and payload.get('type') in ('message', 'reasoning', 'function_call', 'custom_tool_call')
                                      and payload.get('role', 'assistant') == 'assistant')
                        if meaningful:
                            try: c['modelAt'] = dt.datetime.fromisoformat(value['timestamp'].replace('Z', '+00:00')).timestamp()
                            except (KeyError, TypeError, ValueError, AttributeError): c['modelAt'] = info.st_mtime
                c['buffer'], c['discard'] = b'', False
        c['mtime'] = info.st_mtime_ns
        stream.seek(max(0, c['offset'] - 32))
        c['anchor'] = stream.read(min(32, c['offset']))
    age = max(0, time.time() - c['modelAt']) if c['modelAt'] is not None else float('inf')
    return {'age': age, 'payload': c['payload'], 'modelActivity': c['modelAt'] is not None}
