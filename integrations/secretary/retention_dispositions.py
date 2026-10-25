#!/usr/bin/env python3
"""Write owner dispositions for the retention planner from Core decisions.

For each archived message before the cutoff, record its value lane
(value_lanes.py) and, for every finding of the message, the owner's decisions
in Core's historical review: an entry imported for that exact finding, or a
consolidated souvenir candidate that cites it (from the private candidate
manifests). The planner then accepts bulk mail, or person/important mail whose
every finding the owner decided, in place of an exact-message analysis.

Read-only: Core is only read, Gmail is never contacted, and the output is a
private file outside the archive. It grants no mailbox permission.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path
import sys
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent))
from evidence_store import load, now, save  # noqa: E402
from history_coverage import content_hash, coverage, cutoff_date  # noqa: E402
from retention_plan import DISPOSITION_CONTRACT, rolling_cutoff  # noqa: E402
from secretary_evidence import DEFAULT_ROOT, Archive  # noqa: E402
from value_lanes import LANES_NAME  # noqa: E402

BASIS = {"bulk": "bulk-lane", "person": "owner-decided", "important": "owner-decided"}


def core_entries(core, opener=urllib.request.urlopen):
    """Every non-forgotten Gmail history entry, with its source and state."""
    entries, offset = [], 0
    while offset is not None:
        url = f"{core.rstrip('/')}/api/secretary/history?limit=100&offset={offset}&state=&source=gmail"
        with opener(url, timeout=60) as response:
            data = json.loads(response.read())["data"]
        entries.extend(data["entries"])
        offset = data["nextOffset"]
    return entries


def dispositions(archive, before, entries, manifests=(), at=None):
    lanes_file = archive.root / LANES_NAME
    lanes = load(lanes_file, {}).get("messages", {})
    lanes_sha = content_hash(load(lanes_file, {}))
    # A consolidated candidate's import finding id stands for all the findings it merged.
    merged = {entry["source"]["findingId"]: entry.get("findingIds", [])
              for manifest in manifests for entry in manifest.get("entries", [])}
    by_finding, citing = defaultdict(list), defaultdict(list)
    for entry in entries:
        source = entry.get("source") or {}
        decision = {"entryId": entry["id"], "state": entry["reviewState"], "revision": entry.get("revision"),
                    **({"souvenirNoteId": entry["souvenirNoteId"]} if entry.get("souvenirNoteId") else {})}
        for finding in merged.get(source.get("findingId"), [source.get("findingId")]):
            by_finding[finding].append(decision)
        for cited in [source, *(entry.get("relatedSources") or [])]:
            if cited.get("messageId"):
                citing[cited["messageId"]].append(decision)
    out, counts = [], Counter()
    for row in coverage(archive, before)["messages"]:
        lane = lanes.get(row["messageId"])
        basis = BASIS.get((lane or {}).get("lane"))
        if not basis:
            counts["unlabelled"] += 1
            continue
        findings = {identity: {"section": section, "decidedBy": by_finding.get(identity, [])}
                    for section, identities in row["findingIds"].items() for identity in identities}
        undecided = sorted({d["entryId"] for d in citing.get(row["messageId"], []) if d["state"] == "candidate"})
        out.append({"schema": DISPOSITION_CONTRACT, "at": at or now(),
                    "messageId": row["messageId"], "threadId": row["threadId"], "sourceSha256": row["originalSha256"],
                    "evidenceHash": row["evidenceHash"], "reviewSha256": row["reviewSha256"], "basis": basis,
                    "lane": {"lane": lane["lane"], "reason": lane.get("reason"), "valueLanesSha256": lanes_sha},
                    "findings": findings, "undecidedEntries": undecided,
                    "generator": "retention_dispositions.py", "grantsMailboxPermission": False})
        undecided_findings = any(not f["decidedBy"] or any(d["state"] == "candidate" for d in f["decidedBy"])
                                 for f in findings.values())
        counts[f"{basis}:{'undecided' if undecided or undecided_findings else 'decided'}"] += 1
    return out, dict(counts)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    when = parser.add_mutually_exclusive_group(required=True)
    when.add_argument("--before", type=cutoff_date)
    when.add_argument("--older-than-days", type=int)
    parser.add_argument("--core", default="http://127.0.0.1:3180")
    parser.add_argument("--souvenir-manifest", type=Path, action="append", default=[],
                        help="private consolidated candidate manifest (souvenir_candidates.py --manifest)")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.output.resolve().is_relative_to(args.root.resolve()):
        parser.error("Dispositions stay outside the evidence archive")
    if args.output.exists():
        parser.error("Retain the existing dispositions and use a new output identity")
    before = args.before or rolling_cutoff(args.older_than_days)
    archive = Archive(args.root, run=lambda _: (_ for _ in ()).throw(RuntimeError("Provider access disabled")))
    rows, counts = dispositions(archive, before, core_entries(args.core), [load(p) for p in args.souvenir_manifest])
    save(args.output, rows)
    print(json.dumps({"before": before.isoformat(), "dispositions": len(rows), "counts": counts}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
