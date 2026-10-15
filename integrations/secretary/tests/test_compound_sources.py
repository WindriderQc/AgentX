from copy import deepcopy
import io
import json
from pathlib import Path
import stat
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from compound_sources import (Limits, decision_reasons, digest, index_attachment,
                              index_path, is_compound, proof_paths, scope)
from evidence_store import save
from archive_read import read_original


def zipped(entries):
    output = io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, content in entries:
                archive.writestr(name, content)
    return output.getvalue()


class CompoundSourcesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def attachment(self, data, name="bundle.zip"):
        path = self.root / "files" / (digest(data) + ".bin")
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(data)
        return {"filename": name, "sha256": digest(data), "bytes": len(data),
                "path": path.relative_to(self.root).as_posix(), "mimeType": "application/octet-stream"}

    def test_recursive_member_occurrences_and_duplicate_names_keep_provenance(self):
        data = zipped([("same.txt", b"first"), ("same.txt", b"second"),
                       ("inner.zip", zipped([("same.txt", b"first")]))])
        item = self.attachment(data)
        result = index_attachment(self.root, item)
        self.assertEqual(result["status"], "complete")
        self.assertEqual(len(result["members"]), 4)
        self.assertEqual(len({x["id"] for x in result["members"]}), 4)
        self.assertEqual(result["members"][3]["parentId"], result["members"][2]["id"])
        self.assertEqual(result["members"][0]["sha256"], result["members"][3]["sha256"])
        self.assertNotEqual(result["members"][0]["sha256"], result["members"][1]["sha256"])
        self.assertFalse(result["analysisAccepted"])
        self.assertTrue(all(x["readingState"] == "unread" for x in result["members"]))
        self.assertEqual((self.root / item["path"]).read_bytes(), data)
        self.assertIn(result["indexPath"], proof_paths({item["sha256"]: result}))

    def test_sniffing_catches_misnamed_packages_and_office_packages(self):
        for name in ("data.bin", "book.xlsx", "text.docx"):
            item = self.attachment(zipped([("meta.xml", b"<value>retained</value>")]), name)
            self.assertTrue(is_compound(self.root, item))
        self.assertFalse(is_compound(self.root, self.attachment(b"%PDF ordinary", "receipt.pdf")))

    def test_bad_names_links_and_encryption_remain_incomplete(self):
        link = zipfile.ZipInfo("link"); link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        for entry in ("../outside", "/absolute", "C:\\private", link):
            with self.subTest(entry=str(entry)):
                item = self.attachment(zipped([(entry, b"no execution")]))
                self.assertEqual(index_attachment(self.root, item)["status"], "incomplete")
        data = bytearray(zipped([("private.txt", b"secret")]))
        for marker, offset in ((b"PK\x03\x04", 6), (b"PK\x01\x02", 8)):
            at = data.index(marker) + offset
            struct.pack_into("<H", data, at, struct.unpack_from("<H", data, at)[0] | 1)
        result = index_attachment(self.root, self.attachment(bytes(data)))
        self.assertIn("encrypted_member", result["errors"])
        self.assertEqual(result["status"], "incomplete")

    def test_corrupt_crc_and_false_directory_counts_never_certify_inventory(self):
        data = bytearray(zipped([("a.txt", b"a"), ("b.txt", b"b")]))
        end = data.rfind(b"PK\x05\x06")
        struct.pack_into("<HH", data, end + 8, 0, 0)
        self.assertEqual(index_attachment(self.root, self.attachment(bytes(data)))["status"], "incomplete")
        data = bytearray(zipped([("a.txt", b"a")]))
        at = data.index(b"PK\x01\x02") + 16
        struct.pack_into("<L", data, at, 0)
        self.assertEqual(index_attachment(self.root, self.attachment(bytes(data)))["status"], "incomplete")

    def test_entry_depth_member_and_total_limits_preserve_partial_status(self):
        for limit, data in (
            (Limits(entries=1), zipped([("a", b"a"), ("b", b"b")])),
            (Limits(depth=0), zipped([("inner.zip", zipped([("a", b"a")]))])),
            (Limits(member_bytes=1), zipped([("a", b"aa")])),
            (Limits(total_bytes=1), zipped([("a", b"aa")])),
            (Limits(seconds=-1), zipped([("a", b"a")])),
        ):
            with self.subTest(limit=limit):
                result = index_attachment(self.root, self.attachment(data), limits=limit, retry=True)
                self.assertEqual(result["status"], "incomplete")
                self.assertTrue(result["errors"])

    def test_missing_optional_decoder_and_malformed_archive_are_explicit_holds(self):
        with patch("compound_archive.ctypes.util.find_library", return_value=None):
            result = index_attachment(self.root, self.attachment(b"Rar!\x1a\x07\x00bad", "data.rar"))
        self.assertIn("archive_decoder_unavailable", result["errors"])
        self.assertEqual(index_attachment(self.root, self.attachment(b"bad", "broken.zip"))["status"], "incomplete")

    def test_missing_or_corrupt_preserved_members_invalidate_cached_scope(self):
        item = self.attachment(zipped([("a.txt", b"first")]))
        self.assertEqual(scope(self.root, item)["status"], "missing")
        indexed = index_attachment(self.root, item)
        blob = self.root / indexed["members"][0]["path"]
        blob.write_bytes(b"other")  # Same size, wrong bytes.
        self.assertEqual(scope(self.root, item)["status"], "invalid")
        blob.unlink()
        self.assertEqual(scope(self.root, item)["status"], "invalid")

    def test_source_integrity_and_index_member_paths_are_checked(self):
        item = self.attachment(zipped([("a.txt", b"first")]))
        result = index_attachment(self.root, item)
        cached = json.loads(index_path(self.root, item["sha256"]).read_text())
        cached["members"][0]["path"] = "../outside"
        save(index_path(self.root, item["sha256"]), cached)
        self.assertEqual(scope(self.root, item)["status"], "invalid")
        changed = dict(item, sha256="b" * 64)
        self.assertIn("source_integrity_failed", index_attachment(self.root, changed)["errors"])
        self.assertFalse(result["analysisAccepted"])

    def test_partial_indexes_cannot_inject_paths_into_copy_proofs(self):
        item = self.attachment(zipped([("a.txt", b"first")]))
        index_attachment(self.root, item)
        cached = json.loads(index_path(self.root, item["sha256"]).read_text())
        cached["status"] = "incomplete"
        cached["members"][0]["path"] = "../outside"
        save(index_path(self.root, item["sha256"]), cached)
        self.assertEqual(scope(self.root, item)["status"], "invalid")
        self.assertEqual(proof_paths({"unsafe": cached}), [])

    def test_explicit_retry_keeps_exact_prior_receipt_and_invalidates_pins(self):
        item = self.attachment(zipped([("a.txt", b"first")]))
        first = index_attachment(self.root, item, limits=Limits(entries=0))
        old = index_path(self.root, item["sha256"]).read_bytes()
        self.assertEqual(index_attachment(self.root, item)["status"], "incomplete")
        second = index_attachment(self.root, item, retry=True)
        self.assertEqual(second["status"], "complete")
        kept = self.root / "compound-sources/history" / item["sha256"] / (digest(old) + ".json")
        self.assertEqual(kept.read_bytes(), old)
        self.assertNotEqual(first["indexSha256"], second["indexSha256"])

    def test_outer_attachment_disposition_does_not_address_unread_members(self):
        item = self.attachment(zipped([("invoice.txt", b"Follow up"), ("letter.txt", b"A date")]))
        result = index_attachment(self.root, item)
        scopes = {item["sha256"]: result}
        self.assertIn("compound_member_dispositions_incomplete", decision_reasons(scopes, {}))
        decisions = {m["id"]: {"state": "addressed", "reason": "Read original member", "evidenceRef": "synthetic-proof"}
                     for m in result["members"]}
        metadata = {item["sha256"]: {"state": "addressed", "reason": "Metadata read separately", "evidenceRef": "proof"}}
        self.assertEqual(decision_reasons(scopes, decisions, metadata), [])
        decisions[next(iter(decisions))]["state"] = "unread"
        self.assertIn("compound_member_disposition_unproven", decision_reasons(scopes, decisions))
        invalid = deepcopy(result); invalid["status"] = "incomplete"
        self.assertIn("compound_inventory_missing_or_incomplete", decision_reasons({item["sha256"]: invalid}, decisions))

    def test_zip_comments_are_preserved_sources_needing_their_own_reading(self):
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            archive.comment = b"Reminder in the container comment"
            info = zipfile.ZipInfo("letter.txt"); info.comment = b"A separate date"
            archive.writestr(info, b"A separate letter")
        item = self.attachment(output.getvalue())
        result = index_attachment(self.root, item)
        self.assertEqual(result["status"], "complete")
        self.assertEqual(len(result["members"]), 3)
        self.assertEqual({m["role"] for m in result["members"]}, {"archive_comment", "member", "member_comment"})

    def test_original_reader_exposes_cached_scope_without_decoding_or_member_hashing(self):
        from email.message import EmailMessage
        message = EmailMessage(); message.set_content("A short outer message")
        message.add_attachment(zipped([("note.txt", b"A separate source")]),
                               maintype="application", subtype="zip", filename="bundle.zip")
        data = message.as_bytes(); mid, thread = "1234567890abcdef", "1234567890abcdea"
        raw = self.root / "raw.eml"; raw.write_bytes(data)
        item = self.attachment(message.get_payload()[1].get_payload(decode=True))
        index_attachment(self.root, item)
        save(self.root / "raw-receipts" / (mid + ".json"),
             {"messageId": mid, "threadId": thread, "path": "raw.eml", "sha256": digest(data), "bytes": len(data)})
        save(self.root / "threads" / thread / "manifest.json", {"messages": [{"id": mid, "attachments": [item]}]})
        with patch("compound_sources.members", side_effect=AssertionError("No decoding during mail read")):
            result = read_original(self.root, mid, digest(data))
        self.assertEqual(result["readerContract"], "secretary.archive-reader/v3")
        self.assertIn("compound_attachment_members_require_separate_review", result["readingWarnings"])
        projected = result["compoundAttachments"][item["sha256"]]
        self.assertFalse(projected["memberCopiesChecked"])
        self.assertFalse(projected["analysisAccepted"])


if __name__ == "__main__":
    unittest.main()
