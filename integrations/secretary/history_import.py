#!/usr/bin/env python3
"""Project existing Gmail findings into Core's private historical review.

No model, Gmail, task acceptance or selected-memory write. Preparation is local;
--publish explicitly sends a bounded, replayable batch to the Core owner API.
Unknown dates, stale reviews and missing raw sources remain reported gaps.
"""
from __future__ import annotations

import argparse
from collections import Counter
import json
import hashlib
from pathlib import Path
import re
import urllib.error
import urllib.request

from evidence_store import load, now, save
from history_coverage import content_hash, cutoff_date, finding_id, source_date
from secretary_evidence import Archive, DEFAULT_ROOT

SECTIONS = {"actions": "action", "memories": "fact", "deliverables": "deliverable", "invoices": "invoice"}
HASH = re.compile(r"[a-f0-9]{64}")


def entry_key(entry):
    source = entry["source"]
    return hashlib.sha256("\n".join([source["system"], source.get("threadId", ""), source.get("messageId", ""),
                                    source["sourceSha256"], entry["kind"], source["findingId"]]).encode()).hexdigest()


def preserved_source(root, mid):
    """The raw receipt of a message whose original is preserved intact in size, or None."""
    receipt = load(root / "raw-receipts" / f"{mid}.json", {})
    relative = receipt.get("path", "")
    original = (root / relative).resolve() if relative else None
    if not HASH.fullmatch(receipt.get("sha256", "")) or not original \
            or not original.is_relative_to(root) or not original.is_file() \
            or original.stat().st_size != receipt.get("bytes"):
        return None
    return receipt


def direction_of(labels):
    return "draft" if "DRAFT" in labels else "sent" if "SENT" in labels else "received" if labels else "unknown"


def prepare(archive, *, before=None, maximum=200, delivered=()):
    candidates, counts = [], Counter()
    for manifest in archive.manifests():
        tid = manifest["threadId"]
        review = load(archive.root / "reviews" / f"{tid}.json", {})
        if review.get("evidenceHash") != manifest["evidenceHash"]:
            counts["staleOrMissingReviewThreads"] += 1
            continue
        counts["threadQuestionsWithoutMessageAttribution"] += len(review.get("unresolved", []))
        payload = load(archive.root / "threads" / tid / "original.json", {})
        originals = {m["id"]: m for m in payload.get("thread", payload).get("messages", [])}
        messages = {m["id"]: m for m in manifest["messages"]}
        for section, kind in SECTIONS.items():
            for finding in review.get(section, []):
                mid = finding.get("messageId")
                message = messages.get(mid)
                if not message:
                    counts["findingsWithoutCurrentMessage"] += 1
                    continue
                date = source_date(message)
                if date is None:
                    counts["findingsWithoutSourceDate"] += 1
                    continue
                if before and date >= before:
                    counts["atOrAfterCutoff"] += 1
                    continue
                receipt = preserved_source(archive.root, mid)
                if receipt is None:
                    counts["findingsWithoutPreservedRawSource"] += 1
                    continue
                direction = direction_of(set(originals.get(mid, {}).get("labelIds", [])))
                text = finding.get("text")
                if section == "invoices":
                    text = json.dumps({k: v for k, v in finding.items() if k not in ("messageId", "attachmentSha256")}, ensure_ascii=False)
                actor = finding.get("owner") or ""
                if isinstance(actor, str) and actor.strip().lower() in ("unknown", "inconnu", "none", "null"):
                    actor = ""
                status = finding.get("status") or ""
                written = finding.get("date") or finding.get("due") or finding.get("documentDate") or ""
                if isinstance(written, str) and written.strip().lower() in ("unknown", "inconnu", "none", "null"):
                    written = ""
                if not isinstance(text, str) or not text.strip() or len(text) > 4000 \
                        or not isinstance(actor, str) or len(actor) > 300 \
                        or not isinstance(status, str) or len(status) > 1000 \
                        or not isinstance(written, str) or len(written) > 200:
                    counts["findingsRequiringManualNormalization"] += 1
                    continue
                note = finding.get("personalNoteId") or ""
                candidates.append({"kind": kind, "text": text, "actor": actor, "sourceStatus": status,
                    "sourceDate": date.isoformat(), "eventDateAsWritten": written,
                    "source": {"system": "gmail", "threadId": tid, "messageId": mid,
                        "sourceSha256": receipt["sha256"], "findingId": finding_id(tid, section, finding),
                        "evidenceHash": manifest["evidenceHash"], "reviewSha256": content_hash(review),
                        "direction": direction, "personalNoteId": note if re.fullmatch(r"[a-f0-9]{24}", str(note)) else ""}})
    candidates = [entry for entry in candidates if entry_key(entry) not in delivered]
    candidates.sort(key=lambda row: (row["sourceDate"], row["source"]["messageId"], row["source"]["findingId"]))
    counts["availableCandidates"] = len(candidates)
    selected = candidates[:maximum]
    return {"schema": "agentx.secretary-history-import/v1", "at": now(), "source": "existing-gmail-archive",
            "sourceRoot": str(archive.root),
            "before": before.isoformat() if before else None, "counts": {**counts, "selected": len(selected)},
            "entries": selected, "remaining": len(candidates) - len(selected)}


def publish(manifest, core, state_file, *, opener=urllib.request.urlopen, batch_size=20):
    state = load(state_file, {"schema": "agentx.secretary-history-delivery/v1", "delivered": {}})
    state["manifestSha256"] = content_hash(manifest)
    for start in range(0, len(manifest["entries"]), batch_size):
        batch = [entry for entry in manifest["entries"][start:start + batch_size]
                 if entry_key(entry) not in state["delivered"]]
        if not batch:
            continue
        request = urllib.request.Request(core.rstrip("/") + "/api/secretary/history/import", method="POST",
            headers={"content-type": "application/json"}, data=json.dumps({"entries": batch}).encode())
        try:
            with opener(request, timeout=90) as response:
                body = json.loads(response.read())
            results = body.get("data", {}).get("results", [])
            if body.get("status") != "success" or len(results) != len(batch) \
                    or any(not result.get("entry", {}).get("id") or result.get("sourceKey") != entry_key(entry)
                           for entry, result in zip(batch, results)):
                raise ValueError("Core returned an incomplete import receipt")
        except (urllib.error.URLError, TimeoutError, ValueError) as error:
            state.update(phase="unconfirmed", updatedAt=now(), error=type(error).__name__)
            save(state_file, state)
            raise RuntimeError("Historical import response is uncertain; preserve the manifest and replay its exact identities") from error
        for entry, result in zip(batch, results):
            state["delivered"][entry_key(entry)] = {"id": result["entry"]["id"],
                "payloadSha256": content_hash(entry), "state": result["entry"].get("reviewState"), "at": now()}
        state.update(phase="delivering", updatedAt=now())
        save(state_file, state)
    state.update(phase="delivered", updatedAt=now())
    save(state_file, state)
    return {"phase": state["phase"], "delivered": len(state["delivered"])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--before", type=cutoff_date)
    parser.add_argument("--maximum", type=int, default=200)
    parser.add_argument("--manifest", type=Path, required=True, help="Private immutable prepared payload outside Git")
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--core", default="http://127.0.0.1:3180")
    parser.add_argument("--state", type=Path)
    args = parser.parse_args()
    if not 1 <= args.maximum <= 10000:
        parser.error("maximum must be 1-10000")
    if args.publish and not args.state:
        parser.error("publish requires a private delivery state file")
    if args.manifest.exists():
        manifest = load(args.manifest)
        if manifest.get("sourceRoot") != str(args.root.resolve()) or args.before \
                and manifest.get("before") != args.before.isoformat():
            parser.error("The saved manifest has a different source or cutoff; retain it and prepare a new identity")
    else:
        delivered = load(args.state, {}).get("delivered", {}) if args.state else {}
        manifest = prepare(Archive(args.root, run=lambda _: (_ for _ in ()).throw(RuntimeError("Provider access disabled"))),
                           before=args.before, maximum=args.maximum, delivered=delivered)
        save(args.manifest, manifest)
    summary = {k: v for k, v in manifest.items() if k != "entries"}
    if args.publish:
        summary["delivery"] = publish(manifest, args.core, args.state)
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
