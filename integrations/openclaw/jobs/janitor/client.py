"""Read-only Data API client for the shared-drive janitor assessment."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

ROOTS = {"media": "/mnt/media", "datalake": "/mnt/datalake"}
TERMINAL = {"complete", "failed", "partial", "stopped"}


class JanitorError(RuntimeError):
    """Bounded operator-safe failure."""


def unwrap(body: Any) -> dict[str, Any]:
    if not isinstance(body, dict):
        raise JanitorError("AgentX returned a non-object response")
    data = body.get("data", body)
    if not isinstance(data, dict):
        raise JanitorError("AgentX returned an invalid data envelope")
    return data


def http_json(
    url: str,
    *,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    timeout: int = 120,
) -> dict[str, Any]:
    headers = {"Accept": "application/json"}
    body = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        try:
            detail = json.loads(error.read().decode("utf-8", errors="replace"))
        except ValueError:
            detail = {}
        raise JanitorError(
            f"AgentX HTTP {error.code}: {str(detail.get('message') or '')[:200]}"
        ) from error
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
        raise JanitorError(f"AgentX request failed: {str(error)[:200]}") from error


def api(base_url: str, route: str, **kwargs: Any) -> dict[str, Any]:
    return unwrap(http_json(f"{base_url.rstrip('/')}{route}", **kwargs))


def enqueue_refresh(
    base_url: str,
    source: str,
    *,
    hash_mode: str,
    hash_max_files: int,
    hash_max_bytes: int,
) -> str:
    data = api(
        base_url,
        "/storage/agent-scans",
        method="POST",
        payload={
            "source": source,
            "hash_mode": hash_mode,
            "hash_max_files": hash_max_files,
            "hash_max_bytes": hash_max_bytes,
        },
    )
    scan_id = str(data.get("scan_id") or "")
    if not scan_id:
        raise JanitorError(f"AgentX did not return a scan id for {source}")
    return scan_id


def wait_for_scan(base_url: str, scan_id: str, *, deadline: float, poll_seconds: int) -> dict[str, Any]:
    while time.monotonic() < deadline:
        status = api(base_url, f"/storage/status/{urllib.parse.quote(scan_id)}")
        if status.get("status") in TERMINAL:
            return status
        time.sleep(poll_seconds)
    raise JanitorError(f"storage scan {scan_id} exceeded its deadline")


def collect_root(base_url: str, source: str) -> dict[str, Any]:
    root = ROOTS[source]
    encoded = urllib.parse.quote(root, safe="")
    summary = api(base_url, f"/storage/summary?root={encoded}")
    stats = api(base_url, f"/storage/files/stats?root={encoded}")
    metadata_drilldown = api(
        base_url,
        f"/storage/files/stats?root={encoded}&category=unclassified",
    )
    duplicates = api(base_url, f"/storage/files/duplicates?root={encoded}&method=auto&limit=25")
    organization = api(base_url, f"/storage/files/cleanup-recommendations?root={encoded}")
    return {
        "source": source,
        "root": root,
        "summary": summary,
        "stats": stats,
        "metadataDrilldown": metadata_drilldown,
        "duplicates": duplicates,
        "organization": organization,
    }


def collect_strategy(base_url: str) -> dict[str, Any]:
    """Generate and persist an AgentX strategy report without filesystem mutation."""
    data = api(
        base_url,
        "/janitor/profiles/shared-drive/strategy",
        method="POST",
        payload={},
    )
    report = data.get("report")
    if not isinstance(report, dict):
        raise JanitorError("AgentX did not return a shared-drive strategy report")
    return report
