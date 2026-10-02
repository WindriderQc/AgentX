import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "clawdx-contract-matrix.py"
SPEC = importlib.util.spec_from_file_location("clawdx_contract_matrix", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class DefaultModelTests(unittest.TestCase):
    def test_default_matrix_uses_only_the_configured_primary(self):
        self.assertEqual(MODULE.DEFAULT_MODELS, [("configured-primary", None)])


class DoneScannerTests(unittest.TestCase):
    def test_accepts_affirmative_completion(self):
        self.assertTrue(MODULE._done("All set. DONE."))
        self.assertTrue(MODULE._done("Task complete."))

    def test_rejects_negated_done_mentions(self):
        self.assertFalse(MODULE._done("This is not done yet."))
        self.assertFalse(MODULE._done("That cannot be done."))
        self.assertFalse(
            MODULE._done(
                "I cannot complete Step 2 or reply DONE because the verifier is absent."
            )
        )
        self.assertFalse(
            MODULE._done("Verification is incomplete, so I am withholding DONE.")
        )
        self.assertFalse(
            MODULE._done(
                "I've completed an exhaustive search; the verifier is absent."
            )
        )


class ExactDoneTests(unittest.TestCase):
    def test_accepts_exact_done_with_outer_whitespace(self):
        for text in ("DONE", "  DONE  ", "\nDONE\n"):
            with self.subTest(text=text):
                result = MODULE.check_exact_done(text)
                self.assertTrue(result["exact_done"])
                self.assertEqual(result["final_text_stripped"], "DONE")

    def test_rejects_non_exact_done(self):
        values = (
            None,
            "",
            "done",
            "DONE!",
            "**DONE**",
            "All files written. DONE",
            "DONE\nAll files verified.",
            "```\nDONE\n```",
        )
        for text in values:
            with self.subTest(text=text):
                self.assertFalse(MODULE.check_exact_done(text)["exact_done"])

    def test_preserves_stripped_text_for_diagnostics(self):
        result = MODULE.check_exact_done("  Some prose. DONE  ")
        self.assertEqual(result["final_text_stripped"], "Some prose. DONE")


class RemoteScriptExactDoneGateTests(unittest.TestCase):
    def test_all_four_lanes_call_done_check(self):
        self.assertGreaterEqual(
            MODULE.REMOTE_SCRIPT.count(
                '_done = done_check(result.get("final_text"))'
            ),
            4,
        )

    def test_all_four_lane_passes_require_exact_done(self):
        required = (
            '"pass": read_text(write_path) == expected_write and _done["exact_done"]',
            '"pass": content in {expected_edit, f"{expected_edit}\\n"} and _done["exact_done"]',
            '"pass": content in {expected_exec, f"{expected_exec}\\n"} and _done["exact_done"]',
            'all([assignment_ok, artifact_ok, feedback_ok, _done["exact_done"]])',
        )
        for snippet in required:
            with self.subTest(snippet=snippet):
                self.assertIn(snippet, MODULE.REMOTE_SCRIPT)

    def test_saved_results_and_summary_expose_exact_done(self):
        self.assertIn('"exact_done": _done', MODULE.REMOTE_SCRIPT)
        self.assertIn(
            '"exact_done": done_info.get("exact_done")', MODULE.REMOTE_SCRIPT
        )


class FinalSentinelOrderingTests(unittest.TestCase):
    def test_final_sentinel_follows_all_task_instructions(self):
        instruction = (
            "Reply DONE only after the assignment, artifact, and feedback file "
            "exist and match the task."
        )
        sentinel = "FINAL MACHINE RESPONSE CONTRACT"
        self.assertGreater(MODULE.REMOTE_SCRIPT.find(instruction), -1)
        self.assertGreater(
            MODULE.REMOTE_SCRIPT.find(sentinel),
            MODULE.REMOTE_SCRIPT.find(instruction),
        )

    def test_final_sentinel_states_exact_contract(self):
        required = (
            "four ASCII characters DONE",
            "No prose, summary, prefix, suffix, or Markdown before or after DONE",
            "Explanatory prose followed by DONE is a failure",
            "DONE followed by additional text is a failure",
        )
        for snippet in required:
            with self.subTest(snippet=snippet):
                self.assertIn(snippet, MODULE.REMOTE_SCRIPT)

    def test_scratch_task_file_repeats_terminal_contract(self):
        task_file_marker = "## Final Machine Response"
        self.assertIn(task_file_marker, MODULE.REMOTE_SCRIPT)
        self.assertIn(
            "After the last successful tool result, do not explain or summarize",
            MODULE.REMOTE_SCRIPT,
        )
        self.assertIn("Discard any draft report", MODULE.REMOTE_SCRIPT)

    def test_user_message_discards_draft_verification_report(self):
        self.assertIn(
            "After the last tool result, discard any draft verification report "
            "and send only DONE.",
            MODULE.REMOTE_SCRIPT,
        )


if __name__ == "__main__":
    unittest.main()
