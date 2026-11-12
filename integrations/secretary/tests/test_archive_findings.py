"""A native recorded inventory is source-bound evidence, never acceptance."""
from contextlib import redirect_stdout
from copy import deepcopy
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import archive_findings as native
import archive_preservation as preservation
import secretary_mail_desk as desk
from history_coverage import content_hash, finding_id

MID, TID, OTHER = 'a' * 16, 'b' * 16, 'c' * 16


@unittest.skipUnless(hasattr(os, 'O_NOFOLLOW') and os.open in os.supports_dir_fd,
                     'Native findings require POSIX no-follow directory descriptors')
class NativeFindingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'archive'; self.root.mkdir()
        self.raw = self.root / 'raw/synthetic.eml'; self.raw.parent.mkdir()
        self.raw.write_bytes(b'Subject: synthetic private original marker\n\nSynthetic private body marker\n')
        self.sha = hashlib.sha256(self.raw.read_bytes()).hexdigest()
        self.request = str(uuid4())
        self.receipt = {'messageId': MID, 'threadId': TID, 'sha256': self.sha,
                        'bytes': self.raw.stat().st_size, 'path': 'raw/synthetic.eml'}
        self.manifest = {'threadId': TID, 'evidenceHash': 'd' * 64, 'messages': [{'id': MID}, {'id': OTHER}]}
        self.review = {'threadId': TID, 'evidenceHash': 'd' * 64,
                       'actions': [{'messageId': MID, 'text': 'Synthetic private action marker'}],
                       'memories': [{'messageId': MID, 'text': 'Synthetic é 🧭 private memory marker'},
                                    {'messageId': OTHER, 'text': 'Unselected private finding marker'}],
                       'deliverables': [], 'invoices': [{'messageId': MID, 'amount': '42.00'}],
                       'unresolved': ['Synthetic private whole-thread question marker']}
        self.receipt_file = self.root / f'raw-receipts/{MID}.json'
        self.manifest_file = self.root / f'threads/{TID}/manifest.json'
        self.review_file = self.root / f'reviews/{TID}.json'
        self.save_all()

    def save(self, file, value):
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(json.dumps(value, ensure_ascii=False))

    def save_all(self):
        for file, value in ((self.receipt_file, self.receipt), (self.manifest_file, self.manifest), (self.review_file, self.review)):
            self.save(file, value)

    def probe(self, **changes):
        fields = {'root': self.root, 'message_id': MID, 'thread_id': TID,
                  'source_sha256': self.sha, 'request_id': self.request, **changes}
        return native.probe(**fields)

    def refused(self, **changes):
        with self.assertRaises(native.FindingsError) as raised:
            self.probe(**changes)
        self.assertNotIn(str(self.root), str(raised.exception))
        self.assertNotIn('private', str(raised.exception))
        return raised.exception

    def test_exact_recorded_ids_match_existing_imports_without_text_or_mutation(self):
        original = {file: file.read_bytes() for file in self.root.rglob('*') if file.is_file()}
        value = self.probe()
        self.assertEqual(value['contract'], 'secretary.archive-findings/v1')
        self.assertEqual(value['requestId'], self.request)
        self.assertEqual(value['scope'], 'recorded-selected-message-findings-and-thread-questions')
        expected = [{'findingId': finding_id(TID, section, item), 'section': section}
                    for section in native.SECTIONS for item in self.review[section] if item['messageId'] == MID]
        self.assertEqual(value['findings'], sorted(expected, key=lambda row: (row['section'], row['findingId'])))
        self.assertEqual(value['threadQuestions'], [{'questionId': content_hash([TID, self.review['unresolved'][0]])}])
        self.assertEqual(value['reviewSha256'], content_hash(self.review))
        self.assertEqual(value['raw'], {'sha256': self.sha, 'bytes': self.raw.stat().st_size})
        self.assertFalse(value['semanticAcceptance']); self.assertFalse(value['executionAllowed'])
        serialized = json.dumps(value)
        for hidden in ('private', str(self.root), 'synthetic.eml', '42.00', OTHER):
            self.assertNotIn(hidden, serialized)
        self.assertEqual({file: file.read_bytes() for file in original}, original)

    def test_empty_but_complete_review_stays_non_accepting(self):
        for section in native.SECTIONS:
            self.review[section] = []
        self.review['unresolved'] = []
        self.save_all()
        value = self.probe()
        self.assertEqual(value['findings'], []); self.assertEqual(value['threadQuestions'], [])
        self.assertFalse(value['semanticAcceptance']); self.assertFalse(value['executionAllowed'])

    def test_metadata_formatting_and_unselected_thread_changes_invalidate_metadata_pin(self):
        first = self.probe()
        self.review_file.write_text(json.dumps(self.review, indent=2, ensure_ascii=False))
        reformatted = self.probe()
        self.assertEqual(first['reviewSha256'], reformatted['reviewSha256'])
        self.assertNotEqual(first['metadataSha256'], reformatted['metadataSha256'])
        self.review['memories'][-1]['text'] = 'Synthetic corrected unselected thread member'
        self.save_all()
        changed = self.probe()
        self.assertEqual(first['findings'], changed['findings'])
        self.assertNotEqual(first['reviewSha256'], changed['reviewSha256'])
        self.assertNotEqual(first['metadataSha256'], changed['metadataSha256'])

    def test_raw_bytes_receipt_and_exact_request_identity_are_required(self):
        for changes in ({'message_id': OTHER}, {'thread_id': 'e' * 16}, {'source_sha256': 'f' * 64},
                        {'message_id': [MID]}, {'source_sha256': [self.sha]}, {'request_id': [self.request]},
                        {'request_id': 'not-a-uuid'}, {'message_id': '../escape'}):
            with self.subTest(changes=changes):
                self.refused(**changes)
        self.raw.write_bytes(b'Synthetic corrupted original')
        self.refused()

    def test_manifest_and_receipt_ambiguities_refuse(self):
        baseline = deepcopy(self.manifest)
        for messages in ([{'id': MID}, {'id': MID}], [{'id': OTHER}], [{'id': [MID]}],
                         [{'id': MID, 'threadId': 'e' * 16}], ['malformed'], []):
            with self.subTest(messages=messages):
                self.manifest = {**baseline, 'messages': messages}; self.save_all(); self.refused()
        self.manifest = baseline
        for change in ({'messageId': OTHER}, {'threadId': 'e' * 16}, {'bytes': True}, {'sha256': 'f' * 64}, {'path': '../outside'}):
            old = dict(self.receipt)
            self.receipt.update(change); self.save_all(); self.refused(); self.receipt = old

    def test_missing_stale_incomplete_or_malformed_review_is_never_an_empty_success(self):
        original = deepcopy(self.review)
        cases = [{'threadId': OTHER}, {'evidenceHash': 'e' * 64}, {'actions': None}, {'memories': {}},
                 {'deliverables': [False]}, {'invoices': [{'messageId': 'e' * 16}]},
                 {'actions': [{'messageId': [MID]}]}, {'unresolved': None}, {'unresolved': ['']}, {'unresolved': [True]}]
        for change in cases:
            with self.subTest(change=change):
                self.review = {**original, **change}; self.save_all(); self.refused()
        self.review = original
        for key in (*native.SECTIONS, 'unresolved', 'threadId', 'evidenceHash'):
            with self.subTest(missing=key):
                value = dict(original); del value[key]; self.save(self.review_file, value); self.refused()
        self.review_file.unlink(); self.refused()

    def test_duplicate_keys_nonfinite_numbers_and_ambiguous_duplicates_refuse(self):
        original = self.review_file.read_bytes()
        for raw in (original[:-1] + b',"actions":[]}', original[:-1] + b',"extra":NaN}',
                    original[:-1] + b',"extra":Infinity}', original[:-1] + b',"extra":1e999}', b'[]'):
            with self.subTest(raw=raw[-40:]):
                self.review_file.write_bytes(raw); self.refused()
        self.review['actions'].append(dict(self.review['actions'][0])); self.save_all(); self.refused()
        self.review['actions'].pop()
        self.review['unresolved'] *= 2; self.save_all(); self.refused()

    def test_selected_and_question_caps_refuse_without_truncation(self):
        self.review['actions'] = [{'messageId': MID, 'text': f'Synthetic finding {number}'} for number in range(257)]
        self.save_all(); self.assertEqual(self.refused().status, 413)
        self.review['actions'] = []
        self.review['unresolved'] = [f'Synthetic thread question {number}' for number in range(129)]
        self.save_all(); self.assertEqual(self.refused().status, 413)

    def test_shared_io_byte_capacity_includes_all_metadata_and_original(self):
        with patch.object(preservation, 'MAX_BYTES', 50):
            self.assertEqual(self.refused().status, 413)

    def test_symlink_paths_and_fifo_are_refused_without_reading_outside_root(self):
        old = self.raw.read_bytes()
        outside = Path(self.temp.name) / 'outside'; outside.write_bytes(old)
        self.raw.unlink(); self.raw.symlink_to(outside); self.refused()
        self.raw.unlink(); os.mkfifo(self.raw); self.refused()
        self.raw.unlink(); self.raw.write_bytes(old)
        original = self.review_file.read_bytes(); self.review_file.unlink()
        outside.write_bytes(original); self.review_file.symlink_to(outside); self.refused()

    def test_late_changes_to_every_opened_file_and_replaced_metadata_are_refused(self):
        finish = preservation.SourceFiles.finish
        for file in (self.raw, self.receipt_file, self.manifest_file, self.review_file):
            original = file.read_bytes()
            def changed(files, file=file):
                file.write_bytes(file.read_bytes() + b' ')
                return finish(files)
            with self.subTest(file=file.name), patch.object(preservation.SourceFiles, 'finish', changed):
                self.refused()
            file.write_bytes(original)
        def replaced(files):
            swap = self.review_file.with_suffix('.replacement'); swap.write_bytes(self.review_file.read_bytes())
            os.replace(swap, self.review_file)
            return finish(files)
        with patch.object(preservation.SourceFiles, 'finish', replaced):
            self.refused()

    def test_no_descriptor_leak_on_success_or_failure(self):
        before = len(os.listdir('/proc/self/fd'))
        for _ in range(10):
            self.probe()
        self.raw.write_bytes(b'Synthetic bad bytes')
        for _ in range(10):
            self.refused()
        self.assertEqual(len(os.listdir('/proc/self/fd')), before)

    def test_cli_needs_no_gmail_account_keyring_or_provider(self):
        args = ['--evidence-root', str(self.root), 'findings', '--message', MID, '--thread', TID,
                '--sha256', self.sha, '--request-id', self.request]
        with patch.object(desk, 'native_settings', return_value={}), patch.dict(os.environ, {}, clear=True), \
                patch.object(desk, 'run_gog', side_effect=AssertionError('No provider call')) as provider, \
                redirect_stdout(io.StringIO()) as out:
            self.assertEqual(desk.main(args), 0)
        self.assertEqual(json.loads(out.getvalue())['data'], self.probe())
        provider.assert_not_called()
        process = subprocess.run([sys.executable, desk.__file__, *args], capture_output=True, text=True,
                                 env={'OPENCLAW_CONFIG_PATH': str(Path(self.temp.name) / 'missing-config')})
        self.assertEqual(process.returncode, 0); self.assertEqual(process.stderr, '')
        self.assertEqual(json.loads(process.stdout)['data'], self.probe())

    def test_cli_error_is_bounded_generic_and_non_accepting(self):
        self.review_file.unlink()
        with patch.object(desk, 'native_settings', return_value={}), redirect_stdout(io.StringIO()) as out:
            code = desk.main(['--evidence-root', str(self.root), 'findings', '--message', MID, '--thread', TID,
                             '--sha256', self.sha, '--request-id', self.request])
        self.assertEqual(code, 0)
        result = json.loads(out.getvalue())
        self.assertEqual(result['status'], 'error'); self.assertTrue(result['code'].startswith('SECRETARY_FINDINGS_'))
        self.assertNotIn(str(self.root), out.getvalue()); self.assertNotIn('private', out.getvalue())


if __name__ == '__main__':
    unittest.main()
