import importlib.util
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "qualification_681_v2_ticket_order",
    Path(__file__).resolve().parents[1] / "qualification_681_v2_ticket_order.py",
)
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


def make_record(id_, state="queued", authorized=True, risk="low",
                dependencies_done=True, priority=1):
    return {
        "id": id_,
        "state": state,
        "authorized": authorized,
        "risk": risk,
        "dependenciesDone": dependencies_done,
        "priority": priority,
    }


class ReadyTicketOrderTest(unittest.TestCase):
    def test_empty_input_returns_empty_list(self):
        self.assertEqual(module.ready_ticket_ids([]), [])

    def test_selects_single_ready_record(self):
        records = [make_record("t-1")]
        self.assertEqual(module.ready_ticket_ids(records), ["t-1"])

    def test_excludes_record_not_queued(self):
        records = [make_record("t-1", state="in_progress"), make_record("t-2")]
        self.assertEqual(module.ready_ticket_ids(records), ["t-2"])

    def test_excludes_record_not_authorized(self):
        records = [make_record("t-1", authorized=False), make_record("t-2")]
        self.assertEqual(module.ready_ticket_ids(records), ["t-2"])

    def test_excludes_record_not_low_risk(self):
        records = [make_record("t-1", risk="high"), make_record("t-2", risk="medium")]
        self.assertEqual(module.ready_ticket_ids(records), [])

    def test_excludes_record_with_open_dependencies(self):
        records = [make_record("t-1", dependencies_done=False), make_record("t-2")]
        self.assertEqual(module.ready_ticket_ids(records), ["t-2"])

    def test_excludes_falsy_authorization_that_is_not_true(self):
        # Truthy non-boolean values must not count as authorized.
        records = [make_record("t-1", authorized=1), make_record("t-2")]
        self.assertEqual(module.ready_ticket_ids(records), ["t-2"])

    def test_orders_by_increasing_priority_then_id(self):
        records = [
            make_record("b", priority=2),
            make_record("d", priority=1),
            make_record("c", priority=2),
            make_record("a", priority=5),
        ]
        self.assertEqual(module.ready_ticket_ids(records), ["d", "b", "c", "a"])

    def test_stable_tie_ordering_is_lexicographic_id(self):
        # Same priority: lexicographic id order, independent of input order.
        records = [
            make_record("z-10", priority=3),
            make_record("z-2", priority=3),
            make_record("a-1", priority=3),
            make_record("a-0", priority=3),
        ]
        self.assertEqual(module.ready_ticket_ids(records), ["a-0", "a-1", "z-10", "z-2"])

    def test_does_not_mutate_records_or_input(self):
        records = [
            make_record("b", priority=2),
            make_record("a", priority=1),
            make_record("skipped", state="blocked"),
        ]
        snapshot = [dict(record) for record in records]
        order_snapshot = [record["id"] for record in records]
        self.assertEqual(module.ready_ticket_ids(records), ["a", "b"])
        self.assertEqual(records, snapshot)
        self.assertEqual([record["id"] for record in records], order_snapshot)


if __name__ == "__main__":
    unittest.main()
