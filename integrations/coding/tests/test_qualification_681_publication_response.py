import unittest

from integrations.coding.qualification_681_publication_response import (
    normalize_ticket_ids,
)


class NormalizeTicketIdsTest(unittest.TestCase):
    def test_strips_surrounding_whitespace(self):
        self.assertEqual(
            normalize_ticket_ids(["  ABC-1 ", "ABC-2\t", "\nABC-3"]),
            ("ABC-1", "ABC-2", "ABC-3"),
        )

    def test_discards_empty_and_blank_strings(self):
        self.assertEqual(
            normalize_ticket_ids(["", "   ", "\t", "ABC-1", "  "]),
            ("ABC-1",),
        )

    def test_removes_duplicates_preserving_first_appearance_order(self):
        self.assertEqual(
            normalize_ticket_ids([" ABC-2", "ABC-1", " ABC-2 ", "abc-2"]),
            ("ABC-2", "ABC-1", "abc-2"),
        )

    def test_duplicate_detection_happens_after_trimming(self):
        self.assertEqual(
            normalize_ticket_ids([" ABC-1", "ABC-1", "ABC-1 "]),
            ("ABC-1",),
        )

    def test_does_not_sort(self):
        self.assertEqual(
            normalize_ticket_ids(["Z-9", "A-1", "M-5"]),
            ("Z-9", "A-1", "M-5"),
        )

    def test_accepts_any_iterable(self):
        self.assertEqual(
            normalize_ticket_ids(x for x in ["B-2", " A-1 ", "B-2"]),
            ("B-2", "A-1"),
        )

    def test_empty_iterable_returns_empty_tuple(self):
        self.assertEqual(normalize_ticket_ids([]), ())
        self.assertIsInstance(normalize_ticket_ids([]), tuple)

    def test_rejects_integer_values(self):
        with self.assertRaises(TypeError):
            normalize_ticket_ids(["ABC-1", 681])
        with self.assertRaises(TypeError):
            normalize_ticket_ids(681)

    def test_rejects_none_values(self):
        with self.assertRaises(TypeError):
            normalize_ticket_ids([None])

    def test_result_is_a_tuple(self):
        result = normalize_ticket_ids(["A-1", "B-2"])
        self.assertIsInstance(result, tuple)


if __name__ == "__main__":
    unittest.main()
