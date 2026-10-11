import copy
import importlib.util
import unittest
from pathlib import Path


SPEC = importlib.util.spec_from_file_location(
    "qualification_681_v2_stop_probe",
    Path(__file__).resolve().parents[1] / "qualification_681_v2_stop_probe.py",
)
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class GroupTicketIdsTest(unittest.TestCase):
    def test_groups_multiple_states_in_input_order(self):
        records = [
            {"id": "t-1", "state": "open"},
            {"id": "t-2", "state": "blocked"},
            {"id": "t-3", "state": "open"},
            {"id": "t-4", "state": "closed"},
            {"id": "t-5", "state": "blocked"},
        ]
        self.assertEqual(
            module.group_ticket_ids(records),
            {"open": ["t-1", "t-3"], "blocked": ["t-2", "t-5"], "closed": ["t-4"]},
        )

    def test_empty_input_returns_empty_dict(self):
        self.assertEqual(module.group_ticket_ids([]), {})

    def test_duplicate_ids_are_preserved(self):
        records = [
            {"id": "t-1", "state": "open"},
            {"id": "t-1", "state": "open"},
            {"id": "t-2", "state": "open"},
            {"id": "t-1", "state": "closed"},
        ]
        self.assertEqual(
            module.group_ticket_ids(records),
            {"open": ["t-1", "t-1", "t-2"], "closed": ["t-1"]},
        )

    def test_input_is_not_mutated(self):
        records = [
            {"id": "t-1", "state": "open"},
            {"id": "t-2", "state": "blocked"},
            {"id": "t-1", "state": "open"},
        ]
        snapshot = copy.deepcopy(records)
        module.group_ticket_ids(records)
        self.assertEqual(records, snapshot)

    def test_result_is_a_new_dict_not_aliased_with_input(self):
        records = [{"id": "t-1", "state": "open"}, {"id": "t-2", "state": "open"}]
        first = module.group_ticket_ids(records)
        second = module.group_ticket_ids(records)
        self.assertIsNot(first, second)
        self.assertIsNot(first["open"], second["open"])
        first["open"].append("t-99")
        self.assertNotIn("t-99", second["open"])
        self.assertEqual(records[0], {"id": "t-1", "state": "open"})

    def test_single_state_and_single_record(self):
        self.assertEqual(
            module.group_ticket_ids([{"id": "only", "state": "open"}]),
            {"open": ["only"]},
        )


if __name__ == "__main__":
    unittest.main()
