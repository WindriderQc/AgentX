#!/usr/bin/env python3
"""Record the people of person and important mail and of contact cards in Core.

Observations come from the private archive only: the From of received mail and
the To/Cc of the owner's sent mail (value_lanes.py person/important messages
with a preserved original), and the vCards found by structured_sources.py in
Gmail attachments and, when selected, one recorded Outlook export. The owner's
own addresses and automated senders are left out. Core finds a person again by
an exact address or phone and only proposes merges; nothing merges by itself.
The manifest and delivery state stay outside Git; the command prints counts.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import json
import os
import re
from pathlib import Path
import sys
import urllib.error
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent))
from email.utils import getaddresses  # noqa: E402
from evidence_store import load, now, save  # noqa: E402
from history_coverage import content_hash  # noqa: E402
from history_import import direction_of, preserved_source  # noqa: E402
from secretary_evidence import DEFAULT_ROOT, Archive  # noqa: E402
import structured_sources  # noqa: E402
from value_lanes import AUTOMATED, correspondents, lanes_of, messages  # noqa: E402

KEPT_LANES = ("person", "important")
ADDRESS = re.compile(r"[^\s@]+@[^\s@]+\.[^\s@]+")  # the same check Core applies
BATCH = 200


def when(message):
    try:
        stamp = int(message.get("internalDate") or 0)
    except (TypeError, ValueError):
        return None
    return datetime.fromtimestamp(stamp / 1000, timezone.utc).isoformat().replace("+00:00", "Z") if stamp > 0 else None


def mail_observations(archive, counts):
    rows = list(messages(archive))
    owner, _ = correspondents(rows)
    lanes = lanes_of(archive.root)
    for tid, message, labels in rows:
        if lanes.get(message["id"]) not in KEPT_LANES:
            counts["messagesNotPersonOrImportant"] += 1
            continue
        receipt = preserved_source(archive.root, message["id"])
        if receipt is None:
            counts["messagesWithoutPreservedOriginal"] += 1
            continue
        headers = message.get("headers") or {}
        direction = direction_of(labels)
        fields = ("to", "cc") if direction in ("sent", "draft") else ("from",)
        for field in fields:
            for name, address in getaddresses([headers.get(field) or ""]):
                address = address.strip().lower()
                if not ADDRESS.fullmatch(address) or address in owner or AUTOMATED.match(address.split("@")[0]):
                    counts["ownerAutomatedOrInvalidAddresses"] += 1
                    continue
                yield {"source": "gmail-header", "role": field, "direction": direction, "name": name.strip()[:300],
                       "email": address[:320], "occurredAt": when(message),
                       "ref": {"threadId": tid, "messageId": message["id"], "sourceSha256": receipt["sha256"]}}


def card_observations(root, outlook_export, counts):
    review = structured_sources.prepare(root, outlook_export, maximum=5000)
    for row in review["sources"]:
        system = "outlook-vcf" if any(o.get("system") == "outlook-export" for o in row["occurrences"]) else "gmail-vcf"
        for item in row["objects"]:
            if item["kind"] != "contact":
                continue
            values = lambda name, key="rawValue": [p.get(key) or p.get("rawValue") or "" for p in item["properties"] if p["name"] == name]
            name = next((v for v in values("FN", "text") if v.strip()), "")
            emails = [v.strip().lower() for v in values("EMAIL") if ADDRESS.fullmatch(v.strip())][:10]
            phones = [v for v in values("TEL") if v.strip()][:10]
            base = {"source": system, "role": "vcard", "name": name.strip()[:300], "phones": phones,
                    "organization": next((v for v in values("ORG", "text") if v.strip()), "").strip(" ;")[:300],
                    "note": "\n".join(values("NOTE", "text"))[:2000],
                    "ref": {"sourceSha256": row["sourceSha256"], "assertionId": item["sourceAssertionId"]}}
            counts["contactCards"] += 1
            for address in emails or [""]:
                if base["name"] or address or phones:
                    yield {**base, "email": address}


def prepare(archive, outlook_export=None):
    counts = Counter()
    observations = list(mail_observations(archive, counts)) + list(card_observations(archive.root, outlook_export, counts))
    counts["observations"] = len(observations)
    counts["mailObservations"] = sum(o["source"] == "gmail-header" for o in observations)
    return {"schema": "agentx.secretary-people-import/v1", "at": now(), "sourceRoot": str(archive.root),
            "outlookExport": outlook_export, "counts": dict(counts), "observations": observations}


def deliver(manifest, core, state_file, opener=urllib.request.urlopen):
    """Send batches in order; a lost answer replays the same batch, which Core keeps idempotent."""
    state = load(state_file, {"schema": "agentx.secretary-people-delivery/v1", "batches": {}})
    state["manifestSha256"] = content_hash(manifest)
    totals = Counter()
    for start in range(0, len(manifest["observations"]), BATCH):
        batch = manifest["observations"][start:start + BATCH]
        key = content_hash(batch)
        if key in state["batches"]:
            continue
        request = urllib.request.Request(core.rstrip("/") + "/api/secretary/people/observations", method="POST",
                                         headers={"content-type": "application/json"},
                                         data=json.dumps({"observations": batch}).encode())
        try:
            with opener(request, timeout=120) as response:
                body = json.loads(response.read())
            data = body.get("data") or {}
            if body.get("status") != "success" or data.get("created", 0) + data.get("replayed", 0) != len(batch):
                raise ValueError("Core returned an incomplete people receipt")
        except (urllib.error.URLError, TimeoutError, ValueError) as error:
            state.update(phase="unconfirmed", updatedAt=now(), error=type(error).__name__)
            save(state_file, state)
            raise RuntimeError("People import answer is uncertain; replay this manifest to reconcile the same batch") from error
        state["batches"][key] = {k: data.get(k) for k in ("created", "replayed", "people", "proposals")} | {"at": now()}
        totals.update({k: data.get(k) or 0 for k in ("created", "replayed", "proposals")})
        save(state_file, {**state, "phase": "delivering", "updatedAt": now()})
    state.update(phase="delivered", updatedAt=now())
    save(state_file, state)
    return {"phase": "delivered", "batches": len(state["batches"]), **totals}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--outlook-export", help="SHA-256 of the one recorded Outlook export to include")
    parser.add_argument("--manifest", type=Path, required=True, help="private prepared observations (outside Git)")
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--core", default=os.environ.get("AGENTX_CORE_URL", "http://127.0.0.1:3180"))
    parser.add_argument("--state", type=Path, help="private delivery state for --publish")
    args = parser.parse_args(argv)
    if args.publish and not args.state:
        parser.error("publish requires a private delivery state file")
    archive = Archive(args.root, run=lambda _: (_ for _ in ()).throw(RuntimeError("Provider access disabled")))
    if args.manifest.exists():
        manifest = load(args.manifest)
        if manifest.get("sourceRoot") != str(archive.root):
            parser.error("The saved manifest has a different source; keep it and prepare a new one")
    else:
        if not lanes_of(archive.root):
            parser.error("Label the archive first with value_lanes.py")
        manifest = prepare(archive, args.outlook_export)
        save(args.manifest, manifest)
    output = {"counts": manifest["counts"]}
    if args.publish:
        output["delivery"] = deliver(manifest, args.core, args.state)
    print(json.dumps(output))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
