import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from objective_status import projection


class ObjectiveStatusTests(unittest.TestCase):
    def test_stopped_controller_overrides_old_page_phase_without_exposing_content(self):
        with tempfile.TemporaryDirectory() as home:
            root = Path(home)
            objective = root / "objective-reviews/life/v1"
            campaign = objective / "campaigns/c1"
            campaign.mkdir(parents=True)
            (objective / "coverage.json").write_text(json.dumps({"objectiveId": "life", "version": "v1", "counts": {"reviewedPages": 3}}))
            (objective / "status.json").write_text(json.dumps({"phase": "reviewing", "at": "2026-01-01T00:00:00Z"}))
            (campaign / "state.json").write_text(json.dumps({"phase": "uncertain", "at": "2026-01-01T00:01:00Z",
                "reason": "private diagnostic", "current": {"queueId": "a" * 36, "dispatchId": "b" * 36}}))
            (campaign / "watch-status.json").write_text(json.dumps({"phase": "stopped-for-review", "at": "2026-01-01T00:01:01Z"}))
            value = projection(root)["objectiveReviews"][0]
            self.assertEqual(value["phase"], "uncertain")
            self.assertFalse(value["controller"]["fresh"])
            self.assertEqual(value["controller"]["queueId"], "a" * 36)
            self.assertNotIn("private", json.dumps(value))
            self.assertFalse(value["userConfirmed"])

    def test_an_old_running_page_without_a_controller_is_not_current_activity(self):
        with tempfile.TemporaryDirectory() as home:
            root = Path(home)
            objective = root / "objective-reviews/life/v1"
            objective.mkdir(parents=True)
            (objective / "coverage.json").write_text(json.dumps({"counts": {}}))
            (objective / "status.json").write_text(json.dumps({"phase": "reviewing", "at": "2026-01-01T00:00:00Z"}))
            self.assertEqual(projection(root)["objectiveReviews"][0]["phase"], "stopped")

    def test_status_reads_the_selected_archive_root(self):
        from argparse import Namespace
        from secretary_mail_desk import catchup
        with tempfile.TemporaryDirectory() as home:
            root = Path(home)
            (root / "catchup-status.json").write_text(json.dumps({"phase": "done", "reviewed": 7}))
            result = catchup(Namespace(evidence_root=root))
            self.assertTrue(result["known"])
            self.assertEqual(result["reviewed"], 7)
