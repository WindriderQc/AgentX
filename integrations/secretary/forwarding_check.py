#!/usr/bin/env python3
"""Alert when mail forwarded from another mailbox stops reaching the archive.

Another provider's mailbox (for example Outlook.com) can forward its incoming
mail into the archived Gmail account; the archive then follows both mailboxes.
This check reads only archived headers. It reports two separate silences:

- mail_archive_stale: nothing at all reached the archive recently, so the
  archive sync is the problem, not the forwarding;
- mail_forwarding_quiet: the archive is fresh but no message addressed to the
  forwarded address arrived recently, so the forwarding probably broke.

A silence is posted to Core's alert intake (/api/alerts/evaluate) on every run
while it lasts; Core resolves the alert by itself once runs stop reporting it.
The forwarded address is an instance setting and never appears in the event.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import time
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent))
from secretary_evidence import DEFAULT_ROOT, Archive, now, save  # noqa: E402


SOURCE = "secretary-forwarding-check"
STATUS_NAME = "forwarding-status.json"


def latest_dates(archive, address, marker=None):
    """Newest archived message overall, and newest one addressed to `address`."""
    address = address.lower()
    newest = forwarded = 0
    for manifest in archive.manifests():
        for message in manifest["messages"]:
            stamp = int(message.get("internalDate") or 0)
            newest = max(newest, stamp)
            headers = {k.lower(): str(v).lower() for k, v in (message.get("headers") or {}).items()}
            recipients = " ".join(headers.get(k, "") for k in ("to", "cc", "x-forwarded-to", "x-original-to"))
            if address in recipients and (not marker or marker.lower() in headers):
                forwarded = max(forwarded, stamp)
    return newest, forwarded


def assess(newest_ms, forwarded_ms, quiet_hours, stale_hours, now_ms=None):
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    age = lambda ms: round((now_ms - ms) / 3_600_000, 1) if ms else None
    archive_age, forwarded_age = age(newest_ms), age(forwarded_ms)
    if archive_age is None or archive_age > stale_hours:
        return {"metric": "mail_archive_stale", "value": archive_age, "threshold": stale_hours,
                "archiveAgeHours": archive_age, "forwardedAgeHours": forwarded_age}
    if forwarded_age is None or forwarded_age > quiet_hours:
        return {"metric": "mail_forwarding_quiet", "value": forwarded_age, "threshold": quiet_hours,
                "archiveAgeHours": archive_age, "forwardedAgeHours": forwarded_age}
    return {"metric": None, "archiveAgeHours": archive_age, "forwardedAgeHours": forwarded_age}


def post(core_url, finding, label):
    remediation = ("Check the archive sync timer and the last backfill status."
                   if finding["metric"] == "mail_archive_stale"
                   else "Check the forwarding rule in the other mailbox's settings.")
    event = {"source": SOURCE, "data": {
        "component": label, "metric": finding["metric"], "value": finding["value"],
        "threshold": finding["threshold"],
        "additionalData": {"archiveAgeHours": finding["archiveAgeHours"],
                           "forwardedAgeHours": finding["forwardedAgeHours"], "remediation": remediation}}}
    request = urllib.request.Request(f"{core_url.rstrip('/')}/api/alerts/evaluate", method="POST",
                                     data=json.dumps(event).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read() or b"{}").get("data", {})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--forwarded-address", default=os.environ.get("SECRETARY_FORWARDED_ADDRESS"),
                        help="Address whose mail is forwarded into the archived mailbox")
    parser.add_argument("--marker-header", default=os.environ.get("SECRETARY_FORWARD_MARKER_HEADER"),
                        help="Header the forwarding provider adds, to ignore mail sent to both addresses")
    parser.add_argument("--label", default=os.environ.get("SECRETARY_FORWARDED_LABEL", "Forwarded mailbox"))
    parser.add_argument("--quiet-hours", type=float, default=float(os.environ.get("SECRETARY_FORWARD_QUIET_HOURS", 72)))
    parser.add_argument("--stale-hours", type=float, default=float(os.environ.get("SECRETARY_ARCHIVE_STALE_HOURS", 24)))
    parser.add_argument("--core-url", default=os.environ.get("AGENTX_CORE_URL", "http://127.0.0.1:3180"))
    parser.add_argument("--dry-run", action="store_true", help="Report without posting to Core")
    args = parser.parse_args()
    if not args.forwarded_address:
        parser.error("--forwarded-address (or SECRETARY_FORWARDED_ADDRESS) is required")
    archive = Archive(args.root, run=lambda _: {})
    finding = assess(*latest_dates(archive, args.forwarded_address, args.marker_header),
                     args.quiet_hours, args.stale_hours)
    status = {"at": now(), **finding, "posted": False}
    if finding["metric"] and not args.dry_run:
        status["intake"] = post(args.core_url, finding, args.label)
        status["posted"] = True
    save(archive.root / STATUS_NAME, status)
    print(json.dumps(status))
    return 0


if __name__ == "__main__":
    sys.exit(main())
