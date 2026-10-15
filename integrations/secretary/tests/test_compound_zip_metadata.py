"""Synthetic ZIPs whose local extra fields differ from their central directory."""
import base64
import io
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from compound_archive import CompoundError, zip_members
from compound_sources import Limits, decision_reasons, digest, index_attachment, index_path
from archive_read import read_original
from evidence_store import save


def extra(tag, data):
    return struct.pack("<HH", tag, len(data)) + data


def separate_headers(local_extra=b"", central_extra=b"", name=b"note.txt", content=b"A memo"):
    """A valid stored ZIP, built independently of ZipInfo.extra's shared copies."""
    crc, size = zlib.crc32(content), len(content)
    local = struct.pack("<4s5H3I2H", b"PK\x03\x04", 20, 0, 0, 0, 33, crc,
                        size, size, len(name), len(local_extra)) + name + local_extra + content
    central = struct.pack("<4s6H3I5H2I", b"PK\x01\x02", 20, 20, 0, 0, 0, 33, crc,
                          size, size, len(name), len(central_extra), 0, 0, 0, 0, 0) + name + central_extra
    end = struct.pack("<4s4H2IH", b"PK\x05\x06", 0, 0, 1, 1, len(central), len(local), 0)
    return local + central + end


class NonSeekable(io.BytesIO):
    def seek(self, *args):
        raise io.UnsupportedOperation("stream")


class CompoundZipMetadataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def index(self, data, **kwargs):
        sha = digest(data)
        path = self.root / "files" / (sha + ".zip")
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(data)
        item = {"filename": "bundle.zip", "path": path.relative_to(self.root).as_posix(),
                "sha256": sha, "bytes": len(data)}
        return item, index_attachment(self.root, item, **kwargs)

    def test_local_only_text_is_preserved_even_when_zipinfo_extra_is_empty(self):
        note = b"A separate appointment note"
        data = separate_headers(extra(0xcafe, note))
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            self.assertEqual(archive.infolist()[0].extra, b"")
            self.assertEqual(archive.read("note.txt"), b"A memo")
        item, indexed = self.index(data)
        self.assertEqual(indexed["status"], "complete")
        member = indexed["members"][0]
        local = member["metadata"]["zipLocalHeader"]["extraFields"][0]
        self.assertEqual(base64.b64decode(local["base64"]), note)
        self.assertEqual(local["sha256"], digest(note))
        self.assertEqual(local["textAsUtf8"], note.decode())
        self.assertEqual(member["metadata"]["zipCentralHeader"]["extraFields"], [])
        self.assertEqual((self.root / item["path"]).read_bytes(), data)
        self.assertEqual(member["readingState"], "unread")
        self.assertFalse(indexed["analysisAccepted"])
        self.assertTrue(indexed["metadataScope"]["unexposedFormatHeadersOrCommentsNeedSeparateReview"])
        self.assertIn("compound_metadata_dispositions_incomplete", decision_reasons(
            {item["sha256"]: indexed}, {member["id"]: {
                "state": "addressed", "reason": "Memo read", "evidenceRef": "synthetic"}}))

    def test_different_central_local_duplicate_and_binary_fields_keep_order_and_bytes(self):
        local = extra(0xcafe, b"local") + extra(0xcafe, b"second")
        central = extra(0xbeef, b"central\xff\x00")
        _, indexed = self.index(separate_headers(local, central))
        self.assertEqual(indexed["status"], "complete")
        metadata = indexed["members"][0]["metadata"]
        fields = metadata["zipLocalHeader"]["extraFields"]
        self.assertEqual([base64.b64decode(x["base64"]) for x in fields], [b"local", b"second"])
        field = metadata["zipCentralHeader"]["extraFields"][0]
        self.assertEqual(base64.b64decode(field["base64"]), b"central\xff\x00")
        self.assertNotIn("textAsUtf8", field)

    def test_office_growth_padding_is_kept_as_opaque_source_metadata(self):
        value = struct.pack("<HH", 0xa028, 16) + bytes(16)
        _, indexed = self.index(separate_headers(extra(0xa220, value)))
        field = indexed["members"][0]["metadata"]["zipLocalHeader"]["extraFields"][0]
        self.assertEqual(field["headerId"], "a220")
        self.assertEqual(base64.b64decode(field["base64"]), value)
        self.assertNotIn("textAsUtf8", field)

    def test_directory_payload_cannot_be_skipped_and_counted_as_complete(self):
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            archive.writestr("notes/", b"A source stored under a directory name")
        data = output.getvalue()
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            self.assertTrue(archive.infolist()[0].is_dir())
            self.assertEqual(archive.read("notes/"), b"A source stored under a directory name")
        item, indexed = self.index(data)
        self.assertEqual(indexed["status"], "incomplete")
        self.assertIn("directory_member_has_data_or_unknown_size", indexed["errors"])
        self.assertEqual((self.root / item["path"]).read_bytes(), data)
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            archive.writestr("notes/", b"")
            archive.writestr("notes/readme.txt", b"An ordinary source")
        _, empty_directory = self.index(output.getvalue())
        self.assertEqual(empty_directory["status"], "complete")

    def test_malformed_extra_fields_hold_the_inventory_without_changing_original(self):
        for malformed in (b"x", struct.pack("<HH", 0xcafe, 8) + b"short"):
            for location in ("local", "central"):
                with self.subTest(location=location, malformed=malformed):
                    data = separate_headers(malformed if location == "local" else b"",
                                            malformed if location == "central" else b"")
                    item, indexed = self.index(data)
                    self.assertEqual(indexed["status"], "incomplete")
                    self.assertTrue(indexed["errors"])
                    self.assertEqual((self.root / item["path"]).read_bytes(), data)

    def test_local_header_names_flags_method_crc_sizes_and_bounds_must_match(self):
        changes = ((30, "B", ord("x")), (6, "H", 0x800), (8, "H", 8),
                   (14, "I", 0), (18, "I", 10000), (22, "I", 1), (28, "H", 65535))
        for offset, fmt, value in changes:
            with self.subTest(offset=offset):
                data = bytearray(separate_headers())
                struct.pack_into("<" + fmt, data, offset, value)
                _, indexed = self.index(bytes(data))
                self.assertEqual(indexed["status"], "incomplete")
                self.assertTrue(indexed["errors"])

    def test_streaming_descriptors_and_forced_small_zip64_remain_supported(self):
        for streaming in (False, True):
            for forced_zip64 in (False, True):
                with self.subTest(streaming=streaming, zip64=forced_zip64):
                    output = NonSeekable() if streaming else io.BytesIO()
                    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                        with archive.open("note.txt", "w", force_zip64=forced_zip64) as handle:
                            handle.write(b"A small streamed memo")
                    _, indexed = self.index(output.getvalue())
                    self.assertEqual(indexed["status"], "complete", indexed["errors"])
                    self.assertEqual((self.root / indexed["members"][0]["path"]).read_bytes(),
                                     b"A small streamed memo")

    def test_duplicate_or_overlapping_local_ranges_hold_before_reading_content(self):
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            archive.writestr("first.txt", b"first")
            archive.writestr("second.txt", b"second")
        original = output.getvalue()
        first_central = original.index(b"PK\x01\x02")
        second_central = original.index(b"PK\x01\x02", first_central + 4)
        for corruption in ("duplicate", "overlap"):
            with self.subTest(corruption=corruption):
                data = bytearray(original)
                if corruption == "duplicate":
                    struct.pack_into("<I", data, second_central + 42, 0)
                else:
                    struct.pack_into("<I", data, 18, 1000)
                    struct.pack_into("<I", data, first_central + 20, 1000)
                with patch("zipfile.ZipFile.open", side_effect=AssertionError("Do not read corrupt ranges")):
                    _, indexed = self.index(bytes(data))
                self.assertEqual(indexed["status"], "incomplete")
                self.assertIn("zip_local_header_bounds_invalid", indexed["errors"])

    def test_raw_and_nested_metadata_limits_are_explicit_holds(self):
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            for name in ("a", "b", "c"):
                info = zipfile.ZipInfo(name)
                info.extra = extra(0xcafe, bytes(60000))
                archive.writestr(info, b"memo")
        with self.assertRaisesRegex(CompoundError, "zip_extra_metadata_size_limit"):
            list(zip_members(output.getvalue()))
        inner = separate_headers(extra(0xcafe, b"n" * 500))
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            archive.writestr("one.zip", inner)
            archive.writestr("two.zip", inner)
        _, indexed = self.index(output.getvalue(), limits=Limits(metadata_bytes=3000))
        self.assertEqual(indexed["status"], "incomplete")
        self.assertIn("metadata_size_limit", indexed["errors"])

    def test_existing_index_is_not_enriched_until_explicit_retry_and_old_bytes_remain(self):
        item, initial = self.index(separate_headers(extra(0xcafe, b"a note")))
        path = index_path(self.root, item["sha256"])
        old = json.loads(path.read_text())
        for member in old["members"]:
            member["metadata"].pop("zipLocalHeader", None)
            member["metadata"].pop("zipCentralHeader", None)
        old["metadataScope"].pop("zipLocalAndCentralExtraFieldsExposed", None)
        path.write_text(json.dumps(old))
        old_bytes = path.read_bytes()
        cached = index_attachment(self.root, item)
        self.assertEqual(path.read_bytes(), old_bytes)
        self.assertNotIn("zipLocalHeader", cached["members"][0]["metadata"])
        updated = index_attachment(self.root, item, retry=True)
        kept = self.root / "compound-sources" / "history" / item["sha256"] / (digest(old_bytes) + ".json")
        self.assertEqual(kept.read_bytes(), old_bytes)
        self.assertIn("zipLocalHeader", updated["members"][0]["metadata"])
        self.assertEqual([m["id"] for m in initial["members"]], [m["id"] for m in updated["members"]])
        self.assertNotEqual(cached["indexSha256"], updated["indexSha256"])

    def test_cached_original_reader_exposes_local_metadata_without_decoding_or_acceptance(self):
        from email.message import EmailMessage
        data = separate_headers(extra(0xcafe, b"A separate note"))
        item, _ = self.index(data)
        message = EmailMessage()
        message.set_content("A message with an archive")
        message.add_attachment(data, maintype="application", subtype="zip", filename="bundle.zip")
        original = message.as_bytes()
        mid, tid = "1234567890abcdef", "1234567890abcdea"
        (self.root / "original.eml").write_bytes(original)
        save(self.root / "raw-receipts" / (mid + ".json"), {
            "messageId": mid, "threadId": tid, "path": "original.eml",
            "sha256": digest(original), "bytes": len(original)})
        save(self.root / "threads" / tid / "manifest.json", {
            "messages": [{"id": mid, "attachments": [item]}]})
        before = index_path(self.root, item["sha256"]).read_bytes()
        with patch("compound_sources.members", side_effect=AssertionError("No decoding on read")):
            view = read_original(self.root, mid, digest(original))
        scope = view["compoundAttachments"][item["sha256"]]
        field = scope["members"][0]["metadata"]["zipLocalHeader"]["extraFields"][0]
        self.assertEqual(field["textAsUtf8"], "A separate note")
        self.assertEqual(index_path(self.root, item["sha256"]).read_bytes(), before)
        self.assertFalse(scope["memberCopiesChecked"])
        self.assertFalse(scope["analysisAccepted"])


if __name__ == "__main__":
    unittest.main()
