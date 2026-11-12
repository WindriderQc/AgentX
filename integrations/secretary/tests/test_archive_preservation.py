"""Native exact-source preservation uses bytes, not caller attestations."""
from contextlib import redirect_stdout
from copy import deepcopy
from email.message import EmailMessage
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import archive_preservation as native
import secretary_mail_desk as desk

MID, TID = "a" * 16, "b" * 16
ATTACHMENT = b"synthetic preserved binary attachment"


@unittest.skipUnless(hasattr(os, "O_NOFOLLOW") and os.open in os.supports_dir_fd,
                     "Native archive probing requires POSIX no-follow directory descriptors")
class NativePreservationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "archive"; self.root.mkdir()
        self.machine = Path(self.temp.name) / "machine-id"; self.machine.write_bytes(b"1" * 32 + b"\n")
        machine_patch = patch.object(native, "MACHINE_ID_FILE", self.machine)
        machine_patch.start(); self.addCleanup(machine_patch.stop)
        self.request = str(uuid4())
        mail = EmailMessage()
        mail["Message-ID"] = "<synthetic@example.invalid>"
        mail["Subject"] = "Synthetic private mail marker"
        mail.set_content("Synthetic complete private body marker")
        for name in ("first.bin", "same-bytes.bin"):
            mail.add_attachment(ATTACHMENT, maintype="application", subtype="octet-stream", filename=name)
        mail.set_boundary("synthetic-boundary")
        sha = hashlib.sha256(ATTACHMENT).hexdigest()
        self.attachment = self.root / "files" / (sha + ".bin")
        self.attachment.parent.mkdir(); self.attachment.write_bytes(ATTACHMENT)
        self.receipt = {"messageId": MID, "threadId": TID}
        self.message = {"id": MID, "headers": {"message-id": str(mail["Message-ID"])},
            "attachments": [{"partId": str(index), "sha256": sha, "bytes": len(ATTACHMENT),
                             "path": "files/" + self.attachment.name} for index in ("1", "2")]}
        self.manifest = {"threadId": TID, "messages": [self.message,
            {"id": "c" * 16, "attachments": [{"path": "../unrelated-source-must-not-be-read"}]}]}
        self.manifest_file = self.root / "threads" / TID / "manifest.json"
        self.receipt_file = self.root / "raw-receipts" / (MID + ".json")
        self.set_raw(mail.as_bytes())

    def save(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value))

    def set_raw(self, raw):
        self.sha = hashlib.sha256(raw).hexdigest()
        self.raw = self.root / "raw" / (self.sha + ".eml")
        self.raw.parent.mkdir(exist_ok=True); self.raw.write_bytes(raw)
        self.receipt.update(path="raw/" + self.raw.name, sha256=self.sha, bytes=len(raw))
        self.save(self.receipt_file, self.receipt)
        self.save(self.manifest_file, self.manifest)

    def probe(self, **changes):
        fields = {"root": self.root, "message_id": MID, "thread_id": TID,
                  "source_sha256": self.sha, "request_id": self.request, **changes}
        return native.probe(**fields)

    def refused(self, **changes):
        with self.assertRaises(native.PreservationError) as raised:
            self.probe(**changes)
        text = str(raised.exception)
        self.assertNotIn(str(self.root), text)
        self.assertNotIn("private body marker", text)
        return raised.exception

    def test_verified_bytes_and_duplicate_content_are_complete_without_private_text(self):
        result = self.probe()
        self.assertEqual(result["contract"], "secretary.archive-preservation/v1")
        self.assertEqual((result["requestId"], result["messageId"], result["threadId"], result["sourceSha256"]),
                         (self.request, MID, TID, self.sha))
        self.assertEqual(result["machineIdSha256"], hashlib.sha256(b"1" * 32).hexdigest())
        self.assertEqual(result["archiveIdSha256"], hashlib.sha256(str(self.root).encode()).hexdigest())
        self.assertEqual((result["partsDecoded"], result["attachmentsDecoded"]), (3, 2))
        self.assertEqual([row["partId"] for row in result["attachments"]], ["1", "2"])
        self.assertEqual(result["raw"], {"sha256": self.sha, "bytes": self.raw.stat().st_size})
        encoded = json.dumps(result)
        for private in (str(self.root), "first.bin", "same-bytes.bin", "private body marker", "private mail marker"):
            self.assertNotIn(private, encoded)

    def test_probe_only_opens_files_for_reading_and_does_not_write_or_call_provider(self):
        before = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        original = os.open
        def readonly(path, flags, *args, **kwargs):
            self.assertFalse(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC))
            return original(path, flags, *args, **kwargs)
        with patch.object(native.os, "open", side_effect=readonly), patch.object(desk, "run_gog", side_effect=AssertionError("No provider")):
            self.probe()
        after = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        self.assertEqual(before, after)

    def test_plain_utf8_original_without_attachments_has_a_complete_empty_attachment_set(self):
        mail = EmailMessage(); mail["Message-ID"] = "<synthetic@example.invalid>"
        mail.set_content("Texte synthétique avec accents", charset="utf-8")
        self.message["attachments"] = []; self.set_raw(mail.as_bytes())
        result = self.probe()
        self.assertEqual((result["partsDecoded"], result["attachmentsDecoded"], result["attachments"]), (1, 0, []))

    def test_invalid_request_identities_refuse_before_native_access(self):
        with patch.object(native, "SourceFiles") as sources:
            for change in ({"message_id": "../unsafe"}, {"thread_id": "bad"}, {"source_sha256": "Z" * 64},
                           {"request_id": "not-an-id"}, {"message_id": None}):
                self.assertEqual(self.refused(**change).status, 400)
            sources.assert_not_called()

    def test_raw_receipt_must_match_exact_message_thread_sha_size(self):
        original = deepcopy(self.receipt)
        for changes in ({"messageId": "c" * 16}, {"threadId": "c" * 16}, {"sha256": "0" * 64},
                        {"bytes": True}, {"bytes": 0}, {"bytes": original["bytes"] + 1}):
            with self.subTest(changes=changes):
                self.save(self.receipt_file, {**original, **changes}); self.refused()

    def test_raw_missing_and_damaged_bytes_refuse(self):
        data = self.raw.read_bytes()
        self.raw.write_bytes(b"x" * len(data)); self.refused()
        self.raw.unlink(); self.refused()

    def test_missing_corrupted_or_wrong_size_attachment_refuses(self):
        self.attachment.write_bytes(b"x" * len(ATTACHMENT)); self.refused()
        self.attachment.unlink(); self.refused()

    def test_attachment_identity_and_count_must_be_unambiguous(self):
        original = deepcopy(self.message["attachments"])
        cases = [[], original[:1], original * 2,
                 [{**original[0], "partId": None}, original[1]],
                 [{**original[0], "partId": original[1]["partId"]}, original[1]],
                 [{**original[0], "bytes": True}, original[1]], [True], {}, None]
        for attachments in cases:
            with self.subTest(attachments=attachments):
                self.message["attachments"] = attachments; self.save(self.manifest_file, self.manifest); self.refused()

    def test_native_manifest_identity_duplicate_source_and_header_mismatch_refuse(self):
        for manifest in ({**self.manifest, "threadId": "c" * 16},
                         {"threadId": TID, "messages": [self.message, self.message]},
                         {"threadId": TID, "messages": []}, {"threadId": TID, "messages": [True]}):
            self.save(self.manifest_file, manifest); self.refused()
        self.message["headers"] = {"message-id": "<different@example.invalid>"}
        self.save(self.manifest_file, self.manifest); self.refused()

    def test_symlink_original_or_metadata_even_within_archive_is_refused(self):
        for path in (self.raw, self.receipt_file, self.manifest_file, self.attachment):
            with self.subTest(path=path):
                backup = path.with_name(path.name + ".kept"); path.rename(backup); path.symlink_to(backup)
                self.refused(); path.unlink(); backup.rename(path)

    def test_symlink_directory_and_fifo_are_refused_without_follow_or_blocking(self):
        files = self.root / "files"; actual = self.root / "original-files"; files.rename(actual); files.symlink_to(actual)
        self.refused(); files.unlink(); actual.rename(files)
        self.attachment.unlink(); os.mkfifo(self.attachment); self.refused()

    def test_paths_cannot_escape_or_be_normalized_into_another_scope(self):
        original = deepcopy(self.receipt)
        for path in ("../unrelated", str(self.raw), "raw/../raw/" + self.raw.name,
                     "raw//" + self.raw.name, "raw\\" + self.raw.name, None, []):
            self.save(self.receipt_file, {**original, "path": path}); self.refused()

    def test_duplicate_metadata_json_keys_do_not_select_one_of_two_sources(self):
        raw = self.receipt_file.read_text().replace('"messageId":', '"messageId":"c", "messageId":', 1)
        self.receipt_file.write_text(raw); self.refused()

    def test_nonfinite_selected_metadata_is_not_hashed_into_a_valid_native_scope(self):
        self.message["bodyChars"] = float("nan"); self.save(self.manifest_file, self.manifest); self.refused()

    def test_budget_is_total_including_metadata_machine_id_and_unique_attachment_bytes(self):
        total = sum(p.stat().st_size for p in (self.raw, self.attachment, self.receipt_file, self.manifest_file, self.machine))
        with patch.object(native, "MAX_BYTES", total):
            self.probe()  # same bytes at two part IDs share one native file read
        with patch.object(native, "MAX_BYTES", total - 1):
            self.assertEqual(self.refused().status, 413)

    def test_attachment_and_mime_part_caps_refuse(self):
        with patch.object(native, "MAX_ATTACHMENTS", 1):
            self.assertEqual(self.refused().status, 413)
        with patch.object(native, "MAX_PARTS", 2):
            self.assertEqual(self.refused().status, 413)

    def test_declared_scope_counts_duplicate_content_even_when_file_read_is_cached(self):
        payload = b"x" * 4096
        sha = hashlib.sha256(payload).hexdigest()
        self.attachment = self.attachment.with_name(sha + ".bin"); self.attachment.write_bytes(payload)
        for item in self.message["attachments"]:
            item.update(sha256=sha, bytes=len(payload), path="files/" + self.attachment.name)
        mail = EmailMessage(); mail["Message-ID"] = "<synthetic@example.invalid>"; mail.set_content("Synthetic")
        for name in ("first.bin", "second.bin"):
            mail.add_attachment(payload, maintype="application", subtype="octet-stream", filename=name)
        self.set_raw(mail.as_bytes())
        read_budget = sum(p.stat().st_size for p in (self.raw, self.attachment, self.receipt_file, self.manifest_file, self.machine))
        self.assertLess(read_budget, self.raw.stat().st_size + len(payload) * 2)
        with patch.object(native, "MAX_BYTES", read_budget):
            self.assertEqual(self.refused().status, 413)

    def test_malformed_mime_invalid_base64_and_unknown_charset_are_not_decoded(self):
        for data in (b"Content-Type: multipart/mixed; boundary=missing\n\nnot a MIME tree",
                     b"Content-Type: application/octet-stream\nContent-Transfer-Encoding: base64\n\nA!",
                     b"Content-Type: text/plain; charset=unknown-native-codec\n\ntext",
                     b"Content-Type: text/plain; charset=utf-8\n\n\xff"):
            self.set_raw(data); self.refused()

    def test_nested_mail_is_explicitly_unsupported_without_reencoding_it(self):
        self.set_raw(b"Content-Type: message/rfc822\n\nSubject: nested\n\nsynthetic")
        self.assertEqual(self.refused().code, "SECRETARY_PRESERVATION_MIME")

    def test_native_machine_identity_has_no_hostname_or_caller_fallback(self):
        for value in (b"", b"0" * 32, b"synthetic-hostname", b"a" * 4097):
            self.machine.write_bytes(value)
            self.assertEqual(self.refused().code, "SECRETARY_PRESERVATION_IDENTITY")
        self.machine.unlink(); self.assertEqual(self.refused().code, "SECRETARY_PRESERVATION_IDENTITY")

    def test_late_mutation_of_an_already_read_original_is_refused(self):
        original = native.mime_scope
        def mutate(data):
            result = original(data); self.raw.write_bytes(b"x" * len(data)); return result
        with patch.object(native, "mime_scope", side_effect=mutate):
            self.refused()

    def test_source_growth_during_the_read_refuses_without_reading_past_the_budget(self):
        original = os.read; changed = False
        def grow(fd, count):
            nonlocal changed
            chunk = original(fd, count)
            if not changed and os.fstat(fd).st_ino == self.raw.stat().st_ino:
                changed = True; self.raw.write_bytes(self.raw.read_bytes() + b"new byte")
            return chunk
        with patch.object(native.os, "read", side_effect=grow):
            self.refused()
        self.assertTrue(changed)

    def test_late_path_replacement_with_identical_bytes_is_refused(self):
        original = native.mime_scope
        def replace(data):
            result = original(data); replacement = self.raw.with_suffix(".replacement")
            replacement.write_bytes(data); replacement.replace(self.raw); return result
        with patch.object(native, "mime_scope", side_effect=replace):
            self.refused()

    def test_desk_returns_native_scope_without_account_keyring_or_provider(self):
        output = io.StringIO()
        with patch.object(desk, "native_settings", return_value={}), patch.dict(os.environ, {}, clear=True), \
                patch.object(desk, "run_gog", side_effect=AssertionError("No provider")), redirect_stdout(output):
            code = desk.main(["--evidence-root", str(self.root), "preservation", "--message", MID,
                              "--thread", TID, "--sha256", self.sha, "--request-id", self.request])
        self.assertEqual(code, 0)
        result = json.loads(output.getvalue()); self.assertEqual(result["status"], "success")
        self.assertEqual(result["data"]["requestId"], self.request)

    def test_desk_error_envelope_never_returns_private_path_or_raw_source(self):
        self.attachment.unlink()
        output = io.StringIO()
        with patch.object(desk, "native_settings", return_value={}), redirect_stdout(output):
            desk.main(["--evidence-root", str(self.root), "preservation", "--message", MID,
                       "--thread", TID, "--sha256", self.sha, "--request-id", self.request])
        result = json.loads(output.getvalue()); self.assertEqual(result["status"], "error")
        self.assertEqual(result["code"], "SECRETARY_PRESERVATION_INTEGRITY")
        self.assertNotIn(str(self.root), output.getvalue())


if __name__ == "__main__":
    unittest.main()
