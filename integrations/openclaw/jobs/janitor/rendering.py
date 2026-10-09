"""Human-facing summaries of a shared-drive assessment report."""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

DEFAULT_DASHBOARD_URL = "http://127.0.0.1:3180/data-toolbox#janitor"
FIFTY_GIB_HASH_DISCLAIMER = (
    "duplicate groups >50 GiB can progress when each individual file fits budget; "
    "one individual unhashed file >50 GiB remains unverified until cap raised."
)
EVIDENCE_POLICY_FOOTER = (
    "Evidence policy: verified SHA-256 savings are lower bounds; same-size candidate bytes are "
    "neither savings nor reclaimable space, and bytes-to-hash are read-only verification workload. "
    "Paths, timestamps, mirror links, work items, and proposals are review evidence only; Media "
    "excludes its nested Datalake child, Datalake is counted once, and no file mutation is authorized. "
    f"Hashing boundary: {FIFTY_GIB_HASH_DISCLAIMER}"
)


def signed_count(value: Any) -> str:
    if value is None:
        return "n/a"
    return f"{int(value):+,}"


def signed_bytes(value: Any) -> str:
    if value is None:
        return "n/a"
    amount = int(value)
    magnitude = abs(amount)
    units = ("B", "KiB", "MiB", "GiB", "TiB")
    scaled = float(magnitude)
    unit = units[0]
    for candidate in units:
        unit = candidate
        if scaled < 1024 or candidate == units[-1]:
            break
        scaled /= 1024
    prefix = "+" if amount >= 0 else "-"
    precision = 0 if unit == "B" else 2
    return f"{prefix}{scaled:.{precision}f} {unit}"


def fmt_bytes(value: Any) -> str:
    """Unsigned binary-unit byte formatting for human-facing report values."""
    return signed_bytes(abs(int(value or 0))).lstrip("+")


def is_number(value: Any) -> bool:
    """Accept finite JSON numbers only; booleans are not evidence."""
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def is_nonnegative_number(value: Any) -> bool:
    return is_number(value) and value >= 0


def extension_label(value: Any) -> str:
    extension = str(value or "").strip()
    if not extension or extension == "no extension":
        return "no extension"
    return f".{extension}"


def bottom_line_summary(strategy: dict[str, Any], roots: list[dict[str, Any]]) -> str | None:
    evidence = strategy.get("evidence") or {}
    if not any(
        key in evidence
        for key in ("verifiedDuplicateGroups", "provenSavingsBytes", "duplicateCandidates")
    ):
        return None
    candidates = evidence.get("duplicateCandidates") or {}
    coverage = ", ".join(
        f"{item.get('source') or 'root'} {float((item.get('summary') or {}).get('hashCoverageFiles') or 0) * 100:.2f}%"
        for item in roots
    )
    if "bytesToHash" in candidates:
        backlog = (
            f"verification backlog {fmt_bytes(candidates.get('bytesToHash'))} across "
            f"{int(candidates.get('groups') or 0):,} same-size candidate groups"
        )
    else:
        backlog = (
            "verification backlog unavailable; "
            f"{fmt_bytes(candidates.get('candidateBytes'))} same-size candidate bytes remain "
            "non-savings evidence"
        )
    line = (
        f"Bottom line: {fmt_bytes(evidence.get('provenSavingsBytes'))} duplicate savings proven so far "
        f"({int(evidence.get('verifiedDuplicateGroups') or 0):,} groups, lower bound); {backlog}"
    )
    return f"{line}; hash coverage {coverage}." if coverage else f"{line}."


def metadata_first_summary(strategy: dict[str, Any]) -> str:
    evidence = (strategy.get("evidence") or {}).get("metadataFirst") or {}
    if evidence.get("status") != "measured":
        return "Metadata-first lane: unavailable; do not infer that organization evidence is current."
    indexed_files = evidence.get("indexedFiles")
    indexed_bytes = evidence.get("indexedBytes")
    canonical_roots = evidence.get("canonicalRoots")
    values = (indexed_files, indexed_bytes, canonical_roots)
    if not all(is_nonnegative_number(value) for value in values):
        return "Metadata-first lane: unavailable; do not infer that organization evidence is current."
    if (
        evidence.get("organizationReviewAvailable") is not True
        or evidence.get("exactDuplicateProofRequired") is not True
        or evidence.get("filesystemMutationAllowed") is not False
    ):
        return "Metadata-first lane: unavailable; do not infer that organization evidence is current."
    signals = ", ".join(str(value) for value in (evidence.get("signals") or [])[:5])
    suffix = f" Signals: {signals}." if signals else ""
    return (
        f"Metadata-first lane: organization evidence is ready now for {int(indexed_files):,} indexed files, "
        f"{fmt_bytes(indexed_bytes)} across {int(canonical_roots):,} canonical roots.{suffix} "
        "It does not prove duplicates or authorize file changes."
    )


def verification_queue_summary(strategy: dict[str, Any]) -> str:
    strategy_evidence = strategy.get("evidence") or {}
    evidence = strategy_evidence.get("verificationQueue") or {}
    candidates = strategy_evidence.get("duplicateCandidates") or {}
    ordering = evidence.get("ordering") or []
    values = (
        evidence.get("groups"),
        evidence.get("potentialDuplicateBytes"),
        evidence.get("filesToHash"),
        evidence.get("bytesToHash"),
    )
    valid = (
        evidence.get("status") in {"prioritized", "empty"}
        and ordering == ["potential_duplicate_bytes_desc", "file_size_desc"]
        and all(is_nonnegative_number(value) for value in values)
        and candidates.get("candidateBytesAreNotSavings") is True
        and evidence.get("groups") == candidates.get("groups")
        and evidence.get("files") == candidates.get("files")
        and evidence.get("potentialDuplicateBytes") == candidates.get("candidateBytes")
        and evidence.get("filesToHash") == candidates.get("filesToHash")
        and evidence.get("bytesToHash") == candidates.get("bytesToHash")
        and evidence.get("potentialDuplicateBytesAreNotSavings") is True
        and evidence.get("exactDuplicateProofRequired") is True
        and evidence.get("filesystemMutationAllowed") is False
    )
    if not valid:
        return "Targeted proof lane: unavailable; do not infer queue order, savings, or authorization."
    if evidence.get("status") == "empty":
        if any(values):
            return "Targeted proof lane: unavailable; do not infer queue order, savings, or authorization."
        return "Targeted proof lane: no current same-size candidate groups require SHA-256 verification."
    return (
        f"Targeted proof lane: SHA-256 starts with {int(evidence['groups']):,} same-size candidate groups, "
        "ordered by aggregate potential duplicate bytes then file size; "
        f"{fmt_bytes(evidence['potentialDuplicateBytes'])} is prioritization evidence only—not savings. "
        "Exact proof and explicit per-action approval remain required."
    )


def verification_pace_summary(strategy: dict[str, Any]) -> str | None:
    outlook = ((strategy.get("evidence") or {}).get("verificationOutlook") or {})
    candidates = ((strategy.get("evidence") or {}).get("duplicateCandidates") or {})
    if not outlook:
        return "Verification pace: unavailable; do not infer a rate or ETA from incomplete scan evidence."
    if outlook.get("status") != "measured":
        return "Verification pace: unavailable; do not infer a rate or ETA from incomplete scan evidence."
    cycle = outlook.get("latestCompletedCycle") or {}
    capacity = outlook.get("configuredCapacity") or {}
    try:
        hashed_bytes = int(cycle.get("hashedBytes"))
        hashed_files = int(cycle.get("hashedFiles"))
        duration = float(cycle.get("durationSeconds"))
        observed_cycles = int(cycle.get("estimatedComparableCyclesLowerBound"))
        capacity_cycles = int(capacity.get("estimatedCyclesLowerBound"))
        outlook_files = int(outlook.get("filesToHash"))
        outlook_bytes = int(outlook.get("bytesToHash"))
        candidate_files = int(candidates.get("filesToHash"))
        candidate_bytes = int(candidates.get("bytesToHash"))
    except (TypeError, ValueError):
        return "Verification pace: unavailable; do not infer a rate or ETA from incomplete scan evidence."
    if (
        hashed_bytes < 0 or hashed_files < 0 or duration <= 0 or observed_cycles < 0
        or capacity_cycles < 0 or outlook_files < 0 or outlook_bytes < 0
        or outlook_files != candidate_files or outlook_bytes != candidate_bytes
    ):
        return "Verification pace: unavailable; do not infer a rate or ETA from incomplete scan evidence."
    return (
        f"Verification pace: latest successful scans for both roots hashed {fmt_bytes(hashed_bytes)} across "
        f"{hashed_files:,} files in {duration / 60:.0f} min; at that observed rate the current "
        f"backlog needs at least ~{observed_cycles:,} comparable cycle(s), versus a configured-capacity "
        f"lower bound of ~{capacity_cycles:,}. Neither value is a calendar ETA."
    )


def next_actions_summary(strategy: dict[str, Any]) -> list[str]:
    evidence = strategy.get("evidence") or {}
    candidates = evidence.get("duplicateCandidates") or {}
    decisions = strategy.get("decisions_required") or []
    maintenance = strategy.get("maintenance") or {}
    proposals = maintenance.get("proposals") or []
    actions = []
    if int(candidates.get("groups") or 0) > 0 and "bytesToHash" in candidates:
        actions.append(
            f"verify — plan read-only candidate hashing for {fmt_bytes(candidates.get('bytesToHash'))} "
            f"across {int(candidates.get('groups') or 0):,} groups within an explicitly approved budget"
        )
    if decisions:
        actions.append(
            f"decide — answer {len(decisions)} shared-drive policy question(s) before proposals are planned"
        )
    elif proposals:
        largest = max((int(item.get("space_saved") or 0) for item in proposals), default=0)
        actions.append(
            f"review — bucket {len(proposals):,} verified duplicate proposals by proven bytes "
            f"(largest single group {fmt_bytes(largest)}); every action still needs explicit approval"
        )
    top_metadata = next(
        (
            item for item in ((strategy.get("organizationStrategy") or {}).get("workItems") or [])
            if item.get("type") != "hash_coverage"
        ),
        None,
    )
    if top_metadata:
        item_evidence = top_metadata.get("evidence") or {}
        actions.append(
            f"organize — {top_metadata.get('title') or top_metadata.get('id')} "
            f"({int(item_evidence.get('files') or 0):,} files, {fmt_bytes(item_evidence.get('bytes'))})"
        )
    return actions[:3]


def timestamp_evidence_summary(strategy: dict[str, Any]) -> str | None:
    roots = ((strategy.get("evidence") or {}).get("perRoot") or [])
    totals = {"legacy_or_suspect": 0, "future_suspect": 0}
    dominant: dict[str, Any] | None = None
    has_evidence = False
    for root in roots:
        for row in root.get("timestampQualityTotals") or []:
            quality = str(row.get("timestampQuality") or "")
            if quality in totals:
                totals[quality] += int(row.get("files") or 0)
                has_evidence = True
        for area in root.get("timestampByTopLevel") or []:
            cluster = area.get("dominantRepeatedTimestamp") or {}
            cluster_files = int(cluster.get("files") or 0)
            if cluster_files > int((dominant or {}).get("files") or 0):
                dominant = {
                    **cluster,
                    "files": cluster_files,
                    "root": root.get("root") or "canonical scope",
                    "topLevel": area.get("topLevel") or "(root)",
                }
                has_evidence = True
    if not has_evidence:
        return None

    line = (
        f"Timestamp evidence: {totals['legacy_or_suspect']:,} legacy-or-suspect files, "
        f"{totals['future_suspect']:,} future-suspect files"
    )
    if dominant:
        timestamp = dominant.get("mtimeUtc") or dominant.get("mtimeSeconds") or "unknown time"
        share = float(dominant.get("shareOfAreaFiles") or 0)
        line += (
            f"; dominant repeated value {timestamp} covers {int(dominant['files']):,} "
            f"{dominant.get('storageRole') or 'classified'} files in "
            f"{dominant['root']}/{dominant['topLevel']} ({share:.2%} of that area)"
        )
    return f"{line}; aggregate review evidence only—age is never deletion evidence."


def policy_decision_support_summary(strategy: dict[str, Any]) -> str | None:
    support = strategy.get("policyDecisionSupport") or {}
    if support.get("mode") != "aggregate-read-only-decision-support":
        return None
    backup = support.get("backupRetention") or {}
    cache = support.get("generatedCache") or {}
    overlap = support.get("overlap") or {}
    survivor = support.get("duplicateSurvivor") or {}
    return (
        "Decision support (verified groups only): backup retention choices affect "
        f"{int(backup.get('verifiedGroups') or 0):,} groups "
        f"({signed_bytes(abs(int(backup.get('provenSavingsBytes') or 0))).lstrip('+')} "
        "proven-savings evidence); generated-cache choices affect "
        f"{int(cache.get('verifiedGroups') or 0):,} groups "
        f"({signed_bytes(abs(int(cache.get('provenSavingsBytes') or 0))).lstrip('+')} "
        f"proven-savings evidence); {int(overlap.get('verifiedGroups') or 0):,} groups overlap; "
        "survivor choices differ in up to "
        f"{int(survivor.get('maximumGroupsWithDifferentSelection') or 0):,} groups. "
        "Aggregate preview only—not authorization or a reclaimable-space plan."
    )


def oversized_unhashed_summary(strategy: dict[str, Any]) -> str:
    evidence = (strategy.get("evidence") or {}).get("oversizedUnhashedCandidates") or {}
    try:
        groups = int(evidence.get("groups"))
        files = int(evidence.get("files"))
        bytes_to_hash = int(evidence.get("bytesToHash"))
    except (TypeError, ValueError):
        groups = files = bytes_to_hash = -1
    measured = (
        evidence.get("status") == "measured"
        and groups >= 0
        and files >= 0
        and bytes_to_hash >= 0
        and evidence.get("bytesAreNotSavings") is True
        and evidence.get("fileIdentityIncluded") is False
        and evidence.get("filesystemMutationAllowed") is False
    )
    if not measured:
        return "Oversized individual-file evidence: unavailable; do not infer a measured zero."
    state = "measured zero" if groups == 0 and files == 0 else "measured"
    formatted_bytes = signed_bytes(bytes_to_hash).lstrip("+")
    return (
        f"Oversized individual-file evidence: {state} — {groups:,} same-size candidate "
        f"group(s), {files:,} individually oversized unhashed file(s), {formatted_bytes} "
        "still to hash (not savings)."
    )


def missing_extension_split(root: dict[str, Any]) -> tuple[int, int, int]:
    total = max(0, int(root.get("missingExtensionUnresolvedFiles") or 0))
    if not all(
        key in root
        for key in (
            "missingExtensionContentKnownFiles",
            "missingExtensionContentUnknownFiles",
        )
    ):
        return total, 0, total
    known = min(total, max(0, int(root.get("missingExtensionContentKnownFiles") or 0)))
    return total, known, total - known


def compact_summary(report: dict[str, Any], path: Path) -> str:
    lines = ["Shared-drive janitor assessment OK (read-only)."]
    strategy = report.get("strategy") or {}
    strategy_roots = {
        str(root.get("root") or ""): root
        for root in ((strategy.get("evidence") or {}).get("perRoot") or [])
    }
    bottom_line = bottom_line_summary(strategy, report.get("roots") or [])
    if bottom_line:
        lines.append(bottom_line)
    lines.append(metadata_first_summary(strategy))
    lines.append(verification_queue_summary(strategy))
    pace = verification_pace_summary(strategy)
    if pace:
        lines.append(pace)
    for item in report["roots"]:
        summary = item["summary"]
        duplicates = summary.get("duplicates") or {}
        candidates = summary.get("duplicateCandidates") or {}
        lines.append(
            f"{item['source']}: {int(summary.get('totalFiles') or 0):,} files, "
            f"{summary.get('totalSizeFormatted') or '0 B'}, "
            f"hash coverage {float(summary.get('hashCoverageFiles') or 0) * 100:.2f}%, "
            f"verified duplicate groups {int(duplicates.get('groups') or 0):,}, "
            f"same-size candidates {int(candidates.get('groups') or 0):,}."
        )
        stats = item.get("stats") or {}
        metadata = stats.get("total") or {}
        if any(
            key in metadata
            for key in (
                "extensionlessByDesign",
                "missingExtensionUnresolved",
                "legacyOrSuspectTimestamp",
                "futureSuspectTimestamp",
            )
        ):
            unclassified = next(
                (
                    int(row.get("count") or 0)
                    for row in stats.get("byCategory") or []
                    if row.get("category") == "unclassified"
                ),
                0,
            )
            suspect_timestamps = int(metadata.get("legacyOrSuspectTimestamp") or 0) + int(
                metadata.get("futureSuspectTimestamp") or 0
            )
            split_root = strategy_roots.get(item["root"], {
                "missingExtensionUnresolvedFiles": metadata.get("missingExtensionUnresolved")
            })
            missing_total, content_known, content_unknown = missing_extension_split(split_root)
            lines.append(
                f"  metadata: {unclassified:,} unclassified, "
                f"{int(metadata.get('extensionlessByDesign') or 0):,} extensionless-by-design, "
                f"{missing_total:,} unresolved missing extensions "
                f"({content_known:,} content-known, {content_unknown:,} content-unknown), "
                f"{suspect_timestamps:,} timestamp review signals."
            )
            unknown_extensions = (item.get("metadataDrilldown") or {}).get("byExtension") or []
            if unknown_extensions:
                leaders = ", ".join(
                    f"{extension_label(row.get('extension'))} {int(row.get('count') or 0):,}"
                    for row in unknown_extensions[:3]
                )
                lines.append(f"  largest unclassified formats: {leaders}.")
    evidence = strategy.get("evidence") or {}
    timestamp_summary = timestamp_evidence_summary(strategy)
    if timestamp_summary:
        lines.append(timestamp_summary)
    decision_support_summary = policy_decision_support_summary(strategy)
    if decision_support_summary:
        lines.append(decision_support_summary)
    portfolio_candidates = evidence.get("duplicateCandidates") or {}
    if any(
        key in evidence
        for key in ("verifiedDuplicateGroups", "verifiedDuplicateFiles", "provenSavingsBytes")
    ):
        lines.append(
            "Canonical portfolio evidence: "
            f"{int(evidence.get('verifiedDuplicateGroups') or 0):,} verified groups, "
            f"{int(evidence.get('verifiedDuplicateFiles') or 0):,} verified files, "
            f"{signed_bytes(abs(int(evidence.get('provenSavingsBytes') or 0))).lstrip('+')} "
            "proven lower-bound savings; "
            f"{int(portfolio_candidates.get('groups') or 0):,} groups, "
            f"{int(portfolio_candidates.get('files') or 0):,} files, "
            f"{signed_bytes(abs(int(portfolio_candidates.get('candidateBytes') or 0))).lstrip('+')} "
            "same-size candidates (candidate bytes are not savings)."
        )
    lines.append(oversized_unhashed_summary(strategy))
    decisions = strategy.get("decisions_required") or []
    maintenance = strategy.get("maintenance") or {}
    proposals = maintenance.get("proposals") or []
    largest_proposal = max((int(item.get("space_saved") or 0) for item in proposals), default=0)
    proposal_note = f" (largest single group {fmt_bytes(largest_proposal)})" if largest_proposal else ""
    lines.append(
        f"Strategy: {strategy.get('status') or 'unavailable'}; "
        f"{len(decisions)} decision(s) required; "
        f"{len(proposals)} review proposal(s){proposal_note}; "
        f"{len(maintenance.get('executableActions') or [])} executable action(s)."
    )
    for decision in decisions:
        choices = ", ".join(str(choice) for choice in decision.get("choices") or [])
        lines.append(
            f"  decision required — {decision.get('field')}: "
            f"{decision.get('question')} Choices: {choices}."
        )
    comparison = strategy.get("comparison") or {}
    if comparison.get("status") == "compared":
        deltas = comparison.get("deltas") or {}
        duplicate_deltas = deltas.get("duplicates") or {}
        candidate_deltas = deltas.get("candidates") or {}
        previous = comparison.get("previousGeneratedAt") or comparison.get("previousReportId") or "prior report"
        lines.append(
            f"Strategy trend vs {previous}: verified groups "
            f"{signed_count(duplicate_deltas.get('verifiedGroups'))}, proven bytes "
            f"{signed_bytes(duplicate_deltas.get('provenSavingsBytes'))}, same-size candidate groups "
            f"{signed_count(candidate_deltas.get('groups'))}."
        )
        for root_delta in (deltas.get("perRoot") or [])[:2]:
            lines.append(
                f"  {root_delta.get('root')}: unclassified "
                f"{signed_count(root_delta.get('unclassifiedFiles'))}, unresolved missing extensions "
                f"{signed_count(root_delta.get('missingExtensionUnresolvedFiles'))}, timestamp review "
                f"{signed_count(root_delta.get('timestampReviewFiles'))}."
            )
    elif comparison.get("status") == "baseline":
        lines.append(
            f"Strategy trend: baseline ({comparison.get('reason') or 'no compatible prior report'}); "
            "no improvement or regression is inferred."
        )
    organization_comparison = comparison.get("organization") or {}
    if organization_comparison.get("status") == "compared":
        counts = organization_comparison.get("counts") or {}
        totals = organization_comparison.get("totals") or {}
        lines.append(
            "Organization evidence progress: "
            f"{int(counts.get('new') or 0):,} new, "
            f"{int(counts.get('improved') or 0):,} improved, "
            f"{int(counts.get('worsened') or 0):,} worsened, "
            f"{int(counts.get('unchanged') or 0):,} unchanged, "
            f"{int(counts.get('resolved') or 0):,} resolved; "
            f"{int(totals.get('currentAccountedFor') or 0):,} of "
            f"{int(totals.get('current') or 0):,} current candidates accounted for."
        )
        for change in (organization_comparison.get("topChanges") or [])[:3]:
            lines.append(
                f"  evidence {change.get('change') or 'changed'} — "
                f"{change.get('title') or change.get('id')}: files "
                f"{signed_count(change.get('filesDelta'))}, bytes "
                f"{signed_bytes(change.get('bytesDelta'))} in "
                f"{change.get('root') or 'canonical scope'}."
            )
    else:
        lines.append(
            "Organization evidence progress: baseline "
            f"({organization_comparison.get('reason') or 'organization_comparison_unavailable'}); "
            "no work-item improvement, regression, or resolution is inferred."
        )
    organization = strategy.get("organizationStrategy") or {}
    work_items = organization.get("workItems") or []
    lines.append(
        f"Organization strategy: {len(work_items)} prioritized non-destructive work item(s)."
    )
    for item in work_items[:3]:
        evidence = item.get("evidence") or {}
        mirrors = item.get("likelyMirrorOf") or []
        mirror_note = (
            "; correlated aggregate evidence only: "
            + ", ".join(str(mirror).rsplit(":", 1)[-1] for mirror in mirrors[:3])
            if mirrors else ""
        )
        lines.append(
            f"  #{int(item.get('rank') or 0)} [{item.get('priority') or 'review'}] "
            f"{item.get('title') or item.get('id')}: {int(evidence.get('files') or 0):,} files, "
            f"{fmt_bytes(evidence.get('bytes'))} in "
            f"{item.get('root') or 'canonical scope'}{mirror_note}."
        )
    actions = next_actions_summary(strategy)
    if actions:
        lines.append("Next actions (in value order):")
        lines.extend(f"  {index}. {action}." for index, action in enumerate(actions, start=1))
    lines.append(EVIDENCE_POLICY_FOOTER)
    lines.append(f"Report: {path}")
    lines.append("No files were moved, renamed, archived, or deleted.")
    return "\n".join(lines)


def notification_summary(
    report: dict[str, Any],
    dashboard_url: str = DEFAULT_DASHBOARD_URL,
) -> str:
    """Build the bounded success notification delivered by the scheduled job."""
    strategy = report.get("strategy") or {}
    evidence = strategy.get("evidence") or {}
    candidates = evidence.get("duplicateCandidates") or {}
    maintenance = strategy.get("maintenance") or {}
    safety = report.get("safety") or {}
    decisions = strategy.get("decisions_required") or []
    status = " ".join(str(strategy.get("status") or "unavailable").replace("_", " ").split())[:60]
    lines = [f"Shared-drive Janitor: OK - {status} (read-only)."]

    verified_values = (
        evidence.get("verifiedDuplicateGroups"),
        evidence.get("provenSavingsBytes"),
    )
    if all(is_nonnegative_number(value) for value in verified_values):
        lines.append(
            f"Proven: {fmt_bytes(verified_values[1])} across "
            f"{int(verified_values[0]):,} SHA-256 groups (lower bound)."
        )
    else:
        lines.append("Proven duplicate totals: unavailable; review the dashboard before drawing conclusions.")

    backlog_values = (candidates.get("filesToHash"), candidates.get("bytesToHash"))
    if all(is_nonnegative_number(value) for value in backlog_values):
        backlog = f"Backlog: {int(backlog_values[0]):,} files / {fmt_bytes(backlog_values[1])} to hash"
        outlook = evidence.get("verificationOutlook") or {}
        cycle = outlook.get("latestCompletedCycle") or {}
        comparable_cycles = cycle.get("estimatedComparableCyclesLowerBound")
        if outlook.get("status") == "measured" and is_nonnegative_number(comparable_cycles):
            backlog += f"; at least {int(comparable_cycles):,} comparable cycle(s), not a calendar ETA"
        else:
            backlog += "; measured pace unavailable, no ETA inferred"
        lines.append(f"{backlog}.")
    else:
        lines.append("Verification backlog: unavailable; candidate bytes must not be treated as savings.")

    comparison = strategy.get("comparison") or {}
    if comparison.get("status") == "compared":
        deltas = comparison.get("deltas") or {}
        duplicate_delta = (deltas.get("duplicates") or {}).get("provenSavingsBytes")
        candidate_delta = (deltas.get("candidates") or {}).get("candidateBytes")
        if all(is_number(value) for value in (duplicate_delta, candidate_delta)):
            lines.append(
                f"Since prior: {signed_bytes(duplicate_delta)} proven; "
                f"{signed_bytes(candidate_delta)} same-size candidate evidence."
            )
        organization = comparison.get("organization") or {}
        counts = organization.get("counts") or {}
        count_values = tuple(counts.get(key) for key in ("new", "improved", "worsened", "resolved"))
        if organization.get("status") == "compared" and all(
            is_nonnegative_number(value) for value in count_values
        ):
            lines.append(
                "Organization: "
                f"{int(count_values[0]):,} new, {int(count_values[1]):,} improved, "
                f"{int(count_values[2]):,} worsened, {int(count_values[3]):,} resolved."
            )

    proposals = maintenance.get("proposals")
    executable = maintenance.get("executableActions")
    safe = (
        isinstance(proposals, list)
        and isinstance(executable, list)
        and not executable
        and safety.get("destructiveRequestsMade") == 0
        and safety.get("approvalEndpointsCalled") is False
        and safety.get("deleteMoveArchiveExecuted") is False
    )
    if safe:
        lines.append(f"Review: {len(proposals):,} proposal(s); 0 executable actions; 0 mutations.")
    else:
        lines.append("Safety state: ATTENTION - review the complete report before any follow-up.")
    if decisions:
        lines.append(f"Policy: {len(decisions):,} human decision(s) still required.")

    url = str(dashboard_url or DEFAULT_DASHBOARD_URL).strip()
    if (
        not url.startswith(("http://", "https://"))
        or any(character.isspace() for character in url)
        or len(url) > 200
    ):
        url = DEFAULT_DASHBOARD_URL
    lines.append(f"Dashboard + complete report: {url}")
    lines.append(
        "Evidence: SHA-256 savings are lower bounds; candidate bytes are verification work, not savings. "
        f"{FIFTY_GIB_HASH_DISCLAIMER} No file action is authorized."
    )
    return "\n".join(lines)
