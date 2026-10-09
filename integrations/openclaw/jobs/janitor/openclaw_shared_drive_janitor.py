#!/usr/bin/env python3
"""Read-only OpenClaw helper for AgentX shared-drive assessment and refresh."""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from janitor.client import ROOTS, JanitorError, enqueue_refresh, wait_for_scan  # noqa: E402
from janitor.rendering import DEFAULT_DASHBOARD_URL, compact_summary, notification_summary  # noqa: E402
from janitor.report import build_report, save_report  # noqa: E402

DEFAULT_BASE_URL = "http://127.0.0.1:3183/api/v1"
DEFAULT_REPORT_DIR = Path.home() / ".local" / "state" / "agentx" / "shared-drive-janitor"


def run(args: argparse.Namespace) -> str:
    scans: dict[str, Any] = {}
    if args.refresh:
        hash_mode = "none" if args.metadata_only else "candidates"
        queued = {
            source: enqueue_refresh(
                args.base_url,
                source,
                hash_mode=hash_mode,
                hash_max_files=args.hash_max_files,
                hash_max_bytes=args.hash_max_bytes,
            )
            for source in args.sources
        }
        deadline = time.monotonic() + args.max_wait_seconds
        for source, scan_id in queued.items():
            scans[source] = wait_for_scan(
                args.base_url,
                scan_id,
                deadline=deadline,
                poll_seconds=args.poll_seconds,
            )
            if scans[source].get("status") != "complete":
                raise JanitorError(f"{source} scan ended as {scans[source].get('status')}")

    report = build_report(args.base_url, args.sources, scans)
    target = save_report(report, args.report_dir)
    if getattr(args, "verbose_summary", False):
        return compact_summary(report, target)
    return notification_summary(
        report,
        getattr(args, "dashboard_url", DEFAULT_DASHBOARD_URL),
    )


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument(
        "--base-url",
        default=os.environ.get("AGENTX_JANITOR_BASE_URL") or DEFAULT_BASE_URL,
        help="Data API base URL ending in /api/v1 (env AGENTX_JANITOR_BASE_URL)",
    )
    result.add_argument("--sources", nargs="+", choices=sorted(ROOTS), default=["media", "datalake"])
    result.add_argument("--refresh", action="store_true")
    result.add_argument(
        "--metadata-only",
        action="store_true",
        help="refresh file inventory and metadata without reading file contents for hashes",
    )
    result.add_argument("--hash-max-files", type=int, default=5000)
    result.add_argument("--hash-max-bytes", type=int, default=50 * 1024 * 1024 * 1024)
    result.add_argument("--poll-seconds", type=int, default=15)
    result.add_argument("--max-wait-seconds", type=int, default=4 * 60 * 60)
    result.add_argument(
        "--report-dir",
        type=Path,
        default=Path(os.environ.get("AGENTX_JANITOR_REPORT_DIR") or DEFAULT_REPORT_DIR),
        help="directory for JSON reports (env AGENTX_JANITOR_REPORT_DIR)",
    )
    result.add_argument(
        "--dashboard-url",
        default=os.environ.get("AGENTX_JANITOR_DASHBOARD_URL") or DEFAULT_DASHBOARD_URL,
        help="Data Toolbox janitor link in the notification (env AGENTX_JANITOR_DASHBOARD_URL)",
    )
    result.add_argument(
        "--verbose-summary",
        action="store_true",
        help="print the full evidence digest instead of the bounded dashboard-linked notification",
    )
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        print(run(args))
        return 0
    except JanitorError as error:
        print(f"Shared-drive janitor failed: {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
