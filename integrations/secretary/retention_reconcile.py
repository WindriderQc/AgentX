#!/usr/bin/env python3
"""Reconcile a private saved disposition against fresh, read-only Core history.

Two complete agreeing reads are an observation, not an atomic snapshot or
cleanup acceptance. This command grants no authority and contacts no provider.
"""
from __future__ import annotations

import argparse
from collections import Counter
import json
from pathlib import Path

from evidence_store import load, now
from history_coverage import content_hash, cutoff_date
from retention_dispositions import core_entries, dispositions
from retention_plan import DISPOSITION_CONTRACT, NATIVE_GAPS
from review_receipts import durable
from secretary_evidence import Archive, DEFAULT_ROOT


def indexed(rows):
    if not isinstance(rows, list):
        raise ValueError("Use a saved disposition array")
    result = {}
    for row in rows:
        if not isinstance(row, dict) or row.get("schema") != DISPOSITION_CONTRACT \
                or not isinstance(row.get("messageId"), str) or not row["messageId"] \
                or row["messageId"] in result:
            raise ValueError("Saved dispositions are invalid, ambiguous or unsupported")
        result[row["messageId"]] = row
    return result


def comparable(row):
    # Observation time is deliberately excluded; source, decisions, revision,
    # entry hash, current page set and value-lane pins all remain compared.
    return {key: value for key, value in row.items() if key != "at"}


def entry_set(entries):
    return content_hash(sorted(entries, key=lambda entry: entry["id"]))


def reconcile(archive, before, saved, core, manifests=(), *, opener=None, native_decisions=False, message_scope=False):
    previous = indexed(saved)
    manifests = list(manifests)
    options = {} if opener is None else {"opener": opener}
    if message_scope:
        from native_history_message_scope import discover, confirm
        native_decisions = True
        first, scopes_first = discover(core, saved, **options)
    else:
        first = core_entries(core, **options)
    first_rows, _ = dispositions(archive, before, first, manifests)
    if native_decisions:
        from native_history_decisions import capture
        native_first = capture(core, first, first_rows, saved, **options)
        if message_scope:
            confirm(native_first, scopes_first)
    if message_scope:
        second, scopes_second = discover(core, saved, previous=scopes_first, **options)
    else:
        second = core_entries(core, **options)
    second_rows, _ = dispositions(archive, before, second, manifests)
    if native_decisions:
        native_second = capture(core, second, second_rows, saved, previous=native_first, **options)
        if message_scope:
            confirm(native_second, scopes_second)
    if entry_set(first) != entry_set(second) \
            or content_hash([comparable(row) for row in first_rows]) != content_hash([comparable(row) for row in second_rows]):
        raise ValueError("Core or archive changed during reconciliation; no current observation was established")
    current = indexed(second_rows)
    rows, counts = [], Counter()
    # Reconciliation covers exactly the selected saved messages. A current
    # unrelated message cannot widen that scope or become a cleanup candidate.
    for mid, row in previous.items():
        fresh = current.get(mid)
        status = "absent" if fresh is None else "observed_match" \
            if comparable(row) == comparable(fresh) else "changed"
        counts[status] += 1
        rows.append({"messageId": mid, "status": status,
                     "savedSha256": content_hash(row),
                     "observedContentSha256": content_hash(comparable(fresh)) if fresh else None,
                     "savedContentSha256": content_hash(comparable(row)),
                     "changedFields": sorted(key for key in set(row) | set(fresh or {})
                                             if key != "at" and row.get(key) != (fresh or {}).get(key)),
                     "executionAllowed": False})
    native = {"nativeDecisions": {"contract": "agentx.history-decision-state/v1", "entries": native_second,
              "scope": "selected-entries-only", "pendingEntries": sum(row["pendingSourceDecisions"] > 0 for row in native_second),
              "consistency": "single-entry committed observations; not an atomic batch or completeness proof",
              "status": "observed_match" if native_second else "no_selected_entries", "executionAllowed": False}} if native_decisions else {}
    if message_scope:
        native["nativeDecisions"].update({"discoveryContract": "agentx.history-message-scope/v1", "messageScopes": scopes_second})
    return {"schema": f"agentx.secretary-retention-reconciliation/v{3 if message_scope else 2 if native_decisions else 1}", "at": now(),
            "before": before.isoformat(), "decisionSource": "agentx.core",
            "observation": "two agreeing bounded reads; not an atomic snapshot or native acceptance",
            "savedDispositionsSha256": content_hash(saved), "coreEntriesSha256": entry_set(second),
            "manifestsSha256": content_hash(list(manifests)), "counts": dict(counts), "messages": rows,
            "nativeValidationGaps": list(NATIVE_GAPS), "cleanupStatus": "blocked", "executionAllowed": False, **native}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--before", type=cutoff_date, required=True)
    parser.add_argument("--dispositions", type=Path, required=True)
    parser.add_argument("--core", default="http://127.0.0.1:3180")
    parser.add_argument("--souvenir-manifest", type=Path, action="append", default=[])
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--native-decisions", action="store_true",
                        help="Recheck at most 100 selected Core decision documents through their native contract; no legacy fallback")
    parser.add_argument("--native-message-scope", action="store_true",
                        help="Discover 1-20 exact saved messages across primary and related Core references; implies native decision checks")
    args = parser.parse_args(argv)
    if args.output.resolve().is_relative_to(args.root.resolve()):
        parser.error("Reconciliation reports stay outside the evidence archive")
    if args.output.exists():
        parser.error("Retain the existing report and use a new output identity")
    archive = Archive(args.root, run=lambda _: (_ for _ in ()).throw(RuntimeError("Provider access disabled")))
    report = reconcile(archive, args.before, load(args.dispositions), args.core,
                       [load(path) for path in args.souvenir_manifest], native_decisions=args.native_decisions,
                       message_scope=args.native_message_scope)
    durable(args.output, report, exclusive=True)
    summary = {key: report[key] for key in ("schema", "at", "counts", "cleanupStatus", "executionAllowed")}
    if args.native_decisions or args.native_message_scope:
        native = report["nativeDecisions"]
        summary["nativeDecisions"] = {"status": native["status"], "selectedEntries": len(native["entries"]),
                                     "pendingEntries": native["pendingEntries"]}
    print(json.dumps(summary))
    return 0 if all(row["status"] == "observed_match" for row in report["messages"]) \
        and not report.get("nativeDecisions", {}).get("pendingEntries") else 2


if __name__ == "__main__":
    raise SystemExit(main())
