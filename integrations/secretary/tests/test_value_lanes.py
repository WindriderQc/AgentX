from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from evidence_store import load, save
from value_lanes import LANES_NAME, label, lanes_of

OWNER = "Owner Example <owner@example.test>"


def message(mid, sender, to=OWNER, **headers):
    return {"id": mid, "internalDate": "1735732800000", "headers": {"from": sender, "to": to, **headers}}


class ValueLaneTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        threads = {
            "t-sent": [(message("sent", OWNER, to="Friend <friend@example.test>"), ["SENT"])],
            "t-friend": [(message("friend", "Friend <friend@example.test>"), ["INBOX", "CATEGORY_PERSONAL"])],
            "t-contact": [(message("contact", "Relative <relative@example.test>"), ["INBOX"])],
            "t-invoice": [(message("invoice", "Billing <billing@shop.example>"), ["CATEGORY_UPDATES"])],
            "t-gov": [(message("gov", "Agency <agent@revenu.gouv.qc.ca>", **{"list-unsubscribe": "<x>"}), ["INBOX"])],
            "t-bank": [(message("bank", "Bank <alerts@bank.example>"), ["CATEGORY_UPDATES"])],
            "t-news": [(message("news", "Store <hello@store.example>", **{"list-unsubscribe": "<x>"}), ["CATEGORY_UPDATES"])],
            "t-promo": [(message("promo", "Brand <deals@brand.example>"), ["CATEGORY_PROMOTIONS"])],
            "t-robot": [(message("robot", "Service <no-reply@service.example>"), ["INBOX"])],
            "t-update": [(message("update", "School <portal@school.example>"), ["CATEGORY_UPDATES"])],
            "t-stranger": [(message("stranger", "New Person <new.person@example.test>"), ["INBOX"])],
        }
        manifests = []
        for tid, rows in threads.items():
            manifests.append({"threadId": tid, "messages": [m for m, _ in rows]})
            save(self.root / "threads" / tid / "original.json",
                 {"thread": {"messages": [{"id": m["id"], "labelIds": labels} for m, labels in rows]}})
        save(self.root / "inventory-contact.json", {"messages": {"contact": {"threadId": "t-contact"}}})
        save(self.root / "inventory-invoices.json", {"messages": {"invoice": {"threadId": "t-invoice"}}})
        self.archive = SimpleNamespace(root=self.root, manifests=lambda: manifests)

    def test_each_rule_labels_the_expected_lane(self):
        report = label(self.archive, important_domains=["bank.example"])
        got = {mid: (row["lane"], row["reason"]) for mid, row in report["messages"].items()}
        self.assertEqual(got, {
            "sent": ("person", "owner-wrote"), "friend": ("person", "correspondent"),
            "contact": ("person", "contact"), "invoice": ("important", "invoice"),
            "gov": ("important", "institution"), "bank": ("important", "institution"),
            "news": ("bulk", "bulk-mail"), "promo": ("bulk", "bulk-mail"),
            "robot": ("bulk", "automated"), "update": ("important", "update"),
            "stranger": ("person", "direct")})

    def test_saves_labels_privately_and_reports_counts_only(self):
        report = label(self.archive)
        saved = load(self.root / LANES_NAME)
        self.assertEqual(saved["schema"], "agentx.secretary-value-lanes/v1")
        self.assertEqual(lanes_of(self.root)["bank"], "important")  # Updates without a list header
        self.assertEqual(sum(sum(c.values()) for c in report["counts"].values()), 11)
        self.assertNotIn("friend@example.test", str(report["counts"]))

    def test_never_labelled_archive_has_no_lanes(self):
        self.assertEqual(lanes_of(self.root / "missing"), {})


if __name__ == "__main__":
    unittest.main()
