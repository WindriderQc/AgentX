"""Assemble and persist the read-only shared-drive assessment report."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .client import collect_root, collect_strategy


def build_organization_signals(roots: list[dict[str, Any]]) -> dict[str, Any]:
    per_root: dict[str, Any] = {}
    for item in roots:
        stats = item.get("stats") or {}
        drilldown = item.get("metadataDrilldown") or {}
        total = stats.get("total") or {}
        unclassified = next(
            (
                int(row.get("count") or 0)
                for row in stats.get("byCategory") or []
                if row.get("category") == "unclassified"
            ),
            0,
        )
        per_root[item["source"]] = {
            "unclassifiedFiles": unclassified,
            "extensionlessByDesignFiles": int(total.get("extensionlessByDesign") or 0),
            "missingExtensionUnresolvedFiles": int(total.get("missingExtensionUnresolved") or 0),
            "timestampReviewFiles": (
                int(total.get("legacyOrSuspectTimestamp") or 0)
                + int(total.get("futureSuspectTimestamp") or 0)
            ),
            "storageRoles": stats.get("byStorageRole") or [],
            "topLevelAreas": stats.get("byTopLevel") or [],
            "unclassifiedByExtension": drilldown.get("byExtension") or [],
            "unclassifiedByStorageRole": drilldown.get("byStorageRole") or [],
            "unclassifiedByTopLevel": drilldown.get("byTopLevel") or [],
        }
    return {
        "mode": "advisory-read-only",
        "perRoot": per_root,
        "recommendedNextActions": [
            "Leave extensionless-by-design model, source-control, Unity package, and cache objects unchanged.",
            "Prioritize genuinely unclassified and unresolved-extension records for metadata rules.",
            "Agree retention and canonical-location policy before proposing any backup or generated-cache move.",
            "Treat legacy or future timestamps as review signals, never deletion evidence.",
        ],
    }


def build_report(base_url: str, sources: list[str], scans: dict[str, Any]) -> dict[str, Any]:
    roots = [collect_root(base_url, source) for source in sources]
    strategy = collect_strategy(base_url)
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "mode": "read-only-assessment",
        "scope": {
            "mediaContainsDatalakePhysically": True,
            "mediaIndexExcludesNestedDatalake": True,
            "portfolioTotalsDoubleCountDatalake": False,
            "note": (
                "The physical Media share contains Datalake. AgentX maps the rest of Media "
                "to /mnt/media and maps that excluded child independently to /mnt/datalake."
            ),
        },
        "evidencePolicy": {
            "verifiedDuplicatesAreLowerBound": True,
            "candidateBytesAreNotSavings": True,
            "perRoot": {
                item["source"]: item["summary"].get("evidenceLimitations", {})
                for item in roots
            },
        },
        "metadataPolicy": {
            "pathDerivedRolesAreAdvisory": True,
            "legacyTimestampsAreReviewSignals": True,
            "extensionlessByDesignIsNotMissingMetadata": True,
            "note": (
                "Storage roles are deterministic organization signals, not permission to move data. "
                "Legacy or future timestamps require review and are not deletion evidence."
            ),
        },
        "organizationSignals": build_organization_signals(roots),
        "strategy": strategy,
        "safety": {
            "destructiveRequestsMade": 0,
            "approvalEndpointsCalled": False,
            "deleteMoveArchiveExecuted": False,
        },
        "scans": scans,
        "roots": roots,
    }


def save_report(report: dict[str, Any], report_dir: Path) -> Path:
    report_dir.mkdir(parents=True, exist_ok=True)
    stamp = report["generatedAt"].replace(":", "-")
    target = report_dir / f"shared-drive-assessment-{stamp}.json"
    target.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    latest = report_dir / "latest.json"
    latest.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    return target
