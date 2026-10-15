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
