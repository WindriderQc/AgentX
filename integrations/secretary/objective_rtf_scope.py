"""Reader migration and coverage of known RTF parts, without altering receipts."""
from archive_rtf import PROFILE, is_rtf


def known_rtf(plan):
    return any(is_rtf(p.get("mimeType"), p.get("filename")) for gap in plan.get("gaps", [])
               for p in gap.get("documents", [])) or any(
        p.get("extraction", {}).get("processor") == "striprtf" for p in plan.get("representations", []))


def upgrade_pending(plan):
    return known_rtf(plan) and plan.get("source", {}).get("rtfReaderProfile") != PROFILE


def coverage_gaps(plan):
    if upgrade_pending(plan):
        return [{"code": "rtf-reader-upgrade-pending", "profile": PROFILE}]
    return []


def opaque_body(plan):
    return upgrade_pending(plan) or any(g.get("code") == "rtf-text-unreadable" for g in plan.get("gaps", []))


def had_headers(plan):
    return any(p.get("representation") == "message-headers" for p in plan.get("representations", []))
