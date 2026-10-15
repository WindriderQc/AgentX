"""Reconcile discovered source IDs without erasing evidence or inventing coverage.

A missing ID is excluded from collection only after its own read-only Gmail get
returns a typed not-found result. Search rediscovery invalidates that state.
Immutable observations retain both transitions; these are not deletion permits.
"""
from __future__ import annotations

import hashlib
import json

from evidence_store import load, now, save
from gmail_provider import GmailProviderError

RECONCILE_LIMIT = 10


def observation(root, message_id, thread_id, outcome, *, labels=(), source):
    # Identifiers already came through Archive.identifier/the provider. Keep
    # defensive path checks here because this module is also used by reports.
    import re
    if not all(re.fullmatch(r"[a-zA-Z0-9_-]{8,256}", x or "") for x in (message_id, thread_id)):
        raise ValueError("Invalid source identifier")
    value = {"schema": "agentx.secretary-source-observation/v1", "messageId": message_id,
             "threadId": thread_id, "outcome": outcome, "labelsAtDiscovery": list(labels),
             "source": source, "observedAt": now()}
    digest = hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
    receipt = f"source-observations/{message_id}/{digest}.json"
    if not (root / receipt).exists():
        save(root / receipt, value)
    save(root / "source-availability" / f"{message_id}.json", {**value, "receipt": receipt})
    return value


def unavailable(root, row):
    receipt = load(root / "source-availability" / f"{row['id']}.json", {})
    if receipt.get("outcome") != "not_found" or receipt.get("threadId") != row["threadId"] \
            or receipt.get("messageId") != row["id"] or not receipt.get("receipt"):
        return False
    source = (root / receipt["receipt"]).resolve()
    if not source.is_relative_to(root.resolve()):
        return False
    # A mutable index without its immutable observation cannot hide a gap.
    return load(source, {}) == {k: v for k, v in receipt.items() if k != "receipt"}


def rediscovered(root, row):
    if unavailable(root, row):
        observation(root, row["id"], row["threadId"], "available", source="gmail.messages.search",
                    labels=row.get("labels", []))


def expected_rows(root, rows, thread_id, known=()):
    known = set(known)
    return [row for row in rows if row["threadId"] == thread_id and row["id"] not in known
            and not unavailable(root, row)]


def reconcile_absent(archive, rows, manifest=None):
    known = {m["id"] for m in (manifest or {}).get("messages", [])}
    reconciled = []
    for row in [r for r in rows if r["id"] not in known][:RECONCILE_LIMIT]:
        if unavailable(archive.root, row):
            continue
        try:
            reply = archive.run(["gmail", "get", row["id"], "--format=metadata"])
        except GmailProviderError as error:
            if error.kind != "not_found":
                raise
            observation(archive.root, row["id"], row["threadId"], "not_found",
                        source="gmail.get.metadata", labels=row.get("labels", []))
            reconciled.append(row["id"])
            continue
        message = reply.get("message", reply)
        if message.get("id") != row["id"] or message.get("threadId") != row["threadId"]:
            raise ValueError("Provider metadata does not match discovered source")
        # A source still exists but the thread snapshot omitted it. Leave it
        # pending for a fresh snapshot; metadata is not a preserved original.
    return reconciled


def collect_discovered(archive, thread_id, rows):
    try:
        manifest = archive.collect_thread(thread_id)
    except GmailProviderError as error:
        if error.kind != "not_found":
            raise
        return {"collected": False, "unavailable": reconcile_absent(archive, rows)}
    return {"collected": True, "unavailable": reconcile_absent(archive, rows, manifest)}


def collection_status(archive, scopes, manifests):
    known = {m["threadId"]: {r["id"] for r in m["messages"]} for m in manifests}
    uncollected, discovering, absent, absent_drafts = set(), [], set(), set()
    for scope in scopes:
        inventory = load(archive.root / f"inventory-{scope}.json", {})
        if not inventory.get("complete"):
            discovering.append(scope)
        for row in inventory.get("messages", {}).values():
            if row["id"] in known.get(row["threadId"], set()):
                continue
            if unavailable(archive.root, row):
                absent.add(row["id"])
                if "DRAFT" in row.get("labels", []):
                    absent_drafts.add(row["id"])
            else:
                uncollected.add(row["threadId"])
    return {"uncollectedThreads": len(uncollected), "discoveringScopes": discovering,
            "unavailableMessages": len(absent), "unavailableDraftMessages": len(absent_drafts)}
