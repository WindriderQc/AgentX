"""Bounded recurrence and read-only source gates; no executor effects here."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
from urllib.request import urlopen
from zoneinfo import ZoneInfo

from .store import JobError


def instant(value):
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(timezone.utc)


def validate(schedule):
    if not isinstance(schedule, dict) or schedule.get("type") not in {"interval", "daily"}:
        raise JobError("INVALID_SCHEDULE", "Choose an interval or a daily schedule.", 400)
    try:
        ZoneInfo(schedule.get("timezone", "UTC"))
    except (KeyError, ValueError):
        raise JobError("INVALID_TIMEZONE", "The schedule time zone is invalid.", 400)
    if schedule["type"] == "interval":
        minutes = schedule.get("minutes")
        if isinstance(minutes, bool) or not isinstance(minutes, int) or not 5 <= minutes <= 1440:
            raise JobError("INVALID_INTERVAL", "The interval must be between 5 and 1440 minutes.", 400)
        if schedule.get("anchorAt"):
            try:
                instant(schedule["anchorAt"])
            except (ValueError, TypeError):
                raise JobError("INVALID_ANCHOR", "The interval anchor is invalid.", 400)
    else:
        at = schedule.get("at", "")
        try:
            if len(at) != 5 or at[2] != ":":
                raise ValueError()
            hour, minute = map(int, at.split(":"))
            if not 0 <= hour <= 23 or not 0 <= minute <= 59:
                raise ValueError()
        except (ValueError, TypeError):
            raise JobError("INVALID_TIME", "Choose a valid daily time.", 400)
    return dict(schedule)


def window(schedule, at=None):
    validate(schedule)
    at = at or datetime.now(timezone.utc)
    if schedule["type"] == "interval":
        seconds = schedule["minutes"] * 60
        anchor = instant(schedule.get("anchorAt", "2020-01-01T00:00:00Z"))
        steps = int((at - anchor).total_seconds() // seconds)
        previous = anchor + timedelta(seconds=steps * seconds)
        return previous, previous + timedelta(seconds=seconds)
    zone = ZoneInfo(schedule.get("timezone", "UTC"))
    local = at.astimezone(zone)
    hour, minute = map(int, schedule["at"].split(":"))
    due = local.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if due > local:
        previous, following = due - timedelta(days=1), due
    else:
        previous, following = due, due + timedelta(days=1)
    return previous.astimezone(timezone.utc), following.astimezone(timezone.utc)


def fingerprint(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def source_marker(job, previous=None):
    gate = job.get("gate")
    if not gate:
        return {"ready": True, "marker": None, "label": ""}
    try:
        if gate["type"] == "core-backup":
            # Cache acknowledged complete cycles so the native supervisor retains
            # an available recovery source while the application is unavailable.
            try:
                with urlopen(gate["url"], timeout=8) as response:
                    body = json.load(response)
                schedule = body["config"]["policyEvidence"]["schedule"]
                stamp = schedule.get("lastSuccessAt")
                if not stamp:
                    return {"ready": False, "code": "WAITING_BACKUP", "label": "Waiting for a completed backup"}
                marker = fingerprint(stamp)
                return {"ready": True, "marker": marker, "sourceAt": stamp, "label": "After a completed Core backup"}
            except Exception:
                if previous and previous.get("ready") and previous.get("marker"):
                    return {**previous, "cached": True}
                raise
        if gate["type"] == "snapshot":
            root = Path(gate["path"])
            names = sorted(p.name for p in root.iterdir() if p.is_dir())
            if not names:
                return {"ready": False, "code": "WAITING_SNAPSHOT", "label": "Waiting for an archive snapshot"}
            return {"ready": True, "marker": fingerprint(names[-1]), "label": "After an archive snapshot"}
        if gate["type"] == "file":
            path = Path(gate["path"])
            raw = path.read_bytes()
            source_at = None
            if gate.get("dateField"):
                source_at = json.loads(raw).get(gate["dateField"])
            return {"ready": True, "marker": hashlib.sha256(raw).hexdigest(), "sourceAt": source_at,
                    "label": "After a new publication"}
    except Exception:
        return {"ready": False, "code": "SOURCE_UNAVAILABLE", "label": "The source is unavailable"}
    raise JobError("INVALID_GATE", "The job source is invalid.", 503)
