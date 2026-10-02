import importlib.util
import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "openclaw_pipeline_worker.py"
SPEC = importlib.util.spec_from_file_location("openclaw_pipeline_worker", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class OpenClawPipelineWorkerTests(unittest.TestCase):
    def test_retry_after_delay_uses_agentx_iso_timestamp(self):
        now = datetime(2026, 7, 16, 17, 30, 0, tzinfo=timezone.utc)
        raw = json.dumps({"retryAfter": "2026-07-16T17:30:12Z"})
        self.assertEqual(MODULE.retry_after_delay(raw, now=now), 12.0)

    def test_claim_requires_confirmed_assignment(self):
        response = {
            "ok": True,
            "data": {
                "task": {
                    "pipelineId": "0379",
                    "status": "in_progress",
                    "assignee": "clawdx-coder",
                }
            },
        }
        with patch.object(MODULE, "api_json", return_value=response) as mocked:
            task = MODULE.claim_task("http://agentx", "0379", "clawdx-coder")
        self.assertEqual(task["status"], "in_progress")
        self.assertEqual(mocked.call_args.kwargs["payload"], {"assignee": "clawdx-coder"})

    def test_feedback_reads_file_and_requires_review(self):
        response = {
            "ok": True,
            "data": {
                "task": {
                    "pipelineId": "0379",
                    "status": "review",
                    "feedback": [{"by": "clawdx-coder", "text": "verified"}],
                }
            },
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            text_file = Path(temp_dir) / "feedback.md"
            text_file.write_text("verified", encoding="utf-8")
            with patch.object(MODULE, "api_json", return_value=response) as mocked:
                task = MODULE.submit_feedback(
                    "http://agentx",
                    "0379",
                    by="clawdx-coder",
                    status="done",
                    text_file=text_file,
                )
        self.assertEqual(task["status"], "review")
        self.assertEqual(
            mocked.call_args.kwargs["payload"],
            {"status": "done", "by": "clawdx-coder", "text": "verified"},
        )

    def test_worker_helper_has_no_authority_beyond_lifecycle(self):
        """The file-tool worker helper must be able to reach no authority that
        grants human review, merge, deployment, or attempt-evidence
        reconciliation.

        The helper is a bounded lifecycle helper only. It exposes exactly four
        actions (get, claim, heartbeat, feedback), feedback status is constrained
        to {done, partial, blocked}, and none of its call sites reach any
        review/merge/deploy/evidence-reconciliation endpoint. "review" is only
        ever the *target* of a done feedback, never a worker-chosen action.
        """

        # (1) The CLI surface is exactly the four bounded lifecycle actions.
        #     No review / merge / deploy / reconcile subcommand exists, so any
        #     such unknown action must be rejected at parse time (SystemExit).
        for forbidden_action in ("review", "merge", "deploy", "reconcile-evidence"):
            with self.assertRaises(SystemExit):
                with patch.object(sys, "argv", ["prog", forbidden_action, "--task-id", "0379"]):
                    MODULE.parse_args()

        # (2) The module exposes exactly one action per bounded lifecycle
        #     operation and nothing more. The only public helpers that map to
        #     lifecycle calls are get/claim/heartbeat/feedback; there is no
        #     review/merge/deploy/reconcile helper to call.
        lifecycle_helpers = {
            "get": "fetch_task",
            "claim": "claim_task",
            "heartbeat": "heartbeat_task",
            "feedback": "submit_feedback",
        }
        for action, helper in lifecycle_helpers.items():
            self.assertTrue(callable(getattr(MODULE, helper)), action)
        for forbidden_helper in (
            "review_task",
            "merge_task",
            "deploy_task",
            "reconcile_evidence",
        ):
            self.assertFalse(hasattr(MODULE, forbidden_helper), forbidden_helper)

    def test_feedback_status_cannot_select_review_merge_or_deploy(self):
        """A worker can only report done/partial/blocked. It can never choose
        'review', and has no status path toward merge, deploy, or
        evidence-reconciliation. 'done' only moves a task to the review state;
        the human owns the final decision from review onward.
        """
        # The only feedback statuses the module defines are the three bounded ones.
        self.assertEqual(
            set(MODULE.FEEDBACK_TARGET_STATUS), {"done", "partial", "blocked"}
        )
        # A worker 'done' feedback maps to the review target -- not to merge,
        # deploy, or any human-review action.
        self.assertEqual(MODULE.FEEDBACK_TARGET_STATUS["done"], "review")
        # No feedback status resolves to a merge/deploy/evidence target.
        for status, target in MODULE.FEEDBACK_TARGET_STATUS.items():
            self.assertIn(target, ("review", "in_progress", "blocked"))
            self.assertNotIn("merged", (target, status))
            self.assertNotIn("deployed", (target, status))
            self.assertNotIn("accept", (target, status))

    def test_helper_source_never_references_authority_endpoints(self):
        """The helper's source must not reference any human-review, merge,
        deployment, or attempt-evidence-reconciliation endpoint or argument.
        This is the regression guard: if any such surface is later added to the
        worker helper, this test fails. """
        src = SCRIPT.read_text(encoding="utf-8")
        lowered = src.lower()
        # Forbidden authority markers that must never appear in the worker helper.
        forbidden_markers = (
            "/merge",
            "/merge/",
            "/deploy",
            "/deploy/",
            "/approve",
            "/accept",
            "reconcile",
            "human-review",
            "human_review",
            "--merge",
            "--deploy",
            "--approve",
            "--accept",
        )
        for marker in forbidden_markers:
            self.assertNotIn(
                marker,
                lowered,
                f"worker helper must not reference authority marker {marker!r}",
            )

    def test_feedback_rejects_text_larger_than_api_limit(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            text_file = Path(temp_dir) / "feedback.md"
            text_file.write_text("x" * 5001, encoding="utf-8")
            with self.assertRaisesRegex(MODULE.PipelineWorkerError, "API limit"):
                MODULE.submit_feedback(
                    "http://agentx",
                    "0379",
                    by="clawdx-coder",
                    status="done",
                    text_file=text_file,
                )


if __name__ == "__main__":
    unittest.main()
