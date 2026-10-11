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


if __name__ == "__main__":
    unittest.main()
