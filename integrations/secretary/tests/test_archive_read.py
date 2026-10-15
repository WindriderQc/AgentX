from email.message import EmailMessage
from email import policy
import contextlib
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from archive_read import ArchiveReadError, read_original
from evidence_store import save


class ArchivedOriginalReadingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        message = EmailMessage()
        message['Subject'] = 'Synthetic archived source'
        message['From'] = 'synthetic@example.invalid'
        message.set_content('Synthetic original é 👋\n' * 3000)
        message.add_attachment(b'Synthetic attachment', maintype='application', subtype='octet-stream', filename='saved.bin')
        data = message.as_bytes(policy=policy.SMTP)
        self.sha = hashlib.sha256(data).hexdigest()
        self.file = self.root / 'raw/source.eml'
        self.file.parent.mkdir()
        self.file.write_bytes(data)
        save(self.root / 'raw-receipts/message1.json', {'messageId': 'message1', 'threadId': 'thread01',
             'sha256': self.sha, 'bytes': len(data), 'path': 'raw/source.eml'})

    def test_reads_every_page_of_the_verified_original_without_a_provider(self):
        with mock.patch('subprocess.run', side_effect=AssertionError('Provider must not run')):
            page = read_original(self.root, 'message1', self.sha)
            parts = [page['body']]
            while page['nextOffset'] is not None:
                page = read_original(self.root, 'message1', self.sha, page['nextOffset'])
                parts.append(page['body'])
        self.assertEqual(''.join(parts).count('Synthetic original é 👋'), 3000)
        self.assertEqual(page['attachmentCount'], 1)
        self.assertFalse(page['attachmentContentIncluded'])
        self.assertNotIn('Synthetic attachment', ''.join(parts))

    def test_corruption_and_a_wrong_source_revision_refuse_instead_of_falling_back_to_gmail(self):
        with self.assertRaises(ArchiveReadError):
            read_original(self.root, 'message1', '0' * 64)
        self.file.write_bytes(b'Corrupt source')
        with self.assertRaisesRegex(ArchiveReadError, 'preservation receipt'):
            read_original(self.root, 'message1', self.sha)

    def test_invalid_ids_paths_and_offsets_never_read_another_file(self):
        for mid in ('../../secret', 'short'):
            with self.assertRaises(ArchiveReadError):
                read_original(self.root, mid, self.sha)
        with self.assertRaises(ArchiveReadError):
            read_original(self.root, 'message1', self.sha, -1)
        save(self.root / 'raw-receipts/message1.json', {'messageId': 'message1', 'sha256': self.sha,
             'bytes': self.file.stat().st_size, 'path': '../outside.eml'})
        with self.assertRaises(ArchiveReadError):
            read_original(self.root, 'message1', self.sha)

    def test_host_entry_reads_the_archive_without_gmail_authorization(self):
        import secretary_mail_desk
        output = io.StringIO()
        with mock.patch.object(secretary_mail_desk, 'native_settings', return_value={}), \
                mock.patch('subprocess.run', side_effect=AssertionError('Provider must not run')), \
                contextlib.redirect_stdout(output):
            result = secretary_mail_desk.main(['--evidence-root', str(self.root), 'archived',
                '--message', 'message1', '--sha256', self.sha])
        self.assertEqual(result, 0)
        payload = json.loads(output.getvalue())
        self.assertEqual(payload['status'], 'success')
        self.assertTrue(payload['data']['bodyReadable'])

    def preserve(self, message):
        data = message.as_bytes(policy=policy.SMTP)
        self.sha = hashlib.sha256(data).hexdigest()
        self.file.write_bytes(data)
        save(self.root / 'raw-receipts/message1.json', {'messageId': 'message1', 'threadId': 'thread01',
             'sha256': self.sha, 'bytes': len(data), 'path': 'raw/source.eml'})

    def test_plain_text_does_not_hide_a_different_html_action_and_html_never_executes(self):
        message = EmailMessage(); message.set_content('Synthetic plain version has no request.')
        message.add_alternative('<p>Please return the synthetic form by Friday.</p><script>steal()</script>', subtype='html')
        self.preserve(message)
        page = read_original(self.root, 'message1', self.sha)
        self.assertEqual(len(page['bodyRepresentations']), 2)
        self.assertIn('multiple_text_representations', page['readingWarnings'])
        html = next(p for p in page['bodyRepresentations'] if p['mimeType'] == 'text/html')
        other = read_original(self.root, 'message1', self.sha, part_index=html['partIndex'])
        self.assertIn('return the synthetic form', other['body'])
        self.assertNotIn('steal()', other['body'])
        self.assertEqual(other['selectedPartIndex'], html['partIndex'])
        self.assertEqual(other['readerContract'], 'secretary.archive-reader/v2')

    def test_part_selection_and_pagination_stay_on_the_pinned_representation(self):
        message = EmailMessage(); message.set_content('Short plain')
        message.add_alternative('<p>' + 'Long synthetic HTML é ' * 2000 + '</p>', subtype='html')
        self.preserve(message)
        first = read_original(self.root, 'message1', self.sha)
        html = next(p for p in first['bodyRepresentations'] if p['mimeType'] == 'text/html')
        page = read_original(self.root, 'message1', self.sha, part_index=html['partIndex'])
        pieces = [page['body']]
        while page['nextOffset'] is not None:
            page = read_original(self.root, 'message1', self.sha, page['nextOffset'], part_index=html['partIndex'])
            pieces.append(page['body'])
        self.assertEqual(''.join(pieces).count('Long synthetic HTML é'), 2000)
        for part in (-1, 4096, True, 123):
            with self.assertRaises(ArchiveReadError): read_original(self.root, 'message1', self.sha, part_index=part)

    def test_nested_mail_and_unnamed_documents_are_not_misattributed_as_outer_body(self):
        message = EmailMessage(); message.set_content('Outer synthetic message')
        nested = EmailMessage(); nested.set_content('A different author inside an attachment')
        message.add_attachment(nested)
        message.add_attachment(b'BEGIN:VCALENDAR\nEND:VCALENDAR', maintype='text', subtype='calendar')
        self.preserve(message)
        page = read_original(self.root, 'message1', self.sha)
        self.assertEqual(len(page['bodyRepresentations']), 1)
        self.assertNotIn('different author', page['body'])
        self.assertEqual({p['mimeType'] for p in page['attachments']}, {'message/rfc822', 'text/calendar'})

    def test_an_unreadable_alternative_remains_visible_instead_of_certifying_whole_message_reading(self):
        data = b'MIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nSynthetic plain\r\n--x\r\nContent-Type: text/html; charset=not-a-charset\r\n\r\n<p>Other information</p>\r\n--x--\r\n'
        self.sha = hashlib.sha256(data).hexdigest(); self.file.write_bytes(data)
        save(self.root / 'raw-receipts/message1.json', {'messageId': 'message1', 'threadId': 'thread01',
             'sha256': self.sha, 'bytes': len(data), 'path': 'raw/source.eml'})
        page = read_original(self.root, 'message1', self.sha)
        self.assertIn('unreadable_text_representation', page['readingWarnings'])
        self.assertEqual(page['bodyCompleteScope'], 'selected-mime-text-part')
