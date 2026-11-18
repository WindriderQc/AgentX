"""Synthetic current review graphs copied/reread through real native custody."""
from copy import deepcopy
import io
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import archive_review_packet as graph
import archive_review_restoration as native
import archive_restoration as disk
import archive_preservation as source
from evidence_attribution import review_pages
from evidence_store import load
from secretary_evidence import REVIEW_PAGE_CHARS, message_text
import secretary_mail_desk as desk
import test_archive_restoration as fixtures

MID, TID = fixtures.MID, fixtures.TID


@unittest.skipUnless(disk.NATIVE_PLATFORM and disk.RENAME_NOREPLACE is not None, 'Linux native custody required')
class ReviewRestorationTests(unittest.TestCase):
    save = fixtures.NativeRestorationTests.save
    set_raw = fixtures.NativeRestorationTests.set_raw
    empty_scratch = fixtures.NativeRestorationTests.empty_scratch

    def setUp(self):
        fixtures.NativeRestorationTests.setUp(self)
        body = 'Synthetic complete private body marker\n'
        self.message.update(bodySha256=source.digest(body.encode()), internalDate='1000')
        self.manifest['evidenceHash'] = source.digest(b'Synthetic complete current packet')
        self.manifest['gmailUrl'] = 'https://example.invalid/synthetic-mail'
        self.manifest['messages'][1].update(headers={}, internalDate='0')
        self.original = {'thread': {'id': TID, 'messages': [{'id': MID, 'threadId': TID, 'body': body,
            'labelIds': ['SENT'], 'payload': {'mimeType': 'multipart/mixed', 'parts': [
                {'partId': item['partId'], 'mimeType': 'application/octet-stream', 'filename': 'sample.bin',
                 'body': {'attachmentId': 'synthetic-' + item['partId']}} for item in self.message['attachments']]}},
            {'id': 'c' * 16, 'body': 'Synthetic unrelated source'}]}}
        self.graph_files()

    def graph_files(self):
        self.save(self.manifest_file, self.manifest)
        self.save(self.root / 'threads' / TID / 'original.json', self.original)
        (self.root / 'threads' / TID / 'packet.txt').write_bytes(b'Synthetic complete current packet')
        self.save(self.root / 'reviews' / (TID + '.json'), {'threadId': TID, 'evidenceHash': self.manifest['evidenceHash'],
            'actions': [], 'memories': [], 'deliverables': [], 'invoices': [], 'unresolved': []})
        self.save(self.root / 'value-lanes.json', {'schema': 'agentx.secretary-value-lanes/v1',
            'messages': {MID: {'threadId': TID, 'lane': 'person'}}})
        for number, part in enumerate(self.original['thread']['messages'][0]['payload']['parts'], 1):
            item = next(row for row in self.message['attachments'] if row['partId'] == part['partId'])
            self.save(self.root / 'download-receipts' / f'{MID}-{number}.json',
                {'sourceHash': source.digest(json.dumps(part, sort_keys=True).encode()), 'attachment': item})
        self.pages = list(review_pages(SimpleNamespace(root=self.root), self.manifest, load=load, message_text=message_text,
            sha=source.digest, json=json, page_chars=REVIEW_PAGE_CHARS, message_id=MID))
        for page in self.pages:
            self.save(self.root / 'page-reviews' / (page['pageId'] + '.json'), {'pageId': page['pageId'], 'threadId': TID,
                'summary': 'Synthetic recorded page', 'evidenceHash': self.manifest['evidenceHash']})

    def probe(self): return native.probe(self.root, MID, TID, self.sha, self.request)

    def test_real_copy_reopens_all_current_review_files_without_archive_changes(self):
        before = {p: (p.read_bytes(), source.stamp(p.stat())) for p in self.root.rglob('*') if p.is_file()}
        proof = self.probe()
        self.assertEqual(proof['contract'], native.CONTRACT)
        self.assertEqual(proof['reviewPacket'], graph.inventory(self.root, MID, TID, self.sha, self.request))
        self.assertEqual(proof['reviewPacket']['filesSha256'], proof['restoration']['restoredFilesSha256'])
        self.assertEqual(proof['reviewPacket']['counts']['files'], proof['restoration']['filesCopied'])
        self.assertEqual(proof['reviewPacket']['counts']['pages'], len(self.pages))
        self.assertGreater(proof['restoration']['filesCopied'], 3 + len(proof['attachments']))
        self.assertEqual({p: (p.read_bytes(), source.stamp(p.stat())) for p in self.root.rglob('*') if p.is_file()}, before)
        self.assertNotIn('private body', json.dumps(proof)); self.assertNotIn(str(self.root), json.dumps(proof))
        self.empty_scratch()

    def test_missing_or_stale_review_artifacts_cannot_fall_back_to_originals_only(self):
        paths = ['threads/' + TID + '/original.json', 'threads/' + TID + '/packet.txt', 'reviews/' + TID + '.json',
                 'value-lanes.json', f'download-receipts/{MID}-1.json', 'page-reviews/' + self.pages[0]['pageId'] + '.json']
        for relative in paths:
            path = self.root / relative; old = path.read_bytes(); path.unlink()
            try:
                with self.subTest(path=relative), self.assertRaises(graph.ReviewPacketError): self.probe()
            finally: path.write_bytes(old)
            self.empty_scratch()
        original = self.root / 'threads' / TID / 'original.json'; old = original.read_bytes()
        wrong = deepcopy(self.original); wrong['thread']['messages'][0]['body'] = 'Changed source body'
        self.save(original, wrong)
        with self.assertRaises(graph.ReviewPacketError): self.probe()
        original.write_bytes(old)
        (self.root / 'threads' / TID / 'packet.txt').write_bytes(b'Changed packet')
        with self.assertRaises(graph.ReviewPacketError): self.probe()

    def test_extracted_text_and_ocr_receipt_are_in_the_reread_file_set(self):
        text_path = self.message['attachments'][0]['path'] + '.ocr.txt'
        (self.root / text_path).write_text('Synthetic OCR source text')
        self.message['attachments'][0].update(textPath=text_path, status='ocr_text_extracted')
        self.save(self.root / 'ocr-receipts' / (self.message['attachments'][0]['sha256'] + '.json'),
            {'attachment': {'status': 'ocr_text_extracted', 'textPath': text_path}})
        self.graph_files()
        observed = self.probe(); self.assertEqual(observed['reviewPacket']['counts']['pages'], len(self.pages))
        (self.root / 'ocr-receipts' / (self.message['attachments'][0]['sha256'] + '.json')).unlink()
        with self.assertRaises(graph.ReviewPacketError): self.probe()
        self.empty_scratch()

    def test_compound_members_are_read_by_hash_never_decompressed_or_executed(self):
        item = self.message['attachments'][0]; item['filename'] = 'synthetic.zip'
        blob = b'Synthetic preserved member'; sha = source.digest(blob)
        relative = f'compound-sources/blobs/{sha}.bin'; (self.root / relative).parent.mkdir(parents=True)
        (self.root / relative).write_bytes(blob)
        member = {'id': graph.identity(item['sha256'], 0, 'member.txt'), 'parentId': item['sha256'], 'ordinal': 0,
            'nameAsWritten': 'member.txt', 'kind': 'file', 'path': relative, 'sha256': sha, 'bytes': len(blob)}
        index = self.root / 'compound-sources' / 'indexes' / (item['sha256'] + '.json')
        self.save(index, {'schema': graph.COMPOUND, 'sourceSha256': item['sha256'], 'sourceBytes': item['bytes'],
            'status': 'complete', 'errors': [], 'members': [member]})
        self.graph_files(); observed = self.probe()
        self.assertEqual(observed['reviewPacket']['counts']['compoundMembers'], 1)
        (self.root / relative).write_bytes(b'Changed member')
        with self.assertRaises(graph.ReviewPacketError): self.probe()
        self.empty_scratch()

    def test_links_and_capacity_fail_closed_before_claiming_a_restored_graph(self):
        page = self.root / 'page-reviews' / (self.pages[0]['pageId'] + '.json'); old = page.read_bytes()
        outside = Path(self.temp.name) / 'outside.json'; outside.write_bytes(old); page.unlink(); page.symlink_to(outside)
        with self.assertRaises(graph.ReviewPacketError): self.probe()
        page.unlink(); page.write_bytes(old)
        with patch.object(graph, 'MAX_FILES', 5), self.assertRaises(graph.ReviewPacketError): self.probe()
        with patch.object(graph, 'MAX_PAGES', 1), self.assertRaises(graph.ReviewPacketError): self.probe()
        self.empty_scratch()

    def test_a_late_change_to_an_already_qualified_page_receipt_refuses(self):
        original = disk.copy_files
        def changed(files, owner):
            written = original(files, owner)
            page = self.root / 'page-reviews' / (self.pages[0]['pageId'] + '.json')
            page.write_bytes(page.read_bytes().replace(b'Synthetic', b'Different'))
            return written
        with patch.object(disk, 'copy_files', side_effect=changed), self.assertRaises(graph.ReviewPacketError): self.probe()
        self.empty_scratch()

    def test_cli_uses_archive_only_without_gmail_or_runtime_configuration(self):
        out = io.StringIO()
        with patch.object(desk, 'native_settings', return_value={}), patch.dict(os.environ, {}, clear=True), \
                patch.object(desk, 'run_gog', side_effect=AssertionError('No provider')), patch('sys.stdout', out):
            desk.main(['--evidence-root', str(self.root), 'review-restoration', '--message', MID, '--thread', TID,
                '--sha256', self.sha, '--request-id', self.request])
        self.assertEqual(json.loads(out.getvalue())['status'], 'success'); self.empty_scratch()


if __name__ == '__main__': unittest.main()
