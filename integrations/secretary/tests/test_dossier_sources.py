import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dossier_sources import read_dossier
from evidence_store import save
from secretary_evidence import Archive


class DossierSourceTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.messages = [
            {"id": "aaaaaaaaaaaaaaa1", "threadId": "bbbbbbbbbbbbbbbb", "internalDate": "1895050800000",
             "headers": {"from": "A <a@example.invalid>", "to": "B <b@example.invalid>", "date": "2030-01-19"},
             "body": "Date confirmée pour le 28.\nOn July 3, 2029 A wrote:\nAncienne demande à un tiers."},
            {"id": "aaaaaaaaaaaaaaa2", "threadId": "bbbbbbbbbbbbbbbb", "internalDate": "1895137200000",
             "labelIds": ["DRAFT"], "headers": {"from": "B <b@example.invalid>", "date": "2030-01-20"},
             "body": "Un brouillon ne prouve ni envoi ni accord."}
        ]
        self.commands = []
        def provider(command):
            self.commands.append(command)
            if command[:3] != ["gmail", "thread", "get"]:
                raise AssertionError("Only a native thread read is permitted")
            return {"thread": {"messages": self.messages}}
        self.archive = Archive(self.root, run=provider)

    def test_latest_first_drafts_and_quotes_keep_separate_attribution(self):
        read = read_dossier(self.archive, "bbbbbbbbbbbbbbbb")
        self.assertTrue(read["complete"])
        self.assertEqual(read["sources"][0]["direction"], "draft")
        authored = next(source for source in read["sources"] if source["messageId"] == self.messages[0]["id"] and source["relation"] == "authored")
        quoted = next(source for source in read["sources"] if source["relation"] == "quoted")
        self.assertIn("Date confirmée", authored["text"])
        self.assertIsNotNone(authored["date"])
        self.assertIsNone(quoted["date"])
        self.assertIsNone(quoted["from"])
        self.assertEqual(len(self.commands), 1)
        self.assertNotIn("originalPath", read)

    def test_attachments_are_missing_until_a_matching_preserved_extraction_is_read(self):
        part = {"partId": "1", "filename": "pieces.txt", "mimeType": "text/plain", "body": {"attachmentId": "attachment-one", "size": 10}}
        self.messages[0]["payload"] = {"parts": [part]}
        first = read_dossier(self.archive, "bbbbbbbbbbbbbbbb")
        self.assertFalse(first["documentsComplete"])
        self.assertEqual(first["documents"][0]["state"], "not_read")
        raw = self.root / "files/pieces.txt"
        raw.parent.mkdir()
        raw.write_bytes(b"Pieces recues")
        extracted = self.root / "files/pieces.txt.txt"
        extracted.write_text("Les pièces sont reçues.")
        # parts() also yields the root part; the attached part is number 1.
        save(self.root / "download-receipts/aaaaaaaaaaaaaaa1-1.json", {
            "sourceHash": hashlib.sha256(json.dumps(part, sort_keys=True).encode()).hexdigest(),
            "attachment": {"filename": "pieces.txt", "status": "text_extracted", "bytes": raw.stat().st_size,
                           "sha256": hashlib.sha256(raw.read_bytes()).hexdigest(),
                           "path": "files/pieces.txt", "textPath": "files/pieces.txt.txt"}})
        read = read_dossier(self.archive, "bbbbbbbbbbbbbbbb")
        self.assertTrue(read["documentsComplete"])
        self.assertEqual(read["documents"][0]["state"], "read")
        document = next(source for source in read["sources"] if source["kind"] == "document")
        self.assertEqual(document["text"], "Les pièces sont reçues.")
        self.assertEqual(document["dateType"], "containing_message_not_document_date")
        raw.write_bytes(b"Damaged original")
        corrupt = read_dossier(self.archive, "bbbbbbbbbbbbbbbb")
        self.assertFalse(corrupt["documentsComplete"])
        self.assertEqual(corrupt["documents"][0]["state"], "integrity_failed")

    def test_a_bounded_read_is_explicitly_incomplete_and_never_invokes_extraction(self):
        self.messages[1]["body"] = "x" * 70000
        read = read_dossier(self.archive, "bbbbbbbbbbbbbbbb")
        self.assertFalse(read["complete"])
        self.assertLessEqual(sum(len(source["text"]) for source in read["sources"]), 60000)
        self.assertTrue(any(source["truncated"] for source in read["sources"]))
        self.assertEqual(len(self.commands), 1)


if __name__ == "__main__":
    unittest.main()
