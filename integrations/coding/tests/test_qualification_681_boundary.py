import unittest

from integrations.coding.qualification_681_boundary import normalize_ticket_ids


class NormalizeTicketIdsTest(unittest.TestCase):
    def test_strips_surrounding_whitespace(self):
        self.assertEqual(
            normalize_ticket_ids(["  ABC-1 ", "ABC-2\t", "\nABC-3"]),
            ("ABC-1", "ABC-2", "ABC-3"),
        )

    def test_discards_empty_and_blank_strings(self):
        self.assertEqual(normalize_ticket_ids(["", "   ", "\t", "ABC-1", "  "]), ("ABC-1",))

    def test_removes_duplicates_preserving_first_appearance(self):
        self.assertEqual(normalize_ticket_ids(["ABC-1", " ABC-1 ", "ABC-2", "ABC-1"]), ("ABC-1", "ABC-2"))

    def test_preserves_first_occurrence_order_without_sorting(self):
        self.assertEqual(normalize_ticket_ids(["BBB", "aaa", "CCC", "aaa"]), ("BBB", "aaa", "CCC"))

    def test_returns_tuple(self):
        self.assertIsInstance(normalize_ticket_ids(["ABC-1"]), tuple)

    def test_accepts_any_iterable_of_strings(self):
        self.assertEqual(normalize_ticket_ids(iter([" ABC-1 ", "ABC-2"])), ("ABC-1", "ABC-2"))

    def test_empty_iterable_returns_empty_tuple(self):
        self.assertEqual(normalize_ticket_ids(()), ())
        self.assertEqual(normalize_ticket_ids(iter([])), ())

    def test_rejects_integer_values(self):
        with self.assertRaises(TypeError):
            normalize_ticket_ids(["ABC-1", 681])
        with self.assertRaises(TypeError):
            normalize_ticket_ids([681])

    def test_rejects_none_values(self):
        with self.assertRaises(TypeError):
            normalize_ticket_ids(["ABC-1", None])
        with self.assertRaises(TypeError):
            normalize_ticket_ids([None])

    def test_does_not_parse_integer_strings(self):
        # "123" is a plain string, kept verbatim; no coercion either way.
        self.assertEqual(normalize_ticket_ids(["123", " 123 ", "124"]), ("123", "124"))


if __name__ == "__main__":
    unittest.main()
