import base64
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location("secretary_evidence", Path(__file__).resolve().parents[1] / "secretary_evidence.py")
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        configured_queries = mock.patch.dict(module.QUERIES, {"contact": "in:anywhere from:contact@example.invalid"})
        configured_queries.start()
        self.addCleanup(configured_queries.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_discovery_keeps_pagination_and_processed_sent_contact_mail(self):
        responses = iter([
            {"messages": [{"id": "message1", "threadId": "thread01", "labels": ["SENT", "Secretary/Processed"]}], "nextPageToken": "page-two"},
            {"messages": [{"id": "message2", "threadId": "thread02"}]},
        ])
        commands = []
        def run(command):
            commands.append(command)
            return next(responses)
        archive = module.Archive(self.root, run)
        self.assertFalse(archive.discover("contact")["complete"])
        result = archive.discover("contact")
        self.assertTrue(result["complete"])
        self.assertEqual(len(result["messages"]), 2)
        self.assertIn("--page=page-two", commands[-1])
        self.assertNotIn("-in:sent", module.QUERIES["contact"])
        self.assertNotIn("Processed", module.QUERIES["invoices"])
        self.assertNotIn("subject:", module.QUERIES["invoices"])
        self.assertNotIn("has:attachment", module.QUERIES["mailbox"])

    def test_archive_keeps_every_message_and_original_file_with_safe_dedup(self):
        data = base64.urlsafe_b64encode(b"invoice 123").decode()
        payload = {"thread": {"messages": [
            {"id": "message1", "body": "A" * 40000, "headers": {"subject": "Communications"}, "payload": {"parts": [
                {"filename": "../../escaped.txt", "mimeType": "text/plain", "body": {"data": data}}]}},
            {"id": "message2", "body": "Second message", "headers": {"subject": "Follow-up"}, "payload": {"parts": [
                {"filename": "renamed.txt", "mimeType": "text/plain", "body": {"data": data}}]}},
        ]}}
        archive = module.Archive(self.root, lambda _: payload)
        manifest = archive.collect_thread("thread01")
        self.assertEqual(len(manifest["messages"]), 2)
        self.assertEqual(manifest["messages"][0]["bodyChars"], 40000)
        self.assertEqual(archive.status()["uniqueFiles"], 1)
        self.assertEqual(len(list((self.root / "files").glob("*.txt"))), 2)  # original + extraction
        packet = ""
        offset = 0
        while True:
            page = archive.read_packet("thread01", offset, 15000)
            packet += page["externalUntrustedContent"]
            if page["nextOffset"] is None:
                break
            offset = page["nextOffset"]
        self.assertIn("A" * 40000, packet)
        self.assertIn("Second message", packet)
        self.assertIn("invoice 123", packet)
        self.assertEqual(archive.status()["fullyReviewedThreads"], 0)
        review = {"threadId": "thread01", "evidenceHash": manifest["evidenceHash"], "coverage": "partial",
                  "actions": [{"messageId": "message2", "text": "Confirm status"}]}
        self.assertTrue(archive.review(review)["saved"])
        self.assertEqual(archive.status()["fullyReviewedThreads"], 0)
        review["actions"][0]["messageId"] = "invented"
        with self.assertRaisesRegex(ValueError, "messageId"):
            archive.review(review)
        review["evidenceHash"] = "stale"
        with self.assertRaisesRegex(ValueError, "evidence"):
            archive.review(review)

    def test_html_fallback_omits_scripts_without_losing_text(self):
        data = base64.urlsafe_b64encode(b"<p>Invoice</p><script>execute()</script><p>100</p>").decode()
        text = module.message_text({"payload": {"mimeType": "text/html", "body": {"data": data}}})
        self.assertIn("Invoice", text)
        self.assertIn("100", text)
        self.assertNotIn("execute", text)

    def test_path_traversal_ids_rejected(self):
        with self.assertRaises(ValueError):
            module.identifier("../../secret")

    def test_large_thread_state_omits_bodies_and_retains_each_message_state(self):
        archive = module.Archive(self.root, lambda _: {"thread": {"messages": [
            {"id": "message1", "labelIds": ["INBOX", "UNREAD"], "body": "private" * 200000},
            {"id": "message2", "labelIds": ["UNREAD"], "payload": {"data": "private" * 200000}},
        ]}})
        state = archive.thread_state("thread01")
        self.assertLess(len(json.dumps(state)), 200)
        self.assertEqual(state["thread"]["messages"], [
            {"id": "message1", "labelIds": ["INBOX", "UNREAD"]},
            {"id": "message2", "labelIds": ["UNREAD"]}])

    def test_general_reader_pages_large_threads_without_loss_and_rejects_stale_cursor(self):
        body = "Large unrelated conversation. é 👋\r\n" * 50000
        payload = {"thread": {"messages": [{"id": "message1", "body": body, "headers": {"subject": "Any sender"}},
                   {"id": "message2", "body": "Last message still visible", "headers": {}}]}}
        calls = []
        def run(command):
            calls.append(command)
            return payload
        archive = module.Archive(self.root, run)
        page = archive.read_source({"kind": "thread", "id": "thread01"})
        digest = page["sourceHash"]
        all_text = page["body"]
        while page["nextOffset"] is not None:
            self.assertLessEqual(len(page["body"]), 10000)
            page = archive.read_source({"kind": "thread", "id": "thread01", "offset": page["nextOffset"], "sourceHash": digest})
            all_text += page["body"]
        self.assertTrue(body in all_text, "Paginated reading changed or skipped source characters")
        self.assertIn("Last message still visible", all_text)
        self.assertEqual(len(calls), 1)
        with self.assertRaisesRegex(ValueError, "sourceHash"):
            archive.read_source({"kind": "thread", "id": "thread01", "offset": 10000, "sourceHash": "wrong"})
        payload["thread"]["messages"].append({"id": "message3", "body": "New reply"})
        fresh = archive.read_source({"kind": "thread", "id": "thread01"})
        self.assertNotEqual(fresh["sourceHash"], digest)
        with self.assertRaisesRegex(ValueError, "sourceHash"):
            archive.read_source({"kind": "thread", "id": "thread01", "offset": 10000, "sourceHash": digest})

    def test_general_message_reader_uses_raw_mime_when_top_level_body_is_truncated(self):
        body = "Full source " * 2000
        payload = {"body": "short preview", "message": {"id": "message1", "threadId": "thread01", "payload": {
            "mimeType": "text/plain", "body": {"data": base64.urlsafe_b64encode(body.encode()).decode()},
            "headers": [{"name": "Subject", "value": "Any sender"}]}}}
        archive = module.Archive(self.root, lambda _: payload)
        page = archive.read_source({"kind": "message", "id": "message1"})
        self.assertEqual(page["totalChars"], len(body))
        self.assertTrue(page["bodyTruncated"])
        self.assertEqual(page["threadId"], "thread01")

    def test_reader_drops_invisible_padding_but_keeps_every_visible_word(self):
        padding = "\u034f\u200c " * 3000
        html = f"<p>Preview{padding}</p><p>Please   confirm\u00a0by Friday</p>" + "<div> </div>" * 200 + "<p>Account 42</p>"
        payload = {"message": {"id": "message2", "threadId": "thread02", "payload": {
            "mimeType": "text/html", "body": {"data": base64.urlsafe_b64encode(html.encode()).decode()},
            "headers": [{"name": "Subject", "value": "Newsletter"}]}}}
        page = module.Archive(self.root, lambda _: payload).read_source({"kind": "message", "id": "message2"})
        self.assertFalse(page["bodyTruncated"])
        self.assertEqual(page["body"], "Preview\nPlease confirm by Friday\n\nAccount 42")

    def test_invoice_pages_fill_unknown_fields_and_keep_conflicting_readings_visible(self):
        data = base64.urlsafe_b64encode(b"Invoice spread across source pages").decode()
        archive = module.Archive(self.root, lambda _: {"messages": [{"id": "message1", "body": "Source",
            "payload": {"parts": [{"filename": "invoice.txt", "body": {"data": data}}]}}]})
        manifest = archive.collect_thread("thread01")
        digest = manifest["messages"][0]["attachments"][0]["sha256"]
        row = {"messageId": "message1", "attachmentSha256": digest, "grossAmount": None, "documentDate": None}
        archive.review({"threadId": "thread01", "evidenceHash": manifest["evidenceHash"], "coverage": "partial",
                        "invoices": [row, {**row, "grossAmount": 25}, {**row, "grossAmount": 35}]})
        invoice = module.load(self.root / "invoice-register.json")["invoices"][0]
        self.assertEqual(invoice["grossAmount"], 25)
        self.assertEqual(invoice["conflicts"], [{"field": "grossAmount", "values": [25, 35]}])
        self.assertIn("divergentes", (self.root / "index.html").read_text(encoding="utf-8"))

    def test_cents_are_exact_or_absent_never_rounded_or_guessed(self):
        for reading, expected in [(120, 12000), (127.5, 12750), ("142.50", 14250), ("1 938,50 $", 193850),
                                  ("1,938.50", 193850), ("1.938,50 CAD", 193850), ("-25,00", -2500),
                                  ("1,938", None), ("12.345", None), (12.345, None), ("1,2,3", None),
                                  ("inconnu", None), (None, None), (True, None), ("environ cent", None)]:
            self.assertEqual(module.cents(reading), expected, reading)

    def invoice_archive(self, invoices):
        invoice = base64.urlsafe_b64encode(b"Dental invoice").decode()
        unrelated = base64.urlsafe_b64encode(b"Private letter, not an invoice").decode()
        archive = module.Archive(self.root / "archive", lambda _: {"messages": [{"id": "message1", "body": "Private correspondence",
            "payload": {"parts": [{"filename": "invoice.txt", "body": {"data": invoice}},
                                  {"filename": "letter.txt", "body": {"data": unrelated}}]}}]})
        manifest = archive.collect_thread("thread01")
        digest = manifest["messages"][0]["attachments"][0]["sha256"]
        archive.review({"threadId": "thread01", "evidenceHash": manifest["evidenceHash"], "coverage": "partial",
                        "invoices": [{"messageId": "message1", "attachmentSha256": digest, **row} for row in invoices]})
        return archive, digest

    def test_register_gives_accounting_iso_currency_cents_and_unexplained_difference(self):
        archive, _ = self.invoice_archive([{"documentNumber": "A1", "grossAmount": 142.5, "patientPaid": 62, "currency": "$"}])
        register = module.load(archive.root / "invoice-register.json")
        self.assertEqual(register["schemaVersion"], 2)
        self.assertFalse(register["complete"])
        self.assertEqual(register["coverage"]["collectedThreads"], 1)
        row = register["invoices"][0]
        self.assertEqual((row["currency"], row["currencyAssumed"], row["currencyAsRead"]), ("CAD", True, "$"))
        self.assertEqual((row["grossAmountCents"], row["patientPaidCents"], row["insurancePaidCents"]), (14250, 6200, None))
        # The gap is reported, never attributed to an insurer, a debt or the other parent.
        self.assertEqual(row["unexplainedDifferenceCents"], 8050)
        self.assertEqual(row["grossAmount"], 142.5)
        self.assertIn("Écart non expliqué : 80,50 CAD (présumé)", (archive.root / "index.html").read_text(encoding="utf-8"))

    def test_printed_insurer_payment_explains_the_difference_and_conflicting_readings_stay_visible(self):
        archive, _ = self.invoice_archive([
            {"grossAmount": "142,50", "patientPaid": "62,00", "insurancePaid": "80,50", "insurer": "CGI", "currency": "CAD"},
            {"insurancePaid": "70,50", "grossAmount": "cent quarante"}])
        row = module.load(archive.root / "invoice-register.json")["invoices"][0]
        self.assertEqual((row["currency"], row["insurancePaidCents"]), ("CAD", 8050))
        self.assertNotIn("currencyAssumed", row)
        self.assertNotIn("unexplainedDifferenceCents", row)
        self.assertIn({"field": "insurancePaid", "values": ["80,50", "70,50"]}, row["conflicts"])
        self.assertIn({"field": "grossAmount", "values": ["142,50", "cent quarante"]}, row["conflicts"])
        unknown_currency = module.accounting_row({"currency": "pesos", "grossAmount": "cent"})
        self.assertEqual((unknown_currency["currency"], unknown_currency["unreadableAmounts"]), (None, ["grossAmount"]))

    def test_accounting_bundle_is_off_by_default_and_never_carries_correspondence(self):
        archive, digest = self.invoice_archive([{"grossAmount": 130, "patientPaid": 130, "currency": "$"}])
        target = self.root / "datalake" / "secretary"
        self.assertEqual(archive.publish(), {"enabled": False})
        self.assertFalse(target.exists())
        result = archive.publish(target)
        self.assertEqual((result["ok"], result["files"]), (True, 1))
        published = sorted(str(file.relative_to(target)).replace("\\", "/") for file in target.rglob("*") if file.is_file())
        self.assertEqual(published, ["bundle-manifest.json", f"files/{digest}.txt", "invoice-register.json"])
        bundle = module.load(target / "bundle-manifest.json")
        self.assertEqual(bundle["files"][0]["sha256"], digest)
        self.assertEqual(bundle["registerSha256"], module.sha((target / "invoice-register.json").read_bytes()))
        self.assertNotIn("Private", "".join(file.read_text(encoding="utf-8") for file in target.rglob("*") if file.is_file()))
        # Once the owner chose a directory, every register update republishes itself.
        (target / "invoice-register.json").unlink()
        archive.export()
        self.assertTrue((target / "invoice-register.json").exists())
        self.assertTrue(archive.status()["accountingExport"]["ok"])

    def test_unreachable_accounting_share_is_reported_without_blocking_the_review(self):
        archive, _ = self.invoice_archive([{"grossAmount": 130}])
        blocker = self.root / "not-a-directory"
        blocker.write_text("file")
        self.assertFalse(archive.publish(blocker / "secretary")["ok"])
        archive.export()
        self.assertFalse(archive.status()["accountingExport"]["ok"])
        self.assertEqual(len(module.load(archive.root / "invoice-register.json")["invoices"]), 1)

    def scan_archive(self):
        scan = base64.urlsafe_b64encode(b"\x89PNG photo of a receipt").decode()
        self.payload = {"thread": {"messages": [{"id": "message1", "body": "Voici le recu", "internalDate": "1",
            "payload": {"parts": [{"filename": "recu.PNG", "mimeType": "image/png", "body": {"data": scan}}]}}]}}
        archive = module.Archive(self.root, lambda _: self.payload)
        manifest = archive.collect_thread("thread01")
        digest = manifest["messages"][0]["attachments"][0]["sha256"]
        archive.review({"threadId": "thread01", "evidenceHash": manifest["evidenceHash"], "coverage": "partial",
                        "invoices": [{"messageId": "message1", "attachmentSha256": digest, "documentNumber": "R1"}]})
        for scope in module.QUERIES:
            module.save(self.root / f"inventory-{scope}.json", {"complete": True, "messages": {}, "headCheckedEpoch": module.time.time()})
        return archive, manifest, digest

    def test_ocr_lets_the_model_read_a_scan_without_accepting_it_or_losing_findings(self):
        archive, before, digest = self.scan_archive()
        self.assertEqual(before["messages"][0]["attachments"][0]["status"], "needs_visual_review")
        with mock.patch.object(module, "ocr_text", return_value="RECU R1 Synthetic dental clinic\nTotal 130,00 $ paye comptant") as reader:
            result = archive.ocr_pending(5)
            self.assertEqual((result["read"][0]["sha256"], result["remaining"]), (digest, 0))
            self.assertEqual(archive.ocr_pending(5)["read"], [])
            reader.assert_called_once()
        after = module.load(self.root / "threads/thread01/manifest.json")
        item = after["messages"][0]["attachments"][0]
        self.assertEqual((item["status"], item["ocrAttempted"]), ("ocr_text_extracted", True))
        self.assertTrue(item["textPath"].endswith(".png.ocr.txt"))
        self.assertNotEqual(after["evidenceHash"], before["evidenceHash"])
        self.assertEqual(after["retrievedAt"], before["retrievedAt"])
        # Machine reading is not visual acceptance, and the earlier invoice row never disappears.
        self.assertEqual((archive.status()["needsVisualReview"], archive.status()["ocrRead"]), (1, 1))
        invoice = module.load(self.root / "invoice-register.json")["invoices"][0]
        self.assertEqual((invoice["documentNumber"], invoice["attachmentExtraction"]), ("R1", "ocr_text_extracted"))
        with mock.patch.object(archive, "collect", return_value={"errors": []}):
            pages = []
            while (step := archive.native_next())["outcome"] == "ready":
                pages.append(step["page"])
                saved = archive.native_record({"pageId": step["page"]["pageId"], "summary": "Lu"})
            self.assertIn("Total 130,00 $", "".join(page["externalUntrustedContent"] for page in pages))
            self.assertEqual(saved["coverage"], "partial")

    def test_illegible_or_unavailable_ocr_never_loops_or_invents_text(self):
        archive, before, _ = self.scan_archive()
        with mock.patch.object(module, "ocr_text", return_value=None):
            self.assertFalse(archive.ocr_pending(5)["ocrAvailable"])
        self.assertEqual(module.load(self.root / "threads/thread01/manifest.json"), before)
        with mock.patch.object(module, "ocr_text", return_value="  \n") as reader:
            archive.ocr_pending(5)
            archive.ocr_pending(5)
            reader.assert_called_once()
        item = module.load(self.root / "threads/thread01/manifest.json")["messages"][0]["attachments"][0]
        self.assertEqual((item["status"], item["ocrAttempted"], item["textPath"]), ("needs_visual_review", True, None))

    def test_same_scan_forwarded_later_reuses_its_reading_and_stays_machine_read(self):
        archive, _, digest = self.scan_archive()
        with mock.patch.object(module, "ocr_text", return_value="RECU R1 Synthetic dental clinic, total 130,00 $") as reader:
            archive.ocr_pending(5)
            forwarded = dict(self.payload["thread"]["messages"][0], id="message2", internalDate="2")
            self.payload["thread"]["messages"].append(forwarded)
            later = archive.collect_thread("thread01")["messages"][1]["attachments"][0]
            # The reading belongs to the file: the new occurrence has it at once, still as OCR.
            self.assertEqual((later["sha256"], later["status"]), (digest, "ocr_text_extracted"))
            self.assertEqual(archive.ocr_pending(5)["read"], [])
            reader.assert_called_once()
        statuses = [m["attachments"][0]["status"] for m in module.load(self.root / "threads/thread01/manifest.json")["messages"]]
        self.assertEqual(statuses, ["ocr_text_extracted", "ocr_text_extracted"])
        self.assertEqual(archive.status()["uniqueFiles"], 1)

    def test_files_archived_before_download_receipts_are_kept_without_asking_gmail_again(self):
        payload = {"thread": {"messages": [{"id": "message1", "body": "x", "payload": {"parts": [
            {"partId": "1", "filename": "scan.jpg", "body": {"attachmentId": "opaque", "size": 10}}]}}]}}
        downloads = []
        def run(command):
            if command[:2] == ["gmail", "attachment"]:
                downloads.append(command)
                Path(command[-1].removeprefix("--out=")).write_bytes(b"scan bytes")
            return payload
        archive = module.Archive(self.root, run)
        archive.collect_thread("thread01")
        for receipt in (self.root / "download-receipts").glob("*.json"):
            receipt.unlink()  # the shape of everything archived before receipts existed
        with mock.patch.object(module, "ocr_text", return_value="RECU R1 Synthetic healthcare clinic, total 130,00 $ paid in full"):
            self.assertEqual(len(archive.ocr_pending(5)["read"]), 1)
        self.assertEqual(len(downloads), 1)
        item = module.load(self.root / "threads/thread01/manifest.json")["messages"][0]["attachments"][0]
        self.assertEqual(item["status"], "ocr_text_extracted")
        # The adopted receipt records the stored original only; the reading stays a separate layer.
        receipt = module.load(next((self.root / "download-receipts").glob("*.json")))["attachment"]
        self.assertEqual((receipt["status"], receipt["textPath"]), ("needs_visual_review", None))

    def test_page_issued_before_the_evidence_changed_is_reissued_not_deadlocked(self):
        archive, _, _ = self.scan_archive()
        with mock.patch.object(archive, "collect", return_value={"errors": []}), \
             mock.patch.object(module, "ocr_text", return_value=None):
            issued = archive.native_next()["page"]
        with mock.patch.object(module, "ocr_text", return_value="RECU R1 Synthetic dental clinic, total 130,00 $"):
            archive.ocr_pending(5)  # out-of-band backfill while a page is issued
        with mock.patch.object(archive, "collect", return_value={"errors": []}):
            fresh = archive.native_next()["page"]
            self.assertEqual(fresh["pageId"], issued["pageId"])
            self.assertNotEqual(fresh["evidenceHash"], issued["evidenceHash"])
            self.assertTrue(archive.native_record({"pageId": fresh["pageId"], "summary": "Lu"})["saved"])

    def test_pdf_ocr_shares_one_deadline_across_rendering_and_pages(self):
        timeouts = []
        def run(command, **options):
            timeouts.append(options["timeout"])
            if command[0] == "pdftoppm":
                Path(command[-1] + "-01.png").touch()
                Path(command[-1] + "-02.png").touch()
            return module.subprocess.CompletedProcess(command, 0, stdout=b"Synthetic OCR text")
        with mock.patch.object(module.shutil, "which", return_value="synthetic-command"), \
             mock.patch.object(module.time, "monotonic", side_effect=[0, 0, 120, 150]), \
             mock.patch.object(module.subprocess, "run", side_effect=run):
            with self.assertRaises(module.subprocess.TimeoutExpired):
                module.ocr_text(self.root / "synthetic.pdf")
        self.assertEqual(timeouts, [120, 30])

    def test_pdf_ocr_without_renderer_stays_unavailable(self):
        with mock.patch.object(module.shutil, "which", side_effect=lambda name: name if name == "tesseract" else None), \
             mock.patch.object(module.subprocess, "run") as run:
            self.assertIsNone(module.ocr_text(self.root / "synthetic.pdf"))
            run.assert_not_called()

    def test_docx_native_text_is_read_without_ocr(self):
        import io, zipfile
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as document:
            document.writestr("word/document.xml", "<w:document><w:p><w:t>Entente &amp; frais</w:t></w:p><w:p><w:t>50 %</w:t></w:p></w:document>")
        data = base64.urlsafe_b64encode(buffer.getvalue()).decode()
        archive = module.Archive(self.root, lambda _: {"messages": [{"id": "message1", "body": "x",
            "payload": {"parts": [{"filename": "entente.docx", "body": {"data": data}}]}}]})
        item = archive.collect_thread("thread01")["messages"][0]["attachments"][0]
        self.assertEqual(item["status"], "text_extracted")
        self.assertEqual((self.root / item["textPath"]).read_text(encoding="utf-8").split(), ["Entente", "&", "frais", "50", "%"])

    def test_interrupted_attachment_is_not_accepted_on_retry(self):
        archive = module.Archive(self.root, lambda _: {})
        staging = self.root / "downloads/message1-0.pdf"
        staging.parent.mkdir()
        staging.write_bytes(b"partial")
        with self.assertRaisesRegex(ValueError, "size"):
            archive.attachment("message1", {"filename": "invoice.pdf", "body": {"size": 100, "attachmentId": "opaque"}}, 0)
        self.assertFalse(staging.exists())

    def test_completed_download_survives_interruption_later_in_a_large_thread(self):
        calls = []
        def run(command):
            calls.append(command[3])
            if command[3] == "second":
                raise RuntimeError("interrupted next attachment")
            Path(command[-1].removeprefix("--out=")).write_bytes(b"data")
        archive = module.Archive(self.root, run)
        first = {"filename": "document.bin", "body": {"attachmentId": "first", "size": 4}}
        second = {"filename": "document2.bin", "body": {"attachmentId": "second", "size": 4}}
        saved = archive.attachment("message1", first, 1)
        with self.assertRaisesRegex(RuntimeError, "interrupted"):
            archive.attachment("message1", second, 2)
        self.assertEqual(archive.attachment("message1", first, 1), saved)
        self.assertEqual(calls.count("first"), 1)

    def test_native_progress_resumes_merges_receipts_and_does_not_skip_new_reply(self):
        payload = {"thread": {"messages": [{"id": "message1", "body": "A" * 11000,
                   "headers": {"subject": "Unrelated subject", "dkim-signature": "transport noise"}}]}}
        archive = module.Archive(self.root, lambda _: payload)
        manifest = archive.collect_thread("thread01")
        archive.review({"threadId": "thread01", "evidenceHash": manifest["evidenceHash"], "coverage": "partial",
                        "actions": [{"messageId": "message1", "text": "Existing task", "personalTaskId": "0699"}]})
        for scope in module.QUERIES:
            module.save(self.root / f"inventory-{scope}.json", {"complete": True, "messages": {}, "headCheckedEpoch": module.time.time()})
        with mock.patch.object(archive, "collect", return_value={"errors": []}):
            page = archive.native_next()["page"]
            self.assertEqual(archive.native_next()["page"]["pageId"], page["pageId"])
            self.assertNotIn("dkim-signature", page["headers"])
            with self.assertRaisesRegex(ValueError, "issued messageId"):
                archive.native_record({"pageId": page["pageId"], "summary": "Read", "actions": [{"messageId": "invented"}]})
            self.assertEqual(archive.native_status()["reviewedPages"], 0)
            result = archive.native_record({"pageId": page["pageId"], "summary": "First page read", "actions": []})
            self.assertEqual(result["progress"]["pendingTextPages"], 2)
            second = archive.native_next()["page"]
            self.assertEqual(second["offset"], 4000)
            archive.native_record({"pageId": second["pageId"], "summary": "Continuation read"})
            third = archive.native_next()["page"]
            archive.native_record({"pageId": third["pageId"], "summary": "Last page read"})
            self.assertEqual(archive.native_status()["pendingTextPages"], 0)
            self.assertEqual(module.load(self.root / "reviews/thread01.json")["actions"][0]["personalTaskId"], "0699")
            payload["thread"]["messages"].append({"id": "message2", "body": "A new reply", "headers": {}, "internalDate": "2"})
            archive.collect_thread("thread01")
            self.assertEqual(archive.native_next()["page"]["messageId"], "message2")
            self.assertEqual(archive.native_status()["pendingTextPages"], 1)


if __name__ == "__main__":
    unittest.main()
