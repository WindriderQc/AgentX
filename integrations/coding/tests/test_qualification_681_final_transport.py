"""Unit tests for the qualification 681 final-transport fixture helper."""

import unittest

from integrations.coding.qualification_681_final_transport import normalize_ticket_ids


class NormalizeTicketIdsTest(unittest.TestCase):
    def test_strips_surrounding_whitespace(self):
        self.assertEqual(
            normalize_ticket_ids(["  T-1 ", "\tT-2", "T-3\n", " T-4\t"]),
            ("T-1", "T-2", "T-3", "T-4"),
        )

    def test_discards_empty_and_blank_strings(self):
        self.assertEqual(normalize_ticket_ids(["", "   ", "\t\n", "T-1", "  "]), ("T-1",))

    def test_deduplicates_preserving_first_appearance_order(self):
        self.assertEqual(
            normalize_ticket_ids(["T-1", " T-2", "T-1", "T-3 ", " T-2 "]),
            ("T-1", "T-2", "T-3"),
        )

    def test_keeps_distinct_values_without_sorting_or_parsing(self):
        self.assertEqual(normalize_ticket_ids(["2", "10", "1"]), ("2", "10", "1"))

    def test_empty_iterable_returns_empty_tuple(self):
        self.assertEqual(normalize_ticket_ids([]), ())
        self.assertEqual(normalize_ticket_ids(iter([])), ())
        self.assertEqual(normalize_ticket_ids(()), ())

    def test_accepts_any_string_iterable(self):
        self.assertEqual(normalize_ticket_ids(iter(["T-1", " T-2 "])), ("T-1", "T-2"))

    def test_rejects_integer_values(self):
        with self.assertRaises(TypeError):
            normalize_ticket_ids(["T-1", 42])
        with self.assertRaises(TypeError):
            normalize_ticket_ids([7])

    def test_rejects_none_values(self):
        with self.assertRaises(TypeError):
            normalize_ticket_ids(["T-1", None])
        with self.assertRaises(TypeError):
            normalize_ticket_ids([None])

    def test_return_type_is_tuple(self):
        self.assertIsInstance(normalize_ticket_ids(["T-1"]), tuple)


if __name__ == "__main__":
    unittest.main()
