import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from integrations.coding import coding_team_promotion as promotion


BASE_REVISION = "a" * 40


def accepted_task(*, fingerprint: str = "b" * 64):
    return {
        "pipelineId": "0599",
        "service": "aiops",
        "status": "done",
        "feedback": [],
        "automation": {
            "mode": "review_only",
            "policyRef": "agentx.reviewed-code/v1",
            "scope": ["docs/result.md"],
            "humanGates": ["review", "merge", "deploy"],
        },
        "automationAttempts": [
            {
                "attempt": 1,
                "assignee": "clawdx-worker",
                "finalState": "review",
                "reviewOutcome": "accepted",
                "reviewedAt": "2026-09-03T00:00:00Z",
                "evidence": {
                    "verification": {"status": "passed"},
                    "changes": {"filesChanged": 1, "bytesChanged": 12},
                    "failureCodes": [],
                    "workerReceiptFingerprint": fingerprint,
                },
            }
        ],
    }


def policy_config():
    return {
        "policies": {
            "agentx.reviewed-code/v1": {
                "repository": "agentx",
                "allowedPathPrefixes": ["docs/", "scripts/tests/"],
                "protectedPathPrefixes": [".github/workflows/", "LEAD.md"],
            }
        }
    }


class CodingTeamPromotionTests(unittest.TestCase):
    def test_promotion_rechecks_accepted_patch_in_the_same_sandbox(self):
        with patch.object(promotion.clawdx_dispatch_remote, "run_independent_verification",
                          return_value=(0, "158 tests passed")) as verify:
            output = promotion.verify_accepted_snapshot(
                "worker", Path("/workspace/repo"), "python3 -m unittest",
                BASE_REVISION, 120)
        self.assertEqual(output, "158 tests passed")
        verify.assert_called_once_with(
            "worker", str(Path("/workspace/repo")), "python3 -m unittest",
            expected_revision=BASE_REVISION, timeout=120)
        with patch.object(promotion.clawdx_dispatch_remote, "run_independent_verification",
                          return_value=(127, "bwrap missing")):
            with self.assertRaisesRegex(promotion.PromotionError, "sandboxed promotion verification failed"):
                promotion.verify_accepted_snapshot(
                    "worker", Path("/workspace/repo"), "python3 -m unittest",
                    BASE_REVISION, 120)

    def test_accepts_review_and_merge_contract_without_an_extra_deployment_approval(self):
        candidate = accepted_task()
        candidate["automation"]["humanGates"] = ["review", "merge"]
        self.assertEqual(len(promotion.eligible_candidates([candidate])), 1)
        candidate["automation"]["humanGates"] = ["review"]
        self.assertEqual(promotion.eligible_candidates([candidate]), [])

    def test_github_rest_replaces_missing_runner_cli_for_pr_and_ci(self):
        row = {
            "number": 42,
            "html_url": "https://github.com/WindriderQc/AgentX/pull/42",
            "state": "open",
            "head": {"sha": "c" * 40},
            "body": "sealed receipt\n" + promotion.PRE_REVIEW_MARKER,
        }
        with patch.object(promotion, "github_api", return_value=[row]) as api:
            existing = promotion.existing_pr(
                "WindriderQc/AgentX",
                "agentx/coding-task-0599-attempt-1",
                env={"GH_TOKEN": "x" * 20},
            )
        self.assertEqual(existing["headRefOid"], "c" * 40)
        self.assertEqual(existing["state"], "OPEN")
        self.assertIn("head=WindriderQc%3Aagentx%2Fcoding-task-0599-attempt-1", api.call_args.args[1])

        with patch.object(promotion, "github_api", return_value=row) as api:
            created = promotion.create_pr(
                "WindriderQc/AgentX",
                "agentx/coding-task-0599-attempt-1",
                "0599",
                1,
                "b" * 64,
                files_changed=1,
                policy_ref="agentx.reviewed-code/v1",
                env={"GH_TOKEN": "x" * 20},
            )
        self.assertEqual(created["number"], 42)
        self.assertEqual(api.call_args.kwargs["method"], "POST")
        self.assertEqual(api.call_args.kwargs["expected_status"], 201)
        body = api.call_args.kwargs["payload"]["body"]
        self.assertIn("Deployment uses the same AgentX launcher after merge", body)
        self.assertIn(promotion.PRE_REVIEW_MARKER, body)
        self.assertIn("**Summary:**", body)
        self.assertIn("**Tests / evidence:**", body)
        self.assertIn("**Risks:**", body)
        self.assertIn("**Recommendation:** **MERGE**", body)
        self.assertIn("otherwise **CORRECT**", body)
        self.assertIn("cannot approve, merge, deploy, or start another worker", body)

        self.assertEqual(api.call_count, 1)
        self.assertTrue(api.call_args.kwargs["payload"]["draft"])

    def test_worker_snapshot_fingerprint_is_canonical_and_content_bound(self):
        first = promotion.worker_snapshot_fingerprint(
            pipeline_id="0599",
            attempt=1,
            assignee="clawdx-worker",
            base_revision=BASE_REVISION,
            files={"docs/z.md": b"z", "docs/a.md": b"a"},
        )
        reordered = promotion.worker_snapshot_fingerprint(
            pipeline_id="0599",
            attempt=1,
            assignee="clawdx-worker",
            base_revision=BASE_REVISION,
            files={"docs/a.md": b"a", "docs/z.md": b"z"},
        )
        changed = promotion.worker_snapshot_fingerprint(
            pipeline_id="0599",
            attempt=1,
            assignee="clawdx-worker",
            base_revision=BASE_REVISION,
            files={"docs/a.md": b"changed", "docs/z.md": b"z"},
        )
        self.assertEqual(first, reordered)
        self.assertNotEqual(first, changed)

    def test_agentic_pre_review_is_evidence_bound_and_advisory(self):
        review = promotion.build_agentic_pre_review(
            pipeline_id="0599",
            attempt=1,
            fingerprint="b" * 64,
            files_changed=2,
            policy_ref="agentx.reviewed-code/v1",
        )

        self.assertIn(promotion.PRE_REVIEW_MARKER, review)
        self.assertIn("`2` files", review)
        self.assertIn("`" + "b" * 64 + "`", review)
        self.assertIn("independent verifier passed", review)
        self.assertIn("exact-branch PR CI is fully green", review)
        self.assertIn("human", review.lower())

        with self.assertRaisesRegex(promotion.PromotionError, "policy"):
            promotion.build_agentic_pre_review(
                pipeline_id="0599",
                attempt=1,
                fingerprint="b" * 64,
                files_changed=2,
                policy_ref="unreviewed-policy",
            )

    def test_only_done_human_accepted_verified_attempt_is_eligible(self):
        valid = accepted_task()
        unreviewed = accepted_task()
        unreviewed["automationAttempts"][0]["reviewOutcome"] = None
        failed = accepted_task()
        failed["automationAttempts"][0]["evidence"]["verification"]["status"] = "failed"
        unsealed = accepted_task(fingerprint="")
        wrong_status = accepted_task()
        wrong_status["status"] = "review"

        candidates = promotion.eligible_candidates(
            [unreviewed, failed, unsealed, wrong_status, valid]
        )

        self.assertEqual([(task["pipelineId"], attempt["attempt"]) for task, attempt in candidates], [("0599", 1)])

    def test_candidate_snapshot_must_match_scope_metrics_and_sealed_fingerprint(self):
        files = {"docs/result.md": b"hello world\n"}
        fingerprint = promotion.worker_snapshot_fingerprint(
            pipeline_id="0599",
            attempt=1,
            assignee="clawdx-worker",
            base_revision=BASE_REVISION,
            files=files,
        )
        task = accepted_task(fingerprint=fingerprint)
        snapshot = {"files": files, "filesChanged": 1, "bytesChanged": 12}

        self.assertEqual(
            promotion.validate_candidate_snapshot(
                task,
                task["automationAttempts"][0],
                snapshot,
                policy_config(),
                base_revision=BASE_REVISION,
            ),
            fingerprint,
        )

        tampered = {**snapshot, "files": {"docs/result.md": b"tampered\n"}}
        with self.assertRaisesRegex(promotion.PromotionError, "fingerprint"):
            promotion.validate_candidate_snapshot(
                task,
                task["automationAttempts"][0],
                tampered,
                policy_config(),
                base_revision=BASE_REVISION,
            )

        outside = {**snapshot, "files": {"docs/other.md": b"hello world\n"}}
        with self.assertRaisesRegex(promotion.PromotionError, "task scope"):
            promotion.validate_candidate_snapshot(
                task,
                task["automationAttempts"][0],
                outside,
                policy_config(),
                base_revision=BASE_REVISION,
            )

    def test_repository_snapshot_rejects_deletions_and_symlinks(self):
        with tempfile.TemporaryDirectory() as raw:
            repo = Path(raw)
            self.git(repo, "init")
            self.git(repo, "config", "user.name", "test")
            self.git(repo, "config", "user.email", "test@example.invalid")
            (repo / "tracked.txt").write_text("before\n", encoding="utf-8")
            self.git(repo, "add", "tracked.txt")
            self.git(repo, "commit", "-m", "base")
            (repo / "tracked.txt").unlink()
            with self.assertRaisesRegex(promotion.PromotionError, "deletion"):
                promotion.changed_snapshot(repo)

    def test_stash_preserves_exact_accepted_paths_and_cleans_worker(self):
        with tempfile.TemporaryDirectory() as raw:
            repo = Path(raw)
            self.git(repo, "init")
            self.git(repo, "config", "user.name", "test")
            self.git(repo, "config", "user.email", "test@example.invalid")
            (repo / "docs").mkdir()
            (repo / "docs" / "result.md").write_text("before\n", encoding="utf-8")
            self.git(repo, "add", "docs/result.md")
            self.git(repo, "commit", "-m", "base")
            (repo / "docs" / "result.md").write_text("after\n", encoding="utf-8")

            promotion.stash_worker_snapshot(repo, ["docs/result.md"], "0599", 1)

            self.assertEqual(self.git(repo, "status", "--porcelain"), "")
            self.assertIn(
                "accepted-promoted-0599-attempt-1",
                self.git(repo, "stash", "list"),
            )

    def test_commit_publication_uses_exact_snapshot_and_receipt_trailer(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            origin = root / "origin.git"
            repo = root / "worker"
            subprocess.run(["git", "init", "--bare", str(origin)], check=True, stdout=subprocess.PIPE)
            repo.mkdir()
            self.git(repo, "init")
            self.git(repo, "config", "user.name", "test")
            self.git(repo, "config", "user.email", "test@example.invalid")
            (repo / "README.md").write_text("base\n", encoding="utf-8")
            self.git(repo, "add", "README.md")
            self.git(repo, "commit", "-m", "base")
            self.git(repo, "remote", "add", "origin", str(origin))
            base = self.git(repo, "rev-parse", "HEAD")

            sha = promotion.create_commit(
                repo,
                {"docs/result.md": b"accepted\n"},
                branch="agentx/coding-task-0599-attempt-1",
                base_revision=base,
                pipeline_id="0599",
                attempt=1,
                fingerprint="b" * 64,
                env=os.environ,
            )

            self.git(repo, "fetch", "origin", "agentx/coding-task-0599-attempt-1")
            self.assertEqual(self.git(repo, "rev-parse", "FETCH_HEAD"), sha)
            self.assertEqual(
                self.git(repo, "show", "FETCH_HEAD:docs/result.md"),
                "accepted",
            )
            self.assertIn(
                "AgentX-Worker-Receipt: " + "b" * 64,
                self.git(repo, "show", "-s", "--format=%B", "FETCH_HEAD"),
            )

    def test_prepared_receipt_reconciliation_requires_exact_publication(self):
        task = accepted_task()
        attempt = task["automationAttempts"][0]
        receipt = {
            "schema": promotion.PROMOTION_SCHEMA,
            "state": "prepared",
            "pipelineId": "0599",
            "attempt": 1,
            "workerReceiptFingerprint": "b" * 64,
            "branch": "agentx/coding-task-0599-attempt-1",
            "commit": "c" * 40,
            "pullRequest": {"number": 42, "url": "https://github.com/WindriderQc/AgentX/pull/42"},
            "preReview": {"schema": promotion.PRE_REVIEW_SCHEMA},
        }
        pr = {
            "number": 42,
            "url": "https://github.com/WindriderQc/AgentX/pull/42",
            "headRefOid": "c" * 40,
            "body": "receipt " + "b" * 64 + "\n" + promotion.PRE_REVIEW_MARKER,
        }
        with patch.object(promotion, "remote_branch_sha", return_value="c" * 40), patch.object(
            promotion, "existing_pr", return_value=pr
        ), patch.object(promotion, "commit_has_receipt", return_value=True):
            self.assertEqual(
                promotion.validate_prepared_publication(
                    receipt,
                    task,
                    attempt,
                    Path("/worker"),
                    "WindriderQc/AgentX",
                    "agentx/coding-task-0599-attempt-1",
                    env={},
                ),
                pr,
            )

    def test_disabled_promotion_rejects_external_configuration_before_publication(self):
        with self.assertRaisesRegex(promotion.PromotionError, "disabled"):
            promotion.load_config(Path(__file__).resolve().parents[1] / "config.example.json")


    @staticmethod
    def git(repo: Path, *args: str) -> str:
        completed = subprocess.run(
            ["git", "-C", str(repo), *args],
            text=True,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
        return completed.stdout.strip()


if __name__ == "__main__":
    unittest.main()
