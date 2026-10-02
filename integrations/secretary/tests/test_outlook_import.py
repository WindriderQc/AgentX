import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SECRETARY_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SECRETARY_DIR))
SPEC = importlib.util.spec_from_file_location("outlook_import", SECRETARY_DIR / "outlook_import.py")
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)
evidence = sys.modules["secretary_evidence"]


def mail(mid):
    return f"Message-ID: <{mid}@example.invalid>\r\nDate: Mon, 1 Jan 2007 10:00:00 +0000\r\n\r\nSynthetic {mid}\r\n".encode()


ITEMS = {
    "Inbox/1.eml": mail("shared"),
    "Inbox/2.eml": mail("only-outlook"),
    "Sent Items/1.eml": mail("only-outlook"),  # the same item filed twice
    "Contacts/1.vcf": b"BEGIN:VCARD\r\nFN:Synthetic Person\r\nEND:VCARD\r\n",
    "Calendar/1.ics": b"BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
    "Inbox/1-attachment.bin": b"loose",
}


class FakeReadpst:
    """Stands in for readpst: writes the synthetic items under -o."""

    def __init__(self, items=ITEMS, code=0):
        self.items, self.code, self.calls = items, code, []

    def __call__(self, command, capture_output=True):
        self.calls.append(command)
        out = Path(command[command.index("-o") + 1])
        for path, data in self.items.items():
            (out / path).parent.mkdir(parents=True, exist_ok=True)
            (out / path).write_bytes(data)
        return subprocess.CompletedProcess(command, self.code)


class OutlookImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "archive"
        self.pst = Path(self.temp.name) / "export.pst"
        self.pst.write_bytes(b"synthetic pst bytes")
        thread = {"thread": {"messages": [{"id": "message01", "threadId": "thread01", "internalDate": "1", "body": "x",
                                           "headers": {"message-id": "<shared@example.invalid>"},
                                           "payload": {"parts": []}}]}}
        evidence.Archive(self.root, lambda _: thread).collect_thread("thread01")

    def test_keeps_the_pst_and_stores_each_item_once_with_its_folders(self):
        report = module.import_pst(self.root, self.pst, run=FakeReadpst())
        self.assertEqual(report["byKind"], {"mail": 2, "contact": 1, "calendar": 1})
        self.assertEqual((report["stored"], report["duplicatesInExport"], report["other"]), (4, 1, 1))
        kept = list((self.root / "outlook" / "exports").glob("*.pst"))
        self.assertEqual([k.read_bytes() for k in kept], [b"synthetic pst bytes"])
        inventory = json.loads((self.root / "outlook" / "inventory.json").read_text())
        twice = next(i for i in inventory["items"].values() if i.get("messageId") == "<only-outlook@example.invalid>")
        self.assertEqual(sorted(twice["folders"]), ["Inbox", "Sent Items"])
        self.assertEqual((self.root / twice["path"]).read_bytes(), mail("only-outlook"))
        self.assertFalse(list((self.root / "outlook").glob("staging-*")))

    def test_mail_is_linked_to_the_archived_gmail_copy(self):
        report = module.import_pst(self.root, self.pst, run=FakeReadpst())
        self.assertEqual(report["mailAlsoInGmail"], 1)
        inventory = json.loads((self.root / "outlook" / "inventory.json").read_text())
        shared = next(i for i in inventory["items"].values() if i.get("messageId") == "<shared@example.invalid>")
        self.assertEqual(shared["alsoInGmail"], ["message01"])

    def test_reimporting_the_same_export_adds_nothing(self):
        module.import_pst(self.root, self.pst, run=FakeReadpst())
        report = module.import_pst(self.root, self.pst, run=FakeReadpst())
        self.assertEqual((report["stored"], report["alreadyArchived"]), (0, 4))
        self.assertEqual(len(json.loads((self.root / "outlook" / "exports.json").read_text())), 1)

    def test_a_failed_extraction_leaves_no_staging_and_no_partial_inventory(self):
        with self.assertRaises(RuntimeError):
            module.import_pst(self.root, self.pst, run=FakeReadpst(code=1))
        self.assertFalse(list((self.root / "outlook").glob("staging-*")))
        self.assertFalse((self.root / "outlook" / "inventory.json").exists())

    def test_reports_hold_counts_not_content(self):
        module.import_pst(self.root, self.pst, run=FakeReadpst())
        for report in (self.root / "outlook").glob("import-*.json"):
            self.assertNotIn("Synthetic", report.read_text())


if __name__ == "__main__":
    unittest.main()
