import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest


SECRETARY_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SECRETARY_DIR))
SPEC = importlib.util.spec_from_file_location("household_documents", SECRETARY_DIR / "household_documents.py")
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class HouseholdDocumentDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "files").mkdir()
        (self.root / "threads" / "thread0001").mkdir(parents=True)
        self.rows = []

    def attachment(self, *, text=b"Synthetic family schedule", filename="document.pdf",
                   subject="Message", body="", status="text_extracted", message_id="message01"):
        digest = hashlib.sha256(text).hexdigest()
        file = self.root / "files" / (digest + ".pdf")
        file.write_bytes(text)
        (self.root / "files" / (digest + ".pdf.txt")).write_text(text.decode())
        original = self.root / "threads" / "thread0001" / "original.json"
        payload = json.loads(original.read_text()) if original.exists() else {"thread": {"messages": []}}
        payload["thread"]["messages"].append({"id": message_id, "body": body})
        original.write_text(json.dumps(payload))
        self.rows.append({
            "sha256": digest, "path": "files/" + file.name,
            "textPath": "files/" + file.name + ".txt", "status": status,
            "filename": filename, "threadId": "thread0001", "messageId": message_id,
            "gmailUrl": "https://mail.google.com/mail/#all/thread0001",
            "headers": {"subject": subject, "date": "Wed, 30 Sep 2026 12:00:00 -0400"}
        })
        return digest

    def save(self):
        (self.root / "attachment-register.json").write_text(json.dumps(self.rows))

    def test_generic_filename_is_found_through_the_matching_message_body(self):
        digest = self.attachment(body="Voici le calendrier de l'école.")
        self.save()
        result = module.candidate_rows(self.root)
        self.assertEqual(result["candidateCount"], 1)
        self.assertEqual(result["candidates"][0]["sha256"], digest)
        self.assertEqual(result["candidates"][0]["sources"][0]["receivedAt"], "2026-09-30T16:00:00+00:00")
        self.assertEqual(result["archiveCoverage"], "partial_or_unknown")

    def test_identical_bytes_are_one_candidate_with_two_sources(self):
        self.attachment(filename="Hockey.pdf", message_id="message01")
        self.attachment(filename="Hockey.pdf", message_id="message02")
        self.save()
        result = module.candidate_rows(self.root)
        self.assertEqual(result["candidateCount"], 1)
        self.assertEqual(len(result["candidates"][0]["sources"]), 2)

    def test_medical_attachment_in_school_message_is_flagged_and_ranked_last(self):
        self.attachment(text=b"Family school calendar", filename="Calendrier école.pdf", message_id="message01")
        self.attachment(text=b"Synthetic bill", filename="Dentiste enfant.pdf",
                        subject="École: documents joints", message_id="message02")
        self.save()
        found = module.candidate_rows(self.root)["candidates"]
        self.assertEqual(found[0]["filename"], "Calendrier école.pdf")
        self.assertTrue(found[0]["highSignal"])
        self.assertEqual(found[1]["reviewFlags"], ["sensitive_source"])

    def test_old_unread_and_unsafe_paths_are_not_silent_approvals(self):
        digest = self.attachment(filename="Karaté.pdf", status="needs_visual_review")
        self.rows.append({**self.rows[0], "path": "files/../../outside.pdf", "sha256": "a" * 64})
        self.save()
        self.assertEqual(module.candidate_rows(self.root)["candidateCount"], 0)
        self.assertEqual(module.candidate_rows(self.root, include_unread=True)["candidates"][0]["sha256"], digest)
        self.assertEqual(module.candidate_rows(self.root, since="2027-01-01", include_unread=True)["candidateCount"], 0)

    def test_invalid_date_and_unavailable_register_fail_closed(self):
        self.save()
        with self.assertRaisesRegex(ValueError, "YYYY-MM-DD"):
            module.candidate_rows(self.root, since="next week")
        (self.root / "attachment-register.json").unlink()
        with self.assertRaisesRegex(ValueError, "unavailable"):
            module.candidate_rows(self.root)

    def test_seasonal_documents_are_marked_for_expiry_review(self):
        self.attachment(filename="Messager Septembre-Octobre 2026.pdf", subject="École")
        self.save()
        candidate = module.candidate_rows(self.root)["candidates"][0]
        self.assertTrue(candidate["possibleExpiry"])


if __name__ == "__main__":
    unittest.main()
