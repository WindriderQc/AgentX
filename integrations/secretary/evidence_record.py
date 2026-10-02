"""Record one reviewed evidence page into the private Secretary archive.

Shared by the agent's single-page cursor (secretary_evidence.native_record) and
the bounded catch-up job (mail_catchup.py), which reviews pages back to back.
"""
from __future__ import annotations

from evidence_store import load, now, save

SECTIONS = ("actions", "memories", "deliverables", "invoices")


def record_page(archive, page, value, *, export=True):
    """Validate a page review, merge it into the thread review and mark the page read.

    The page must come from the current manifest: changed evidence is reissued
    with a new page id, never recorded against stale content.
    """
    if value.get("pageId") != page["pageId"]:
        raise ValueError("Review must match the issued source page")
    if not isinstance(value.get("summary"), str) or not value["summary"].strip():
        raise ValueError("A substantive page summary is required")
    root = archive.root
    manifest = load(root / "threads" / page["threadId"] / "manifest.json")
    if page["evidenceHash"] != manifest["evidenceHash"]:
        raise ValueError("Evidence changed; retrieve a fresh page")
    review = load(root / "reviews" / (page["threadId"] + ".json"), {})
    review.update(threadId=page["threadId"], evidenceHash=page["evidenceHash"], coverage="partial")
    for section in SECTIONS:
        additions = value.get(section, [])
        if not isinstance(additions, list):
            raise ValueError(f"{section} must be an array")
        existing = review.setdefault(section, [])
        for item in additions:
            if not isinstance(item, dict) or item.get("messageId") != page["messageId"]:
                raise ValueError("Findings must cite the issued messageId")
            if section in ("actions", "memories", "deliverables") and not item.get("text"):
                raise ValueError("A finding needs text")
            if item not in existing:
                existing.append(item)
    unresolved = value.get("unresolved", [])
    if not isinstance(unresolved, list) or any(not isinstance(x, str) for x in unresolved):
        raise ValueError("unresolved must be an array of strings")
    review["unresolved"] = list(dict.fromkeys(review.get("unresolved", []) + unresolved))
    summaries = review.setdefault("pageSummaries", {})
    summaries[page["pageId"]] = {"messageId": page["messageId"], "summary": value["summary"]}
    review.setdefault("summary", value["summary"])
    reviewed = root / "page-reviews"
    all_read = all(p["pageId"] == page["pageId"] or (reviewed / (p["pageId"] + ".json")).exists()
                   for p in archive.review_pages(manifest))
    visual_pending = any(a["status"] != "text_extracted" for m in manifest["messages"] for a in m["attachments"])
    if all_read and not visual_pending and not review["unresolved"]:
        review["coverage"] = "complete"
    # Existing receipt validation runs before the page is marked read.
    archive.review(review, export=export)
    save(reviewed / (page["pageId"] + ".json"), {**value, "threadId": page["threadId"], "at": now()})
    return {"saved": True, "pageId": page["pageId"], "coverage": review["coverage"]}
