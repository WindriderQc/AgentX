#!/usr/bin/env python3
"""Label each archived message person, important or bulk, by its lasting value.

Reads only the private archive: thread manifests, the Gmail labels saved with
each thread, the contact and invoice discovery inventories, and an optional
private list of important sender domains. It never contacts Gmail. Labels are
written to value-lanes.json in the archive; the command prints counts only.
"""
from __future__ import annotations

import argparse
from collections import Counter
from email.utils import getaddresses
import json
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from evidence_store import load, now, save  # noqa: E402
from mail_catchup import BULK_LABELS, lane_of, threads_of  # noqa: E402
from secretary_evidence import DEFAULT_ROOT, Archive  # noqa: E402

LANES_NAME = "value-lanes.json"
LANES = ("person", "important", "bulk")
# Public institutions everywhere; banks, insurers, schools and employers come
# from the owner's private domain list, never from this public file.
PUBLIC_DOMAINS = ("gouv.qc.ca", "gc.ca", "canada.ca", "quebec.ca", "gouv.fr", "gov", "edu")
AUTOMATED = re.compile(r"^(no-?reply|do-?not-?reply|ne-?pas-?repondre|nepasrepondre|notifications?|alerts?|"
                       r"mailer-daemon|postmaster|newsletters?|news|marketing|promo|bounces?)([._+-]|$)", re.I)
BULK_PRECEDENCE = {"bulk", "list", "junk"}
# Gmail files bank statements, school portals and bills under Updates too:
# that category alone never makes a message bulk here.
MASS_LABELS = BULK_LABELS - {"CATEGORY_UPDATES"}


def addresses(value):
    return [address.lower() for _, address in getaddresses([value or ""]) if "@" in address]


def domain_in(address, domains):
    domain = address.rsplit("@", 1)[-1]
    return any(domain == d or domain.endswith("." + d) for d in domains)


def messages(archive):
    """Each archived message with its thread id and saved Gmail labels."""
    for manifest in archive.manifests():
        tid = manifest["threadId"]
        payload = load(archive.root / "threads" / tid / "original.json", {})
        saved = payload.get("thread", payload).get("messages", []) if isinstance(payload, dict) else []
        labels = {m.get("id"): set(m.get("labelIds") or []) for m in saved}
        for message in manifest["messages"]:
            yield tid, message, labels.get(message["id"], set())


def correspondents(rows):
    """The owner's own addresses and everyone the owner wrote to."""
    owner, wrote_to = set(), set()
    for _, message, labels in rows:
        if "SENT" in labels:
            headers = message.get("headers") or {}
            owner.update(addresses(headers.get("from")))
            for field in ("to", "cc", "bcc"):
                wrote_to.update(addresses(headers.get(field)))
    return owner, wrote_to - owner


def classify(tid, message, labels, *, contact, invoices, owner, wrote_to, domains):
    """(lane, reason) for one message; the first matching rule wins."""
    headers = message.get("headers") or {}
    sender = (addresses(headers.get("from")) or [""])[0]
    if labels & {"SENT", "DRAFT"} or sender in owner:
        return "person", "owner-wrote"
    base = lane_of({"threadId": tid, "kind": "message"}, contact, invoices, labels)
    if base == "contact":
        return "person", "contact"
    if base.startswith("invoice"):
        return "important", "invoice"
    if sender in wrote_to:
        return "person", "correspondent"
    if sender and domain_in(sender, domains):
        return "important", "institution"
    listed = headers.get("list-unsubscribe") or headers.get("list-id") \
        or (headers.get("precedence") or "").strip().lower() in BULK_PRECEDENCE
    if labels & MASS_LABELS or listed:
        return "bulk", "bulk-mail"
    automated = AUTOMATED.match(sender.split("@")[0]) or (headers.get("auto-submitted") or "no").strip().lower() != "no"
    if labels & {"CATEGORY_UPDATES", "IMPORTANT"}:
        return "important", "update"
    if automated:
        return "bulk", "automated"
    return "person", "direct"


def label(archive, important_domains=()):
    root = archive.root
    rows = list(messages(archive))
    owner, wrote_to = correspondents(rows)
    contact, invoices = threads_of(root, "contact"), threads_of(root, "invoices")
    domains = tuple(PUBLIC_DOMAINS) + tuple(d.lower().lstrip("@.") for d in important_domains)
    result, counts = {}, {lane: Counter() for lane in LANES}
    for tid, message, labels in rows:
        lane, reason = classify(tid, message, labels, contact=contact, invoices=invoices,
                                owner=owner, wrote_to=wrote_to, domains=domains)
        result[message["id"]] = {"threadId": tid, "lane": lane, "reason": reason}
        counts[lane][reason] += 1
    report = {"schema": "agentx.secretary-value-lanes/v1", "at": now(), "messages": result,
              "counts": {lane: dict(sorted(c.items())) for lane, c in counts.items()}}
    save(root / LANES_NAME, report)
    return report


def lanes_of(root):
    """{messageId: lane} from the last labelling, or {} when never run."""
    return {mid: row["lane"] for mid, row in load(Path(root) / LANES_NAME, {}).get("messages", {}).items()}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--important-domains", type=Path,
                        help="private file outside Git: one sender domain per line (bank, insurer, school, employer)")
    args = parser.parse_args(argv)
    domains = []
    if args.important_domains:
        domains = [line.strip() for line in args.important_domains.read_text(encoding="utf-8").splitlines()
                   if line.strip() and not line.lstrip().startswith("#")]
    archive = Archive(args.root, run=lambda _: (_ for _ in ()).throw(RuntimeError("Provider access disabled")))
    report = label(archive, domains)
    totals = {lane: sum(reasons.values()) for lane, reasons in report["counts"].items()}
    print(json.dumps({"messages": len(report["messages"]), "lanes": totals, "reasons": report["counts"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
