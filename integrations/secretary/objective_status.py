"""Content-free read projection of native general and objective review receipts."""
from pathlib import Path

from evidence_store import load
from objective_annual import project as annual_projection

ARCHIVE_FIELDS = ("at", "pendingTextPages", "reviewedPages", "unresolvedInferenceAttempts",
                  "uncollectedThreads", "discoveringScopes", "unavailableMessages", "unavailableDraftMessages", "pending")
COUNTS = ("targetSources", "materializedSources", "sourcesPendingMaterialization", "sourcesTextReviewed", "sourcesWithGaps",
          "sourceErrors", "expectedPagesKnown", "reviewedPages", "pendingPagesKnown", "invalidReviewReceipts", "extractedMoments", "reviewGaps")
COUNTS += ("sourcesTextCovered", "equivalentPages", "rejectedPages", "sourcesWithRejectedPages")
COUNTS += ("deferredRejectedCopyPages", "sourcesWithDeferredRejectedCopies")


def projection(root):
    root = Path(root)
    try:
        archive = load(root / "native-status.json", {})
        archive = {k: archive[k] for k in ARCHIVE_FIELDS if k in archive} or None
    except (OSError, ValueError, TypeError):
        archive = None
    objectives = []
    # Bounded status only: full source/page manifests remain behind their owner.
    for file in sorted((root / "objective-reviews").glob("*/*/coverage.json"))[:100]:
        try:
            value = load(file, {})
            status = load(file.parent / "status.json", {})
            objectives.append({"objectiveId": value.get("objectiveId"), "version": value.get("version"),
                "at": status.get("at") or value.get("at"), "phase": status.get("phase", "planned"),
                "counts": {k: v for k, v in value.get("counts", {}).items() if k in COUNTS and type(v) is int and v >= 0},
                "allTargetTextReviewed": value.get("allTargetTextReviewed") is True,
                "allTargetTextCovered": value.get("allTargetTextCovered") is True,
                "semanticAcceptance": "not-established", "userConfirmed": False,
                "newlyReviewedPages": status.get("newlyReviewedPages"), "elapsedSeconds": status.get("elapsedSeconds")})
            annual = annual_projection(value.get("annualCoverage"))
            if annual:
                objectives[-1]["annualCoverage"] = annual
        except (OSError, ValueError, TypeError, AttributeError):
            objectives.append({"objectiveId": file.parent.parent.name, "version": file.parent.name, "phase": "unavailable"})
    return {"archiveProgress": archive, "objectiveReviews": objectives}
