"""Content-free read projection of native general and objective review receipts."""
from pathlib import Path
from datetime import datetime, timezone
import re

from evidence_store import load
from objective_annual import project as annual_projection

ARCHIVE_FIELDS = ("at", "pendingTextPages", "reviewedPages", "unresolvedInferenceAttempts",
                  "uncollectedThreads", "discoveringScopes", "unavailableMessages", "unavailableDraftMessages", "pending")
COUNTS = ("targetSources", "materializedSources", "sourcesPendingMaterialization", "sourcesTextReviewed", "sourcesWithGaps",
          "sourceErrors", "expectedPagesKnown", "reviewedPages", "pendingPagesKnown", "invalidReviewReceipts", "extractedMoments", "reviewGaps")
COUNTS += ("sourcesTextCovered", "equivalentPages", "rejectedPages", "sourcesWithRejectedPages")
COUNTS += ("deferredRejectedCopyPages", "sourcesWithDeferredRejectedCopies")


def timestamp(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.timestamp() if parsed.tzinfo else 0
    except (AttributeError, TypeError, ValueError, OverflowError):
        return 0


def controller(directory, clock):
    rows = []
    for file in sorted((directory / "campaigns").glob("*/state.json"))[:100]:
        try:
            state = load(file, {})
            watch = load(file.parent / "watch-status.json", {})
            at = max((state.get("at"), watch.get("at")), key=timestamp)
            stamp = timestamp(at)
            if not stamp or stamp > clock + 300:
                continue
            current = state.get("current") or {}
            phase = str(state.get("phase", "unknown"))[:60]
            row = {"phase": phase, "at": at, "fresh": 0 <= clock - stamp <= 180,
                   "watchPhase": str(watch.get("phase", "unknown"))[:60]}
            for key in ("queueId", "dispatchId"):
                value = current.get(key) or watch.get(key)
                if re.fullmatch(r"[a-f0-9-]{36}", str(value or "")):
                    row[key] = value
            rows.append(row)
        except (OSError, ValueError, TypeError, AttributeError):
            continue
    return max(rows, key=lambda row: timestamp(row["at"])) if rows else None


def observed_phase(phase, observation, at, clock):
    if observation:
        state = observation["phase"]
        terminal = {"uncertain": "uncertain", "queue-submission-unconfirmed": "uncertain",
                    "needs-source-review": "source-error", "controller-drained": "paused",
                    "awaiting-output-review": "paused", "publication-pending": "paused"}
        if state in terminal:
            return terminal[state]
        if observation["watchPhase"] in ("stopped-for-review", "stopped-on-error"):
            return "uncertain"
        if not observation["fresh"]:
            return "stopped"
    elif phase in ("reviewing", "running") and clock - timestamp(at) > 300:
        return "stopped"
    return phase


def projection(root, clock=None):
    root = Path(root)
    clock = datetime.now(timezone.utc).timestamp() if clock is None else clock
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
            at = status.get("at") or value.get("at")
            observation = controller(file.parent, clock)
            objectives.append({"objectiveId": value.get("objectiveId"), "version": value.get("version"),
                "at": at, "phase": observed_phase(status.get("phase", "planned"), observation, at, clock),
                "counts": {k: v for k, v in value.get("counts", {}).items() if k in COUNTS and type(v) is int and v >= 0},
                "allTargetTextReviewed": value.get("allTargetTextReviewed") is True,
                "allTargetTextCovered": value.get("allTargetTextCovered") is True,
                "semanticAcceptance": "not-established", "userConfirmed": False,
                "newlyReviewedPages": status.get("newlyReviewedPages"), "elapsedSeconds": status.get("elapsedSeconds")})
            if observation:
                objectives[-1]["controller"] = observation
            annual = annual_projection(value.get("annualCoverage"))
            if annual:
                objectives[-1]["annualCoverage"] = annual
        except (OSError, ValueError, TypeError, AttributeError):
            objectives.append({"objectiveId": file.parent.parent.name, "version": file.parent.name, "phase": "unavailable"})
    return {"archiveProgress": archive, "objectiveReviews": objectives}
