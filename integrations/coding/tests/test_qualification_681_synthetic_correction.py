import unittest

from integrations.coding.qualification_681_synthetic_correction import normalize_ticket_ids


class NormalizeTicketIdsTest(unittest.TestCase):
    def test_strips_surrounding_whitespace(self):
        self.assertEqual(
            normalize_ticket_ids(["  W-681 ", "\tW-682\n", "W-683"]),
            ("W-681", "W-682", "W-683"),
        )

    def test_removes_duplicates_preserving_first_appearance(self):
        self.assertEqual(
            normalize_ticket_ids([" W-1 ", "W-2", "  W-1 ", "W-2 ", "W-3"]),
            ("W-1", "W-2", "W-3"),
        )

    def test_duplicates_are_matched_after_trimming(self):
        self.assertEqual(
            normalize_ticket_ids(["W-1", " W-1 "]),
            ("W-1",),
        )

    def test_discards_empty_and_blank_strings(self):
        self.assertEqual(
            normalize_ticket_ids(["", "   ", "\t", "W-1", "  "]),
            ("W-1",),
        )

    def test_empty_iterable_returns_empty_tuple(self):
        self.assertEqual(normalize_ticket_ids([]), ())
        self.assertEqual(normalize_ticket_ids(iter(())), ())

    def test_returns_a_tuple_without_sorting(self):
        result = normalize_ticket_ids(["W-3", "w-2", "W-1"])
        self.assertIsInstance(result, tuple)
        self.assertEqual(result, ("W-3", "w-2", "W-1"))

    def test_does_not_parse_integers_in_strings(self):
        self.assertEqual(normalize_ticket_ids(["007", "7"]), ("007", "7"))

    def test_rejects_integer_values(self):
        with self.assertRaises(TypeError):
            normalize_ticket_ids(["W-1", 681])
        with self.assertRaises(TypeError):
            normalize_ticket_ids([42])

    def test_rejects_none_values(self):
        with self.assertRaises(TypeError):
            normalize_ticket_ids(["W-1", None])
        with self.assertRaises(TypeError):
            normalize_ticket_ids([None])

    def test_does_not_mutate_or_materialize_generator_input(self):
        def values():
            yield " W-1 "
            yield "W-1"
            yield ""
            yield " W-2 "

        self.assertEqual(normalize_ticket_ids(values()), ("W-1", "W-2"))


class NormalizeTicketIdsCaseInsensitiveTest(unittest.TestCase):
    def test_default_keeps_uppercase_and_lowercase_distinct(self):
        self.assertEqual(normalize_ticket_ids(["A", "a"]), ("A", "a"))

    def test_case_insensitive_deduplicates_by_casefold(self):
        self.assertEqual(
            normalize_ticket_ids(["A", "a", "A"], case_insensitive=True),
            ("A",),
        )

    def test_case_insensitive_preserves_first_occurrence_spelling_and_order(self):
        self.assertEqual(
            normalize_ticket_ids(
                ["W-1", "w-1", " W-2 ", "w-2", "W-3"], case_insensitive=True
            ),
            ("W-1", "W-2", "W-3"),
        )

    def test_case_insensitive_collapses_german_sharp_s_and_ssd(self):
        self.assertEqual(
            normalize_ticket_ids(
                ["Straße", "STRASSE", "strasse"], case_insensitive=True
            ),
            ("Straße",),
        )

    def test_case_insensitive_accepts_generator_input(self):
        def values():
            yield "  a "
            yield "A"
            yield "b"
            yield " B "

        self.assertEqual(
            normalize_ticket_ids(values(), case_insensitive=True),
            ("a", "b"),
        )

    def test_rejects_non_bool_case_insensitive_flag(self):
        for flag in ("true", 0, 1, "A", ["A"], {"flag": True}):
            with self.assertRaises(TypeError):
                normalize_ticket_ids(["A"], case_insensitive=flag)
        with self.assertRaises(TypeError):
            normalize_ticket_ids(["A"], case_insensitive=None)


if __name__ == "__main__":
    unittest.main()
