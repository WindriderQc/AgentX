import importlib.util
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "qualification_681_v2_labels", Path(__file__).resolve().parents[1] / "qualification_681_v2_labels.py"
)
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class NormalizeLabelsTest(unittest.TestCase):
    def test_trims_whitespace_from_each_label(self):
        self.assertEqual(module.normalize_labels([" Alpha ", "Beta\t", "\nGamma "]), ["Alpha", "Beta", "Gamma"])

    def test_discards_empty_and_blank_strings(self):
        self.assertEqual(module.normalize_labels(["", "   ", "\t", "Alpha", "  "]), ["Alpha"])

    def test_deduplicates_after_trimming_by_case_sensitive_equality(self):
        self.assertEqual(module.normalize_labels(["Alpha", " Alpha ", "ALPHA", "alpha"]), ["Alpha", "ALPHA", "alpha"])

    def test_preserves_order_and_spelling_of_first_occurrence(self):
        self.assertEqual(module.normalize_labels(["  Beta", "beta", " Beta ", "Alpha"]), ["Beta", "beta", "Alpha"])

    def test_returns_empty_list_for_empty_input(self):
        self.assertEqual(module.normalize_labels([]), [])

    def test_returns_empty_list_when_every_entry_is_blank(self):
        self.assertEqual(module.normalize_labels(["", " ", "  \t "]), [])

    def test_does_not_mutate_input(self):
        original = [" Alpha ", "Alpha", "alpha", "", "  ", "Beta", "Beta"]
        snapshot = list(original)
        result = module.normalize_labels(original)
        self.assertEqual(original, snapshot)
        self.assertIsNot(result, original)
        self.assertNotIn(" Alpha ", result)

    def test_task_example(self):
        self.assertEqual(
            module.normalize_labels([" Alpha ", "Alpha", "alpha", "", "  ", "Beta", "Beta"]),
            ["Alpha", "alpha", "Beta"],
        )


class NormalizeLabelsCaseInsensitiveTest(unittest.TestCase):
    def test_case_sensitive_keyword_is_optional_with_same_default_behavior(self):
        # The review's task example, passed via the keyword form, must not
        # change the default case-sensitive result.
        self.assertEqual(
            module.normalize_labels(
                [" Alpha ", "Alpha", "alpha", "", "  ", "Beta", "Beta"], case_sensitive=True
            ),
            ["Alpha", "alpha", "Beta"],
        )

    def test_deduplicates_by_casefold_when_case_insensitive(self):
        self.assertEqual(
            module.normalize_labels(["Alpha", "alpha", "ALPHA", "Beta", "beta"], case_sensitive=False),
            ["Alpha", "Beta"],
        )

    def test_preserves_first_occurrence_order_and_spelling_when_case_insensitive(self):
        self.assertEqual(
            module.normalize_labels([" alpha ", "Alpha", "ALPHA", "Beta"], case_sensitive=False),
            ["alpha", "Beta"],
        )

    def test_unicode_casefold_example(self):
        # str.casefold("Straße") == str.casefold("STRASSE") == "strasse".
        self.assertEqual(
            module.normalize_labels([" Alpha ", "alpha", "Straße", "STRASSE", "Beta"], case_sensitive=False),
            ["Alpha", "Straße", "Beta"],
        )
        # In the default mode the two spellings remain distinct.
        self.assertEqual(
            module.normalize_labels(["Straße", "STRASSE"]),
            ["Straße", "STRASSE"],
        )

    def test_trims_and_discards_blanks_when_case_insensitive(self):
        self.assertEqual(
            module.normalize_labels(["", "  ", " Beta\t", "beta", "\t"], case_sensitive=False),
            ["Beta"],
        )

    def test_empty_input_returns_empty_list_when_case_insensitive(self):
        self.assertEqual(module.normalize_labels([], case_sensitive=False), [])

    def test_does_not_mutate_input_when_case_insensitive(self):
        original = [" Alpha ", "alpha", "Straße", "STRASSE", "Beta"]
        snapshot = list(original)
        result = module.normalize_labels(original, case_sensitive=False)
        self.assertEqual(original, snapshot)
        self.assertIsNot(result, original)
        self.assertNotIn(" alpha ", result)

    def test_case_sensitive_is_keyword_only(self):
        with self.assertRaises(TypeError):
            module.normalize_labels(["Alpha"], False)


if __name__ == "__main__":
    unittest.main()
