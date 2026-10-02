import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from memory_review import schema  # noqa: E402
from memory_review.collectors import git as git_collector  # noqa: E402
from memory_review.watermarks import WatermarkStore  # noqa: E402


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=str(repo), check=True,
        capture_output=True, text=True, encoding="utf-8",
    ).stdout


class GitClaimTest(unittest.TestCase):
    def test_pr_merge_uses_the_accepted_title_from_the_body(self):
        claim = git_collector._claim(
            "Merge pull request #429 from WindriderQc/claude/read-path",
            "fix(agent-memory): restore the shared-memory read path\n\nRouted through Core.",
        )
        self.assertTrue(claim.startswith("fix(agent-memory): restore the shared-memory read path"))
        self.assertNotIn("Merge pull request", claim)

    def test_only_the_first_paragraph_is_kept(self):
        claim = git_collector._claim("subject", "first para\n\nsecond para\n\nthird")
        self.assertEqual(claim, "subject\n\nfirst para")

    def test_generated_trailers_stripped(self):
        claim = git_collector._claim(
            "fix: thing",
            "why it changed\n\nCo-Authored-By: Someone <a@b.c>\nSigned-off-by: X <x@y.z>",
        )
        self.assertNotIn("Co-Authored-By", claim)
        self.assertNotIn("Signed-off-by", claim)

    def test_claim_is_bounded(self):
        claim = git_collector._claim("s", "x" * 5000)
        self.assertLessEqual(len(claim), git_collector.CLAIM_MAX)
        # Stays well under the pasted-content and observation-text limits.
        self.assertLess(len(claim), schema.OBSERVATION_TEXT_MAX)

    def test_noise_is_judged_on_the_extracted_claim(self):
        # The bot title lives in a merge body, so filtering the raw subject
        # would never see it.
        claim = git_collector._claim(
            "Merge pull request #601 from WindriderQc/coding-team",
            "chore(coding-team): promote task 0602 attempt 2",
        )
        self.assertTrue(git_collector._NOISE_SUBJECT.match(claim))
        self.assertFalse(git_collector._NOISE_SUBJECT.match("fix(deploy): stream internal service probe"))


class GitCollectorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.repo = self.root / "demo-repo"
        self.repo.mkdir()
        git(self.repo, "init", "-q", "-b", "main")
        git(self.repo, "config", "user.email", "t@example.com")
        git(self.repo, "config", "user.name", "T")
        self.state = self.root / "state"

    def _commit(self, subject: str, body: str = "") -> str:
        (self.repo / "f.txt").write_text(subject, encoding="utf-8")
        git(self.repo, "add", "-A")
        message = f"{subject}\n\n{body}" if body else subject
        git(self.repo, "commit", "-q", "-m", message)
        return git(self.repo, "rev-parse", "HEAD").strip()

    def _collect(self, store=None):
        store = store or WatermarkStore("git", self.state)
        return store, git_collector.collect(repos=[self.repo], store=store, lookback_days=30)

    def test_accepted_history_becomes_verified_evidence(self):
        self._commit("feat: add the thing", "because the other thing was broken")
        _, result = self._collect()
        self.assertEqual(len(result.observations), 1)
        observation = result.observations[0]
        self.assertEqual(observation.trust, "observed_project_event")
        self.assertIn("feat: add the thing", observation.text)
        self.assertIn("because the other thing was broken", observation.text)
        self.assertEqual(result.rejectionCounts.total(), 0)

    def test_trust_class_is_centrally_accepted(self):
        # The whole point of this lane: the class is already eligible, so no
        # Product change is needed to submit it.
        self.assertIn(git_collector.TRUST, schema.TRUST_ELIGIBLE)

    def test_reports_as_the_agentx_runtime(self):
        self._commit("feat: x")
        _, result = self._collect()
        self.assertEqual(schema.agentx_runtime(result.runtime), "agentx")
        self.assertEqual(result.collector_payload()["runtime"], "agentx")

    def test_bot_bookkeeping_rejected(self):
        self._commit("chore(coding-team): promote task 0602 attempt 2")
        _, result = self._collect()
        self.assertEqual(result.observations, [])
        self.assertEqual(result.rejectionCounts["cron_or_automation"], 1)

    def test_second_run_after_commit_sees_only_new_commits(self):
        self._commit("feat: first")
        store, result = self._collect()
        self.assertEqual(len(result.observations), 1)
        store.commit(result.stagedWatermarks)

        # Nothing new yet.
        store2 = WatermarkStore("git", self.state)
        _, again = self._collect(store2)
        self.assertEqual(again.observations, [])

        # One new accepted commit.
        self._commit("feat: second")
        store3 = WatermarkStore("git", self.state)
        _, third = self._collect(store3)
        self.assertEqual(len(third.observations), 1)
        self.assertIn("feat: second", third.observations[0].text)

    def test_missing_watermark_commit_reports_drift_and_recovers(self):
        self._commit("feat: only")
        store = WatermarkStore("git", self.state)
        store.commit({"demo-repo": {"lastCommit": "0" * 40}})
        _, result = self._collect(WatermarkStore("git", self.state))
        self.assertTrue(any("watermark commit missing" in d for d in result.drift))
        self.assertEqual(len(result.observations), 1)

    def test_unreadable_repository_fails_soft(self):
        store = WatermarkStore("git", self.state)
        result = git_collector.collect(
            repos=[self.root / "not-a-repo"], store=store, lookback_days=30
        )
        self.assertEqual(result.observations, [])
        self.assertTrue(result.errors)
        self.assertEqual(result.sourceFilesSeen, 0)

    def test_secret_bearing_commit_message_is_rejected_not_stored(self):
        self._commit("chore: config", "api_key = abcd1234efgh5678ijkl")
        _, result = self._collect()
        self.assertEqual(result.observations, [])
        self.assertEqual(result.rejectionCounts["secret_like"], 1)

    def test_empty_window_does_not_advance_the_watermark(self):
        store = WatermarkStore("git", self.state)
        result = git_collector.collect(repos=[self.repo], store=store, lookback_days=30)
        # No commits at all: nothing staged, so a later run still starts clean.
        self.assertEqual(result.stagedWatermarks, {})

    def test_unmerged_checkout_branch_is_not_treated_as_accepted_history(self):
        accepted = self._commit("feat: accepted on main")
        git(self.repo, "checkout", "-q", "-b", "feature/private")
        self._commit("feat: not accepted yet")
        store = WatermarkStore("git", self.state)
        result = git_collector.collect(
            repos=[self.repo], store=store, lookback_days=30, accepted_ref="main",
        )
        self.assertEqual([item.eventId for item in result.observations], [accepted])

    def test_large_first_run_backlog_pages_oldest_first_without_loss(self):
        shas = [self._commit(f"feat: event {index}") for index in range(5)]
        with patch.object(schema, "MAX_OBSERVATIONS_PER_COLLECTOR", 3):
            store = WatermarkStore("git", self.state)
            first = git_collector.collect(repos=[self.repo], store=store, lookback_days=30)
            self.assertEqual([item.eventId for item in first.observations], shas[:3])
            self.assertTrue(any("remain queued" in item for item in first.drift))
            store.commit(first.stagedWatermarks)

            second = git_collector.collect(
                repos=[self.repo], store=WatermarkStore("git", self.state), lookback_days=30,
            )
            self.assertEqual([item.eventId for item in second.observations], shas[3:])

    def test_invalid_accepted_ref_fails_closed_instead_of_using_head(self):
        self._commit("feat: exists")
        result = git_collector.collect(
            repos=[self.repo], store=WatermarkStore("git", self.state),
            lookback_days=30, accepted_ref="origin/main",
        )
        self.assertEqual(result.observations, [])
        self.assertTrue(any("accepted ref" in item for item in result.errors))


if __name__ == "__main__":
    unittest.main()
