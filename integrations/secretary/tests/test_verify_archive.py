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


if __name__ == "__main__":
    unittest.main()
