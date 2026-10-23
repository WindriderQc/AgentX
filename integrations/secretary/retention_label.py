#!/usr/bin/env python3
"""Put one review label on an approved retention batch, then check each message.

First step of the owner's cleanup: messages of one batch of a retention manifest
receive the Gmail label "AgentX/À retirer" so the owner can browse them in
Gmail before any Trash. Nothing is archived, trashed or deleted here.

`prepare` reads each message again at Gmail (read-only) and holds anything that
changed, is a draft, is already in Trash or is gone. `apply` needs the batch
fingerprint the owner approved, records its dispatch before the first change,
adds only that label to the exact ready messages, then reads every message back.
An uncertain answer is never retried: `reconcile` reads back instead. `remove`
takes the label off the same messages (undo). Receipts stay private.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from evidence_store import load, now, save  # noqa: E402
from gmail_provider import GmailProviderError, label_gmail, read_gmail  # noqa: E402
from history_coverage import content_hash  # noqa: E402

LABEL = "AgentX/À retirer"
CHUNK = 50
FRESH = timedelta(hours=1)


def batch_of(manifest, name):
    batch = next((b for b in manifest.get("batches", []) if b.get("batch") == name), None)
    if not batch or not batch.get("messages"):
        raise SystemExit(f"Batch {name} is not in this manifest")
    return batch


def fingerprint(manifest, batch):
    return content_hash([manifest.get("planSha256"), batch["batch"],
                         sorted((m["messageId"], m["sourceSha256"]) for m in batch["messages"])])


def metadata(read, mid):
    payload = read(["gmail", "get", mid, "--format=metadata"])
    message = payload.get("message", payload) if isinstance(payload, dict) else {}
    return {"threadId": message.get("threadId"), "labelIds": sorted(message.get("labelIds") or [])}


def label_ids(read):
    payload = read(["gmail", "labels", "list"])
    rows = payload if isinstance(payload, list) else (payload or {}).get("labels") or []
    return {row.get("name"): row.get("id") for row in rows if isinstance(row, dict)}


def prepare(manifest_path, name, out, read=read_gmail):
    manifest = load(manifest_path)
    batch = batch_of(manifest, name)
    existing = label_ids(read).get(LABEL)
    ready, held = [], {}
    for item in batch["messages"]:
        mid = item["messageId"]
        try:
            current = metadata(read, mid)
        except GmailProviderError as error:
            held[mid] = "gone_at_gmail" if error.kind == "not_found" else "gmail_unavailable"
            continue
        labels = set(current["labelIds"])
        if current["threadId"] != item["threadId"]:
            held[mid] = "thread_changed"
        elif "TRASH" in labels:
            held[mid] = "already_in_trash"
        elif "DRAFT" in labels:
            held[mid] = "draft"
        else:
            ready.append({"messageId": mid, "labelsBefore": current["labelIds"],
                          "alreadyLabelled": bool(existing and existing in labels)})
    out.mkdir(mode=0o700, parents=False, exist_ok=False)
    intent = {"schema": "agentx.secretary-retention-label-intent/v1", "at": now(), "label": LABEL,
              "manifest": str(manifest_path), "manifestSha256": content_hash(manifest), "batch": name,
              "batchSha256": fingerprint(manifest, batch), "ready": ready, "held": held, "mailboxEffects": 0}
    save(out / "intent.json", intent)
    return intent


def readback(read, intent, labels_after):
    wanted = labels_after.get(LABEL)
    rows = {}
    for item in intent["ready"]:
        try:
            current = metadata(read, item["messageId"])
        except GmailProviderError as error:
            rows[item["messageId"]] = {"state": "unreadable", "kind": error.kind}
            continue
        after, before = set(current["labelIds"]), set(item["labelsBefore"])
        added, lost = after - before, before - after
        labelled = bool(wanted) and wanted in after
        rows[item["messageId"]] = {"labelled": labelled, "added": sorted(added), "lost": sorted(lost)}
    return rows


def apply(out, approve, approved_by, *, create_label=False, remove=False, read=read_gmail, write=label_gmail, clock=None):
    intent = load(out / "intent.json")
    if approve != intent["batchSha256"]:
        raise SystemExit("The approved fingerprint does not match this batch; nothing changed")
    if not str(approved_by or "").strip():
        raise SystemExit("Record who approved and when (--approved-by)")
    clock = clock or datetime.now(timezone.utc)
    if not clock - FRESH <= datetime.fromisoformat(intent["at"].replace("Z", "+00:00")) <= clock:
        raise SystemExit("The Gmail check is older than one hour; prepare the batch again")
    step = "remove" if remove else "add"
    mark = out / f"dispatch-{step}.json"
    if mark.exists():
        raise SystemExit(f"A {step} was already dispatched for this batch; run reconcile, never a second dispatch")
    labels = label_ids(read)
    if LABEL not in labels and not remove:
        if not create_label:
            raise SystemExit(f'The label "{LABEL}" does not exist; pass --create-label')
    targets = [i["messageId"] for i in intent["ready"] if remove or not i["alreadyLabelled"]]
    save(mark, {"at": now(), "step": step, "approvedBy": approved_by, "batchSha256": approve, "targets": targets})
    calls, error = 0, None
    try:
        if LABEL not in labels and not remove:
            write(["gmail", "labels", "create", LABEL], LABEL)
        flag = f"--remove={LABEL}" if remove else f"--add={LABEL}"
        for start in range(0, len(targets), CHUNK):
            write(["gmail", "batch", "modify", *targets[start:start + CHUNK], flag], LABEL)
            calls += 1
    except (GmailProviderError, ValueError) as failure:
        error = f"{type(failure).__name__}: {failure}"[:300]
    after = label_ids(read)
    rows = readback(read, intent, after)
    ours = after.get(LABEL) or labels.get(LABEL)
    wanted = (lambda r: not r.get("labelled")) if remove else (lambda r: r.get("labelled"))

    def other_change(row):
        # Adding may only add our label; removing may only remove it.
        added, lost = set(row.get("added", [])), set(row.get("lost", []))
        return bool(added - ({ours} if not remove else set()) or lost - ({ours} if remove else set()))
    effect = {"schema": "agentx.secretary-retention-label-effect/v1", "at": now(), "step": step, "label": LABEL,
              "batch": intent["batch"], "batchSha256": approve, "approvedBy": approved_by, "modifyCalls": calls,
              "error": error, "messages": rows, "held": intent["held"],
              "confirmed": sum(1 for r in rows.values() if wanted(r)),
              "otherLabelsChanged": sorted(m for m, r in rows.items() if other_change(r)),
              "trashed": 0, "deleted": 0}
    save(out / f"effect-{step}.json", effect)
    return effect


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("prepare")
    p.add_argument("--manifest", type=Path, required=True)
    p.add_argument("--batch", required=True)
    p.add_argument("--out", type=Path, required=True, help="new private directory for this batch's receipts")
    for name in ("apply", "remove"):
        a = sub.add_parser(name)
        a.add_argument("--out", type=Path, required=True)
        a.add_argument("--approve", required=True, help="the batch fingerprint the owner approved")
        a.add_argument("--approved-by", required=True, help="who approved, when and where")
        if name == "apply":
            a.add_argument("--create-label", action="store_true")
    r = sub.add_parser("reconcile")
    r.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.command == "prepare":
        intent = prepare(args.manifest, args.batch, args.out)
        print(json.dumps({"batch": intent["batch"], "batchSha256": intent["batchSha256"], "ready": len(intent["ready"]),
                          "held": len(intent["held"]), "heldReasons": sorted(set(intent["held"].values()))}))
    elif args.command in ("apply", "remove"):
        effect = apply(args.out, args.approve, args.approved_by, create_label=getattr(args, "create_label", False),
                       remove=args.command == "remove")
        print(json.dumps({k: effect[k] for k in ("step", "confirmed", "modifyCalls", "error", "otherLabelsChanged")}))
        return 0 if not effect["error"] and not effect["otherLabelsChanged"] else 2
    else:
        intent = load(args.out / "intent.json")
        rows = readback(read_gmail, intent, label_ids(read_gmail))
        save(args.out / f"reconcile-{os.getpid()}.json", {"at": now(), "messages": rows})
        print(json.dumps({"labelled": sum(1 for r in rows.values() if r.get("labelled")), "messages": len(rows)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
