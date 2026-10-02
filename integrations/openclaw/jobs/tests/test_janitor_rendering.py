import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from janitor import rendering  # noqa: E402

GIB = 1024**3


def synthetic_strategy():
    candidates = {
        "groups": 4,
        "files": 9,
        "candidateBytes": 6 * GIB,
        "filesToHash": 5,
        "bytesToHash": 3 * GIB,
        "candidateBytesAreNotSavings": True,
    }
    return {
        "status": "decisions_required",
        "evidence": {
            "verifiedDuplicateGroups": 2,
            "verifiedDuplicateFiles": 5,
            "provenSavingsBytes": 2 * GIB,
            "duplicateCandidates": candidates,
            "metadataFirst": {
                "status": "measured",
                "indexedFiles": 1200,
                "indexedBytes": 40 * GIB,
                "canonicalRoots": 2,
                "organizationReviewAvailable": True,
                "exactDuplicateProofRequired": True,
                "filesystemMutationAllowed": False,
                "signals": ["storage_role", "timestamp_quality"],
            },
            "verificationQueue": {
                "status": "prioritized",
                "ordering": ["potential_duplicate_bytes_desc", "file_size_desc"],
                "groups": 4,
                "files": 9,
                "potentialDuplicateBytes": 6 * GIB,
                "filesToHash": 5,
                "bytesToHash": 3 * GIB,
                "potentialDuplicateBytesAreNotSavings": True,
                "exactDuplicateProofRequired": True,
                "filesystemMutationAllowed": False,
            },
            "verificationOutlook": {
                "status": "measured",
                "filesToHash": 5,
                "bytesToHash": 3 * GIB,
                "latestCompletedCycle": {
                    "hashedBytes": GIB,
                    "hashedFiles": 2,
                    "durationSeconds": 600,
                    "estimatedComparableCyclesLowerBound": 3,
                },
                "configuredCapacity": {"estimatedCyclesLowerBound": 1},
            },
            "oversizedUnhashedCandidates": {
                "status": "measured",
                "groups": 0,
                "files": 0,
                "bytesToHash": 0,
                "bytesAreNotSavings": True,
                "fileIdentityIncluded": False,
                "filesystemMutationAllowed": False,
            },
            "perRoot": [
                {
                    "root": "/mnt/media",
                    "missingExtensionUnresolvedFiles": 10,
                    "missingExtensionContentKnownFiles": 4,
                    "missingExtensionContentUnknownFiles": 6,
                    "timestampQualityTotals": [{"timestampQuality": "legacy_or_suspect", "files": 7}],
                    "timestampByTopLevel": [
                        {
                            "topLevel": "Archive",
                            "dominantRepeatedTimestamp": {
                                "files": 5,
                                "mtimeUtc": "2001-01-01T00:00:00Z",
                                "shareOfAreaFiles": 0.5,
                                "storageRole": "backup",
                            },
                        }
                    ],
                }
            ],
        },
        "decisions_required": [
            {"field": "backup_retention", "question": "Keep backups?", "choices": ["keep", "review"]}
        ],
        "maintenance": {"proposals": [{"space_saved": GIB}], "executableActions": []},
        "comparison": {
            "status": "compared",
            "previousGeneratedAt": "2026-01-01T00:00:00Z",
            "deltas": {
                "duplicates": {"verifiedGroups": 1, "provenSavingsBytes": GIB},
                "candidates": {"groups": -1, "candidateBytes": -GIB},
            },
            "organization": {
                "status": "compared",
                "counts": {"new": 1, "improved": 2, "worsened": 0, "unchanged": 3, "resolved": 1},
                "totals": {"currentAccountedFor": 6, "current": 6},
            },
        },
        "organizationStrategy": {
            "workItems": [
                {"type": "hash_coverage", "id": "hash", "rank": 1, "evidence": {"files": 5, "bytes": GIB}},
                {
                    "type": "metadata",
                    "id": "unclassified",
                    "title": "Classify unknown formats",
                    "rank": 2,
                    "priority": "high",
                    "root": "/mnt/media",
                    "evidence": {"files": 30, "bytes": 2 * GIB},
                },
            ]
        },
    }


def synthetic_report():
    return {
        "generatedAt": "2026-01-02T03:04:05+00:00",
        "strategy": synthetic_strategy(),
        "safety": {
            "destructiveRequestsMade": 0,
            "approvalEndpointsCalled": False,
            "deleteMoveArchiveExecuted": False,
        },
        "roots": [
            {
                "source": "media",
                "root": "/mnt/media",
                "summary": {
                    "totalFiles": 1000,
                    "totalSizeFormatted": "30 GiB",
                    "hashCoverageFiles": 0.25,
                    "duplicates": {"groups": 2},
                    "duplicateCandidates": {"groups": 4},
                },
                "stats": {
                    "total": {"extensionlessByDesign": 3, "missingExtensionUnresolved": 10},
                    "byCategory": [{"category": "unclassified", "count": 12}],
                },
                "metadataDrilldown": {"byExtension": [{"extension": "xyz", "count": 8}, {"extension": "", "count": 4}]},
            }
        ],
    }


class FormattingTest(unittest.TestCase):
    def test_byte_and_count_formatting(self):
        self.assertEqual(rendering.signed_bytes(None), "n/a")
        self.assertEqual(rendering.signed_bytes(512), "+512 B")
        self.assertEqual(rendering.signed_bytes(-GIB), "-1.00 GiB")
        self.assertEqual(rendering.fmt_bytes(-3 * 1024), "3.00 KiB")
        self.assertEqual(rendering.signed_count(1234), "+1,234")
        self.assertFalse(rendering.is_number(True))
        self.assertFalse(rendering.is_nonnegative_number(-1))
        self.assertEqual(rendering.extension_label(""), "no extension")
        self.assertEqual(rendering.extension_label("bin"), ".bin")

    def test_missing_extension_split(self):
        self.assertEqual(rendering.missing_extension_split({"missingExtensionUnresolvedFiles": 5}), (5, 0, 5))
        self.assertEqual(
            rendering.missing_extension_split({
                "missingExtensionUnresolvedFiles": 5,
                "missingExtensionContentKnownFiles": 9,
                "missingExtensionContentUnknownFiles": 0,
            }),
            (5, 5, 0),
        )


class LaneSummaryTest(unittest.TestCase):
    def test_verification_queue_prioritized_and_inconsistent(self):
        strategy = synthetic_strategy()
        self.assertIn("4 same-size candidate groups", rendering.verification_queue_summary(strategy))
        strategy["evidence"]["verificationQueue"]["bytesToHash"] = 1
        self.assertIn("unavailable", rendering.verification_queue_summary(strategy))

    def test_metadata_first_requires_safety_flags(self):
        strategy = synthetic_strategy()
        self.assertIn("1,200 indexed files", rendering.metadata_first_summary(strategy))
        strategy["evidence"]["metadataFirst"]["filesystemMutationAllowed"] = True
        self.assertIn("unavailable", rendering.metadata_first_summary(strategy))

    def test_pace_and_oversized(self):
        strategy = synthetic_strategy()
        self.assertIn("~3 comparable cycle(s)", rendering.verification_pace_summary(strategy))
        self.assertIn("measured zero", rendering.oversized_unhashed_summary(strategy))
        self.assertIn("unavailable", rendering.oversized_unhashed_summary({}))

    def test_next_actions_order(self):
        actions = rendering.next_actions_summary(synthetic_strategy())
        self.assertEqual([action.split(" ")[0] for action in actions], ["verify", "decide", "organize"])


class NotificationTest(unittest.TestCase):
    def test_safe_notification(self):
        text = rendering.notification_summary(synthetic_report(), "https://dashboard.test/data-toolbox#janitor")
        lines = text.splitlines()
        self.assertEqual(lines[0], "Shared-drive Janitor: OK - decisions required (read-only).")
        self.assertIn("Proven: 2.00 GiB across 2 SHA-256 groups (lower bound).", lines)
        self.assertIn("Review: 1 proposal(s); 0 executable actions; 0 mutations.", lines)
        self.assertIn("Policy: 1 human decision(s) still required.", lines)
        self.assertIn("Dashboard + complete report: https://dashboard.test/data-toolbox#janitor", lines)
        self.assertIn("at least 3 comparable cycle(s)", text)

    def test_unsafe_state_and_invalid_dashboard(self):
        report = synthetic_report()
        report["strategy"]["maintenance"]["executableActions"] = [{"action": "delete"}]
        text = rendering.notification_summary(report, "javascript:alert(1)")
        self.assertIn("Safety state: ATTENTION", text)
        self.assertIn(f"Dashboard + complete report: {rendering.DEFAULT_DASHBOARD_URL}", text)

    def test_compact_summary_covers_sections(self):
        text = rendering.compact_summary(synthetic_report(), Path("reports/latest.json"))
        self.assertTrue(text.startswith("Shared-drive janitor assessment OK (read-only)."))
        self.assertIn("Bottom line: 2.00 GiB duplicate savings proven so far", text)
        self.assertIn("media: 1,000 files, 30 GiB, hash coverage 25.00%", text)
        self.assertIn("(4 content-known, 6 content-unknown)", text)
        self.assertIn("largest unclassified formats: .xyz 8, no extension 4.", text)
        self.assertIn("decision required — backup_retention", text)
        self.assertIn("Organization evidence progress: 1 new, 2 improved", text)
        self.assertIn("Next actions (in value order):", text)
        self.assertIn(rendering.EVIDENCE_POLICY_FOOTER, text)
        self.assertTrue(text.endswith("No files were moved, renamed, archived, or deleted."))


if __name__ == "__main__":
    unittest.main()
