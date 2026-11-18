"""Synthetic provider only; exact live source and native read-only seam."""
import base64
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import mailbox_source as native
import secretary_mail_desk as desk
from gmail_provider import GmailProviderError

MESSAGE, THREAD = '1234567890abcdef', '1234567890abcdea'
RAW = b'From: synthetic@example.invalid\r\n\r\nSynthetic private body\r\n'
SHA = hashlib.sha256(RAW).hexdigest()
REQUEST = '12345678-1234-4234-8234-123456789abc'


def row():
    return {'id': MESSAGE, 'threadId': THREAD, 'internalDate': '1234567890000',
            'historyId': '99999999999999999999', 'labelIds': ['UNREAD', 'INBOX'],
            'raw': base64.urlsafe_b64encode(RAW).decode(), 'sizeEstimate': 999}


class MailboxSourceTest(unittest.TestCase):
    def observe(self, payload=None, error=None, **overrides):
        read = Mock(side_effect=error, return_value=row() if payload is None else payload)
        args = dict(message_id=MESSAGE, thread_id=THREAD, source_sha256=SHA, request_id=REQUEST,
                    account_selection='synthetic@example.invalid', read=read)
        args.update(overrides)
        value = native.probe(**args)
        read.assert_called_once_with(['gmail', 'get', MESSAGE, '--format=raw'])
        return value

    def test_exact_source_ignores_size_estimate_and_never_exports_content_or_account(self):
        value = self.observe()
        self.assertEqual(value['current']['raw'], {'sha256': SHA, 'bytes': len(RAW)})
        self.assertEqual(value['current']['labelIds'], ['INBOX', 'UNREAD'])
        self.assertEqual(value['current']['historyId'], '99999999999999999999')
        self.assertEqual((value['status'], value['mailboxEffects'], value['approvalBound']), ('present', 0, False))
        self.assertNotIn('Synthetic private', json.dumps(value))
        self.assertNotIn('synthetic@example', json.dumps(value))

    def test_wrapper_padding_and_exact_byte_hash(self):
        for raw in (base64.urlsafe_b64encode(RAW).decode(), base64.urlsafe_b64encode(RAW).decode().rstrip('=')):
            self.assertEqual(self.observe({'message': {**row(), 'raw': raw}})['current']['raw']['sha256'], SHA)
        self.assertEqual(self.observe(account_selection='another@example.invalid')['current']['raw']['sha256'], SHA)

    def test_only_typed_not_found_is_absence(self):
        value = self.observe(error=GmailProviderError('gmail.get', 1, 'not_found'))
        self.assertEqual((value['status'], value['current']), ('not_found', None))
        for kind in ('authorization', 'transient', 'unknown'):
            with self.subTest(kind=kind), self.assertRaises(native.MailboxSourceError):
                self.observe(error=GmailProviderError('gmail.get', 1, kind))

    def test_malformed_or_different_identity_never_becomes_absence(self):
        bad = [('id', THREAD), ('threadId', False), ('threadId', 'query'), ('raw', ''), ('raw', 'YR=='),
               ('raw', 'YQ='), ('raw', 'YQ==='), ('raw', 'YQ==\n'), ('raw', '++++'), ('raw', 'Z'),
               ('labelIds', ['INBOX', 'INBOX']), ('labelIds', ['x\n']), ('labelIds', [False]),
               ('labelIds', ['L' + str(i) for i in range(257)]), ('labelIds', None),
               ('historyId', True), ('historyId', '01'), ('historyId', 1.0), ('historyId', '1' * 33),
               ('internalDate', -1), ('internalDate', '253402300800000'), ('internalDate', False)]
        for key, value in bad:
            with self.subTest(key=key, value=str(value)[:40]), self.assertRaises(native.MailboxSourceError):
                self.observe({**row(), key: value})
        for value in ([], 'notFound', {}, {'message': None}):
            with self.subTest(value=value), self.assertRaises(native.MailboxSourceError):
                self.observe(value)

    def test_source_thread_label_changes_are_observed_without_mutation(self):
        other = {**row(), 'threadId': 'abcdef1234567890', 'raw': 'YQ==', 'labelIds': ['TRASH', 'DRAFT']}
        observed = self.observe(other)['current']
        self.assertEqual(observed['labelIds'], ['DRAFT', 'TRASH'])
        self.assertNotEqual(observed['raw']['sha256'], SHA)
        self.assertEqual(observed['threadId'], other['threadId'])

    def test_byte_capacity_and_integer_metadata(self):
        with patch.object(native, 'MAX_BYTES', 3):
            accepted = self.observe({**row(), 'raw': 'YWJj', 'historyId': 3, 'internalDate': 0})
            self.assertEqual(accepted['current']['raw']['bytes'], 3)
            self.assertEqual(accepted['current']['internalDate'], '0')
            with self.assertRaises(native.MailboxSourceError):
                self.observe({**row(), 'raw': 'YWJjZA'})

    def test_invalid_input_refuses_before_provider(self):
        for key, value in [('message_id', MESSAGE + ';id'), ('thread_id', False), ('source_sha256', SHA.upper()),
                           ('request_id', 'anything'), ('account_selection', ''), ('account_selection', 'x' * 1025)]:
            read = Mock()
            with self.subTest(key=key), self.assertRaises(native.MailboxSourceError):
                self.observe(read=read, **{key: value})
            read.assert_not_called()

    def invoke(self, response=None, returncode=0, stderr=''):
        out = io.StringIO()
        with tempfile.TemporaryDirectory() as root:
            secret = Path(root) / 'keyring'; secret.write_text('synthetic-key')
            done = subprocess.CompletedProcess([], returncode, json.dumps(row() if response is None else response), stderr)
            with patch.object(desk, 'native_settings', return_value={}), \
                    patch.object(desk.subprocess, 'run', return_value=done) as runner, patch('sys.stdout', out):
                desk.main(['--account', 'synthetic@example.invalid', '--keyring-password-file', str(secret),
                           '--gog', 'synthetic-gog', 'mailbox-scope', '--message', MESSAGE, '--thread', THREAD,
                           '--sha256', SHA, '--request-id', REQUEST])
            self.assertEqual(secret.read_text(), 'synthetic-key')
        return json.loads(out.getvalue()), runner

    def test_native_cli_uses_only_exact_readonly_get(self):
        value, runner = self.invoke()
        self.assertEqual(value['status'], 'success')
        self.assertEqual(runner.call_count, 1)
        cmd = runner.call_args.args[0]
        self.assertEqual(cmd, ['synthetic-gog', '--readonly', '--gmail-no-send', '--no-input', '--json',
                              '--enable-commands-exact=gmail.get', '--account=synthetic@example.invalid',
                              'gmail', 'get', MESSAGE, '--format=raw'])
        self.assertEqual(runner.call_args.kwargs['timeout'], 25)

    def test_native_cli_distinguishes_404_from_auth_transient_unknown(self):
        for stderr in ('404 not found', '403 permission denied private-account', '503 unavailable private-account', 'unknown private-account'):
            value, _ = self.invoke(returncode=1, stderr=stderr)
            if stderr.startswith('404'):
                self.assertEqual(value['data']['status'], 'not_found')
            else:
                self.assertEqual(value['status'], 'error')
                self.assertNotIn('data', value)
            self.assertNotIn('private-account', json.dumps(value))

    def test_missing_native_configuration_has_no_provider_call(self):
        out = io.StringIO()
        with patch.dict('os.environ', {}, clear=True), patch.object(desk, 'native_settings', return_value={}), \
                patch.object(desk, 'run_gog') as read, patch('sys.stdout', out):
            desk.main(['mailbox-scope', '--message', MESSAGE, '--thread', THREAD, '--sha256', SHA, '--request-id', REQUEST])
        self.assertEqual(json.loads(out.getvalue())['code'], 'SECRETARY_MAIL_CONFIGURATION_INVALID')
        read.assert_not_called()

    def test_native_provider_ambiguous_json_or_timeout_cannot_qualify_absence(self):
        from argparse import Namespace
        args = Namespace(gog='synthetic-gog', account='synthetic@example.invalid', keyring_password_file='/unused', timeout_seconds=25)
        for stdout in ('{"id":"first","id":"second"}', '{"unknown":NaN}', 'x' * (24 * 1024 * 1024 + 1)):
            with self.subTest(size=len(stdout)), patch.object(desk, 'gmail_environment', return_value={}), \
                    patch.object(desk.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, stdout, '')):
                with self.assertRaises(desk.MailDeskError):
                    desk.run_gog(args, 'gmail.get', ['gmail', 'get', MESSAGE, '--format=raw'], typed_provider_errors=True)
        with patch.object(desk, 'gmail_environment', return_value={}), \
                patch.object(desk.subprocess, 'run', side_effect=subprocess.TimeoutExpired('private-content', 25)):
            with self.assertRaises(desk.MailDeskError) as error:
                desk.run_gog(args, 'gmail.get', ['gmail', 'get', MESSAGE, '--format=raw'], typed_provider_errors=True)
        self.assertNotIn('private-content', str(error.exception))


if __name__ == '__main__':
    unittest.main()
