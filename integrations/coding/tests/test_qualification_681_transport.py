"""Tests for the qualification #681 restart publication fixture.

Synthetic qualification fixture, not a product feature. Imports the helper as
``integrations.coding.qualification_681_transport``.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from integrations.coding.qualification_681_transport import normalize_ticket_ids


class NormalizeTicketIdsTest(unittest.TestCase):
    def test_strips_surrounding_whitespace(self):
        self.assertEqual(
            normalize_ticket_ids([" T-1 ", "T-2\t", "\nT-3"]),
            ("T-1", "T-2", "T-3"),
        )

    def test_removes_duplicates_preserving_first_appearance(self):
        self.assertEqual(
            normalize_ticket_ids(["A", " B ", "a", "B", " C", "C "]),
            ("A", "B", "a", "C"),
        )

    def test_discards_empty_and_blank_strings(self):
        self.assertEqual(normalize_ticket_ids(["", "   ", "T-1", "\t"]), ("T-1",))

    def test_empty_iterable_returns_empty_tuple(self):
        self.assertEqual(normalize_ticket_ids([]), ())
        self.assertEqual(normalize_ticket_ids(iter([])), ())

    def test_returns_a_tuple(self):
        self.assertIsInstance(normalize_ticket_ids(["T-1"]), tuple)

    def test_rejects_integer_entries(self):
        with self.assertRaises(TypeError):
            normalize_ticket_ids(["T-1", 42])

    def test_rejects_none_entries(self):
        with self.assertRaises(TypeError):
            normalize_ticket_ids([None])

    def test_does_not_sort_or_parse(self):
        self.assertEqual(normalize_ticket_ids(["z", "9", "A"]), ("z", "9", "A"))


if __name__ == "__main__":
    unittest.main()
