"""Counts of frozen archive files by mail-header year, never by life-event date."""
from datetime import datetime
from email.utils import parsedate_to_datetime
from pathlib import Path
import re

from evidence_store import load

CONTRACT = "secretary.annual-source-coverage/v1"
SYSTEMS = ("gmail", "outlook-export")
FIELDS = ("targetedSources", "availableSources", "reviewedSources", "coveredSources",
          "rejectedSources", "gapSources", "sourceErrors", "metadataErrors")


def _empty():
    return {key: 0 for key in FIELDS}


def _year(value):
    if not isinstance(value, str) or not value.strip():
        return None, "missingDates"
    try:
        date = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        try:
            date = parsedate_to_datetime(value)
        except (ValueError, TypeError, OverflowError):
            return None, "invalidDates"
    return date.year, None  # Native header calendar year; no timezone/year shift.


def _same(source, record):
    return all(source.get(key) == record.get(key) for key in ("system", "id", "sha256", "path"))


def _mail_date(root, source, plan, threads):
    record = plan.get("source")
    if record and "mailDate" in record:
        return (record["mailDate"], None) if _same(source, record) else (None, "identityMismatches")
    if source["system"] == "outlook-export":
        return source.get("sourceDate"), None  # Frozen container's RFC Date header.
    # Gmail sourceDate is internalDate (provider milliseconds), not a Date
    # header. Do not turn it, retrieval time or filesystem mtime into mail dates.
    if any(not isinstance(source.get(k), str) or not re.fullmatch(r"[a-zA-Z0-9_-]+", source[k]) for k in ("id", "threadId")):
        return None, "identityMismatches"
    receipt = load(root / "raw-receipts" / (source["id"] + ".json"), {})
    if receipt.get("messageId") != source["id"] or any(receipt.get(k) != source.get(k) for k in ("sha256", "path", "threadId")):
        return None, "identityMismatches"
    thread_id = source.get("threadId")
    if thread_id not in threads:
        manifest = load(root / "threads" / str(thread_id) / "manifest.json", {})
        threads[thread_id] = manifest if manifest.get("threadId") == thread_id else {}
    messages = [m for m in threads[thread_id].get("messages", []) if m.get("id") == source["id"]]
    if len(messages) != 1 or not isinstance(messages[0].get("headers"), dict):
        return None, "identityMismatches"
    headers = {str(k).lower(): v for k, v in messages[0]["headers"].items()}
    return headers.get("date"), None


def aggregate(root, manifest, entries):
    """Export-time metadata reads only. No MIME body, model or new collection."""
    root = Path(root).resolve()
    buckets, threads = {}, {}
    metadata = {"missingDates": 0, "invalidDates": 0, "identityMismatches": 0, "unavailableFiles": 0}
    totals, systems = _empty(), {system: _empty() for system in SYSTEMS}
    for source, plan, row in entries:
        system = source.get("system")
        if system not in SYSTEMS:
            return {"schema": CONTRACT, "status": "unavailable", "reason": "unsupported-source-system"}
        try:
            value, reason = _mail_date(root, source, plan, threads)
            year, date_error = _year(value)
            reason = reason or date_error
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            year, reason = None, "identityMismatches"
        if reason:
            metadata[reason] += 1
            year = None
        try:
            file = (root / str(source.get("path", ""))).resolve()
            available = bool(source.get("path")) and file.is_relative_to(root) and file.is_file() \
                and type(source.get("bytes")) is int and file.stat().st_size == source["bytes"]
        except OSError:
            available = False
        metadata["unavailableFiles"] += not available
        if year not in buckets:
            buckets[year] = {"year": year, "totals": _empty(), "bySystem": {s: _empty() for s in SYSTEMS}}
        counts = {"targetedSources": 1, "availableSources": int(available),
                  "reviewedSources": int(row.get("textReviewComplete") is True),
                  "coveredSources": int(row.get("textCovered") is True),
                  "rejectedSources": int(row.get("rejectedPages", 0) > 0),
                  "gapSources": int(bool(row.get("gaps") or row.get("error") or reason or not available)),
                  "sourceErrors": int(bool(row.get("error"))), "metadataErrors": int(bool(reason))}
        for key, value in counts.items():
            totals[key] += value
            systems[system][key] += value
            buckets[year]["totals"][key] += value
            buckets[year]["bySystem"][system][key] += value
    years = [buckets[k] for k in sorted(k for k in buckets if k is not None)]
    if len(years) > 512:
        return {"schema": CONTRACT, "status": "unavailable", "reason": "year-bucket-limit", "totals": totals}
    unknown = buckets.get(None, {"year": None, "totals": _empty(), "bySystem": {s: _empty() for s in SYSTEMS}})
    assert totals["targetedSources"] == len(manifest["sources"])
    return {"schema": CONTRACT, "status": "available", "dateBasis": "archived-mail-header-year",
            "availabilityBasis": "presence-and-size-only", "totals": totals, "bySystem": systems,
            "years": years, "unknown": unknown, "metadata": metadata}


def project(value):
    """Closed content-free transport, including when local files are malformed."""
    if not isinstance(value, dict) or value.get("schema") != CONTRACT:
        return None
    if value.get("status") == "unavailable":
        reason = value.get("reason")
        return {"schema": CONTRACT, "status": "unavailable", "reason": reason} \
            if reason in ("unsupported-source-system", "year-bucket-limit") else None
    try:
        def counts(raw):
            if not isinstance(raw, dict) or any(type(raw.get(k)) is not int or not 0 <= raw[k] <= 9007199254740991 for k in FIELDS):
                raise ValueError("Invalid annual counts")
            result = {k: raw[k] for k in FIELDS}
            if any(n > result["targetedSources"] for n in result.values()):
                raise ValueError("Annual source count exceeds targets")
            return result

        def systems(raw):
            return {s: counts(raw[s]) for s in SYSTEMS}

        def bucket(raw, unknown=False):
            year = raw["year"]
            if unknown and year is not None or not unknown and (type(year) is not int or not 1 <= year <= 9999):
                raise ValueError("Invalid annual bucket")
            result = {"year": year, "totals": counts(raw["totals"]), "bySystem": systems(raw["bySystem"])}
            if any(sum(result["bySystem"][s][k] for s in SYSTEMS) != result["totals"][k] for k in FIELDS):
                raise ValueError("Annual system totals disagree")
            return result

        if value.get("status") != "available" or value.get("dateBasis") != "archived-mail-header-year" \
                or value.get("availabilityBasis") != "presence-and-size-only" \
                or not isinstance(value.get("years"), list) or len(value["years"]) > 512:
            return None
        years = [bucket(row) for row in value["years"]]
        if len({row["year"] for row in years}) != len(years):
            return None
        unknown, total, by_system = bucket(value["unknown"], True), counts(value["totals"]), systems(value["bySystem"])
        rows = [*years, unknown]
        if any(sum(row["totals"][k] for row in rows) != total[k] for k in FIELDS) \
                or any(sum(row["bySystem"][s][k] for row in rows) != by_system[s][k] for s in SYSTEMS for k in FIELDS):
            return None
        metadata = {k: value["metadata"][k] for k in ("missingDates", "invalidDates", "identityMismatches", "unavailableFiles")}
        if any(type(n) is not int or not 0 <= n <= total["targetedSources"] for n in metadata.values()) \
                or sum(metadata[k] for k in ("missingDates", "invalidDates", "identityMismatches")) != unknown["totals"]["targetedSources"] \
                or metadata["unavailableFiles"] != total["targetedSources"] - total["availableSources"]:
            return None
        return {"schema": CONTRACT, "status": "available", "dateBasis": value["dateBasis"],
                "availabilityBasis": value["availabilityBasis"], "totals": total, "bySystem": by_system,
                "years": sorted(years, key=lambda row: row["year"]), "unknown": unknown, "metadata": metadata}
    except (ValueError, TypeError, KeyError):
        return None
