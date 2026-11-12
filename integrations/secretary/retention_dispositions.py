#!/usr/bin/env python3
"""Write owner dispositions for the retention planner from Core decisions.

For each archived message before the cutoff, record its value lane
(value_lanes.py) and, for every finding of the message, the owner's decisions
in Core's historical review: an entry imported for that exact finding, or a
consolidated souvenir candidate that cites it (from the private candidate
manifests). These snapshots are information for review, not current native
acceptance, source-analysis qualification or mailbox authority.

Read-only: Core is only read, Gmail is never contacted, and the output is a
private file outside the archive. It grants no mailbox permission.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path
import re
import sys
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent))
from evidence_store import load, now  # noqa: E402
from history_coverage import content_hash, coverage, cutoff_date  # noqa: E402
from retention_plan import DISPOSITION_CONTRACT, rolling_cutoff, review_packet  # noqa: E402
from review_receipts import durable  # noqa: E402
from secretary_evidence import DEFAULT_ROOT, Archive  # noqa: E402
from value_lanes import LANES_NAME  # noqa: E402

BASIS = {"bulk": "bulk-lane", "person": "owner-decided", "important": "owner-decided"}


def core_entries(core, opener=urllib.request.urlopen):
    """A bounded, complete observation; pagination is not an atomic snapshot."""
    entries, offset, total, seen = [], 0, None, set()
    pages, received = 0, 0
    while offset is not None:
        pages += 1
        if pages > 200:
            raise ValueError("Core history observation exceeds 200 pages")
        url = f"{core.rstrip('/')}/api/secretary/history?limit=100&offset={offset}&state=&source=gmail"
        request = urllib.request.Request(url, headers={"x-service-caller": "secretary-retention-review"})
        with opener(request, timeout=60) as response:
            payload = response.read(16 * 1024 * 1024 + 1)
        if len(payload) > 16 * 1024 * 1024:
            raise ValueError("Core history page exceeds its bounded capacity")
        received += len(payload)
        if received > 64 * 1024 * 1024:
            raise ValueError("Core history observation exceeds its bounded capacity")
        result = json.loads(payload)
        data = result.get("data") if isinstance(result, dict) and result.get("ok") is True else None
        if not isinstance(data, dict) or data.get("authority") != "agentx.core" \
                or type(data.get("total")) is not int or not 0 <= data["total"] <= 20000 \
                or not isinstance(data.get("entries"), list) or len(data["entries"]) > 100 \
                or "nextOffset" not in data:
            raise ValueError("Core history observation is incomplete or invalid")
        if total is None:
            total = data["total"]
        if data["total"] != total:
            raise ValueError("Core history changed during pagination")
        for entry in data["entries"]:
            if not isinstance(entry, dict) or not isinstance(entry.get("id"), str) \
                    or not re.fullmatch(r"[a-f0-9]{24}", entry["id"]) \
                    or entry["id"] in seen or type(entry.get("revision")) is not int or entry["revision"] < 0 \
                    or entry.get("reviewState") not in ("candidate", "retained", "dismissed", "resolved") \
                    or not isinstance(entry.get("source"), dict) or entry["source"].get("system") != "gmail":
                raise ValueError("Core history returned an invalid or repeated entry")
            seen.add(entry["id"])
        entries.extend(data["entries"])
        expected = offset + len(data["entries"])
        following = data.get("nextOffset")
        if expected > total or (expected == total and following is not None) \
                or (expected < total and (not data["entries"] or type(following) is not int or following != expected)):
            raise ValueError("Core history pagination did not cover its declared scope")
        offset = following
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
        if entry.get("reviewState") == "forgotten":
            continue
        source = entry.get("source") or {}
        decision = {"entryId": entry["id"], "state": entry["reviewState"], "revision": entry.get("revision"),
                    "kind": entry.get("kind"),
                    "entrySha256": content_hash(entry), "decision": entry.get("decision"),
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
        undecided = sorted({d["entryId"] for d in citing.get(row["messageId"], [])
                            if d["state"] == "candidate" or
                            (d["state"] == "retained" and d["kind"] in ("action", "deliverable"))})
        out.append({"schema": DISPOSITION_CONTRACT, "at": at or now(),
                    "messageId": row["messageId"], "threadId": row["threadId"], "sourceSha256": row["originalSha256"],
                    "evidenceHash": row["evidenceHash"], "reviewSha256": row["reviewSha256"], "basis": basis,
                    "reviewPacketSha256": content_hash(review_packet(archive, row)),
                    "lane": {"lane": lane["lane"], "reason": lane.get("reason"), "valueLanesSha256": lanes_sha},
                    "findings": findings, "undecidedEntries": undecided,
                    "generator": "retention_dispositions.py", "grantsMailboxPermission": False})
        undecided_findings = any(not f["decidedBy"] or any(d["state"] == "candidate" or
            (f["section"] in ("actions", "deliverables") and d["state"] == "retained")
            for d in f["decidedBy"]) for f in findings.values())
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
    durable(args.output, rows, exclusive=True)
    print(json.dumps({"before": before.isoformat(), "dispositions": len(rows), "counts": counts}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
