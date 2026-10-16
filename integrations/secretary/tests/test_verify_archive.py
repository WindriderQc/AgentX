import base64
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest import mock


SECRETARY_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SECRETARY_DIR))


def load_module(name):
    spec = importlib.util.spec_from_file_location(name, SECRETARY_DIR / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


module = load_module("verify_archive")
raw_messages = load_module("raw_messages")
evidence = sys.modules["secretary_evidence"]
backfill = sys.modules["mailbox_backfill"]

ATTACHMENT = b"synthetic binary attachment"


def rfc822(mid):
    return ("Message-ID: <%s@example.invalid>\r\nSubject: Synthetic\r\nMIME-Version: 1.0\r\n"
            "Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n"
            "Synthetic body\r\n--b\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=a.bin\r\n"
            "Content-Transfer-Encoding: base64\r\n\r\n%s\r\n--b--\r\n" % (mid, base64.b64encode(ATTACHMENT).decode())).encode()


def provider(command):
    if command[:3] == ["gmail", "thread", "get"]:
        return {"thread": {"messages": [{
            "id": f"message{n}", "threadId": command[3], "internalDate": str(n), "body": "x",
            "headers": {"message-id": f"<message{n}@example.invalid>"},
            "payload": {"parts": [{"partId": "1", "filename": "a.bin", "mimeType": "application/octet-stream",
                                   "body": {"data": base64.urlsafe_b64encode(ATTACHMENT).decode()}}]}}
            for n in (1, 2)]}}
    mid = command[2]
    data = rfc822(mid)
    return {"message": {"id": mid, "raw": base64.urlsafe_b64encode(data).decode(), "sizeEstimate": len(data)}}


class VerifyArchiveTests(unittest.TestCase):
    def setUp(self):
        queries = mock.patch.dict(evidence.QUERIES, {"mailbox": "in:anywhere"}, clear=True)
        queries.start()
        self.addCleanup(queries.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "live"
        archive = evidence.Archive(self.root, provider)
        archive.collect_thread("thread01")
        archive.run = backfill.Pacer(provider, min_interval=0, sleep=lambda _: None)
        lock = backfill.Lock(self.root, raw_messages.LOCK_NAME)
        lock.acquire()
        raw_messages.sync(archive, lock)
        lock.release()
        item = self.root / "outlook" / "items" / "ab" / ("ab" * 32 + ".eml")
        item.parent.mkdir(parents=True)
        item.write_bytes(rfc822("outlook-only"))
        digest = module.sha_file(item)
        item.rename(item.with_name(digest + ".eml"))
        evidence.save(self.root / "outlook" / "inventory.json", {"items": {digest: {
            "sha256": digest, "kind": "mail", "bytes": item.with_name(digest + ".eml").stat().st_size,
            "path": f"outlook/items/ab/{digest}.eml"}}})
        self.copy = Path(self.temp.name) / "copy"
        shutil.copytree(self.root, self.copy)

    def test_an_intact_copy_verifies_every_recorded_file(self):
        report, receipts = module.verify(self.copy)
        self.assertTrue(report["intact"])
        self.assertEqual((report["raw"]["verified"], report["raw"]["withoutOriginal"]), (2, 0))
        self.assertEqual(report["attachments"]["verified"], 2)
        self.assertEqual(report["outlookItems"]["verified"], 1)
        self.assertEqual(len(receipts), 2)

    def test_damaged_and_missing_files_are_reported_by_id(self):
        receipt = json.loads((self.copy / "raw-receipts" / "message1.json").read_text())
        (self.copy / receipt["path"]).write_bytes(b"X" * receipt["bytes"])
        attachment = next((self.copy / "files").glob("*.bin"))
        attachment.unlink()
        report, _ = module.verify(self.copy)
        self.assertFalse(report["intact"])
        self.assertEqual(report["raw"]["mismatchedIds"], ["message1"])
        self.assertEqual(report["attachments"]["missing"], 2)  # both messages point at the same original

    def test_an_original_whose_message_id_differs_is_not_verified(self):
        receipt = json.loads((self.copy / "raw-receipts" / "message2.json").read_text())
        other = rfc822("someone-else")
        (self.copy / receipt["path"]).write_bytes(other)
        receipt.update(bytes=len(other), sha256=module.sha_file(self.copy / receipt["path"]))
        (self.copy / "raw-receipts" / "message2.json").write_text(json.dumps(receipt))
        report, _ = module.verify(self.copy)
        self.assertEqual(report["raw"]["mismatchedIds"], ["message2"])

    def test_restored_sample_opens_like_a_mail_client_and_leaves_nothing_behind(self):
        report, receipts = module.verify(self.copy)
        before = set(Path(tempfile.gettempdir()).glob("archive-restore-*"))
        sample = module.restore_sample(self.copy, receipts, 5, seed=1)
        self.assertEqual((sample["sampled"], sample["opened"], sample["failures"]), (2, 2, []))
        self.assertEqual(sample["attachmentsDecoded"], 2)
        self.assertEqual(set(Path(tempfile.gettempdir()).glob("archive-restore-*")), before)

    def test_the_report_holds_no_message_content(self):
        report, receipts = module.verify(self.copy)
        report["restoreSample"] = module.restore_sample(self.copy, receipts, 2, seed=1)
        self.assertNotIn("Synthetic", json.dumps(report))

    def test_a_missing_raw_receipt_never_produces_an_intact_report(self):
        (self.copy / "raw-receipts/message1.json").unlink()
        report, _ = module.verify(self.copy)
        self.assertFalse(report["intact"])
        self.assertEqual(report["raw"]["withoutOriginal"], 1)

    def test_optional_proof_names_only_sources_actually_verified(self):
        receipt = json.loads((self.copy / "raw-receipts/message1.json").read_text())
        (self.copy / receipt["path"]).write_bytes(b"X" * receipt["bytes"])
        report, _ = module.verify(self.copy, with_sources=True)
        proof = report["verificationProof"]
        self.assertFalse(proof["intact"])
        self.assertNotIn("message1", proof["raw"])
        self.assertIn("message2", proof["raw"])
        self.assertNotIn("Synthetic", json.dumps(proof))

    def test_tree_verification_rehashes_metadata_even_when_size_and_mtime_match(self):
        index = {"files": {p.relative_to(self.root).as_posix(): {
            "sha256": module.sha_file(p), "bytes": p.stat().st_size, "mtime": str(p.stat().st_mtime)}
            for p in self.root.rglob("*") if p.is_file()}}
        report, _ = module.verify(self.copy, with_sources=True, tree_index=index)
        self.assertTrue(report["intact"])
        path = self.copy / "threads/thread01/original.json"
        data = path.read_bytes()
        path.write_bytes(data.replace(b'"body": "x"', b'"body": "y"'))
        report, _ = module.verify(self.copy, with_sources=True, tree_index=index)
        self.assertFalse(report["intact"])
        self.assertEqual(report["archiveTree"]["mismatchedIds"], ["threads/thread01/original.json"])
        self.assertNotIn("threads/thread01/original.json", report["verificationProof"]["archiveTreeFiles"])

    def test_invalid_empty_or_escaping_tree_index_cannot_certify_an_archive(self):
        for index in ({"files": {}}, {"files": {"../outside": {"sha256": "a" * 64, "bytes": 1}}},
                      {"files": {"raw/file": {"sha256": "a" * 64, "bytes": True}}}):
            self.assertFalse(module.verify(self.copy, tree_index=index)[0]["intact"])


if __name__ == "__main__":
    unittest.main()
