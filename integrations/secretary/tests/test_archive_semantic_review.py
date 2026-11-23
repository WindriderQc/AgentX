"""Real bounded source and recorded analysis delivery; synthetic bytes only."""
import base64
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import archive_preservation as preservation
import archive_review_packet as graph
import archive_semantic_review as native
import secretary_mail_desk as desk
import test_archive_review_restoration as fixtures
MID, TID = fixtures.MID, fixtures.TID


class SemanticReviewTests(unittest.TestCase):
    save = fixtures.ReviewRestorationTests.save
    set_raw = fixtures.ReviewRestorationTests.set_raw
    graph_files = fixtures.ReviewRestorationTests.graph_files

    def setUp(self):
        fixtures.ReviewRestorationTests.setUp(self)
        review = json.loads((self.root / 'reviews' / (TID + '.json')).read_bytes())
        review['memories'] = [{'messageId': MID, 'text': 'Selected synthetic finding'},
                              {'messageId': 'c' * 16, 'text': 'Never expose unrelated finding'}]
        review['unresolved'] = ['Synthetic thread ambiguity remains explicit']
        self.save(self.root / 'reviews' / (TID + '.json'), review)

    def probe(self, **changes):
        return native.probe(self.root, MID, TID, self.sha, self.request, **changes)

    def read(self, index):
        data, offset = b'', 0
        while True:
            packet = self.probe(resource=index, offset=offset)
            page = packet['page']
            chunk = base64.b64decode(page['contentBase64'], validate=True)
            self.assertLessEqual(len(chunk), 32768)
            self.assertEqual(preservation.digest(chunk), page['chunkSha256'])
            data += chunk
            if page['nextOffset'] is None:
                self.assertEqual(len(data), packet['resources'][index]['bytes'])
                self.assertEqual(preservation.digest(data), packet['resources'][index]['sha256'])
                return data
            self.assertGreater(page['nextOffset'], offset)
            offset = page['nextOffset']

    def test_original_attachment_and_selected_analysis_are_exact_with_no_archive_writes(self):
        before = {p: (p.read_bytes(), preservation.stamp(p.stat())) for p in self.root.rglob('*') if p.is_file()}
        packet = self.probe()
        self.assertEqual(packet['contract'], native.CONTRACT)
        self.assertFalse(packet['semanticAcceptance']); self.assertFalse(packet['executionAllowed'])
        self.assertNotIn('page', packet)
        self.assertEqual(packet['reviewPacket'], graph.inventory(self.root, MID, TID, self.sha, self.request))
        self.assertEqual(packet['resources'][0], {'kind': 'original', 'key': 'original', 'sha256': self.sha,
                                                 'bytes': len(self.raw.read_bytes())})
        self.assertEqual(self.read(0), self.raw.read_bytes())
        for index, row in enumerate(packet['resources']):
            self.assertEqual(set(row), {'kind', 'key', 'sha256', 'bytes'})
            if row['kind'] == 'attachment': self.assertEqual(self.read(index), self.attachment.read_bytes())
        analysis = json.loads(self.read(len(packet['resources']) - 1))
        self.assertEqual(analysis['contract'], native.ANALYSIS_CONTRACT)
        self.assertEqual(len(analysis['findings']), 1)
        self.assertEqual(analysis['findings'][0]['item']['text'], 'Selected synthetic finding')
        self.assertNotIn('Never expose unrelated finding', json.dumps(analysis))
        self.assertNotIn('Synthetic unrelated source', json.dumps(analysis))
        self.assertEqual(analysis['threadQuestions'], ['Synthetic thread ambiguity remains explicit'])
        self.assertEqual(len(analysis['pages']), len(self.pages))
        self.assertTrue(all(row['source']['messageId'] == MID for row in analysis['pages']))
        self.assertTrue(all(row['source']['pageId'] == row['review']['pageId'] for row in analysis['pages']))
        self.assertEqual({p: (p.read_bytes(), preservation.stamp(p.stat())) for p in self.root.rglob('*') if p.is_file()}, before)
        self.assertEqual(list(self.scratch_base.iterdir()), [])

    def test_large_original_uses_lossless_chunks_and_exact_end_offset(self):
        # Retain the existing MIME attachments, changing only the native raw
        # text part. The graph's separately recorded source body remains bound.
        raw = (b'X-Synthetic: ' + b'x' * 70 + b'\n') * 500 + self.raw.read_bytes()
        self.set_raw(raw)
        packet = self.probe(resource=0, offset=0)
        self.assertEqual(packet['page']['nextOffset'], native.PAGE_BYTES)
        self.assertEqual(self.read(0), raw)
        end = self.probe(resource=0, offset=len(raw))['page']
        self.assertEqual(end['contentBase64'], ''); self.assertIsNone(end['nextOffset'])

    def test_bad_resource_offset_and_identities_refuse_without_private_exception_text(self):
        for changes in [{'resource': -1}, {'resource': 256}, {'resource': True}, {'resource': 99},
                        {'resource': 0, 'offset': -1}, {'resource': 0, 'offset': True},
                        {'resource': 0, 'offset': 16 * 1024 * 1024 + 1}, {'offset': 1},
                        {'resource': 0, 'offset': len(self.raw.read_bytes()) + 1}]:
            with self.subTest(changes=changes), self.assertRaises(native.SemanticReviewError) as raised:
                self.probe(**changes)
            self.assertEqual(raised.exception.status, 400)
            self.assertNotIn(str(self.root), str(raised.exception))
        with self.assertRaises(native.SemanticReviewError) as raised:
            native.probe(self.root, MID + ';run', TID, self.sha, self.request)
        self.assertEqual(raised.exception.status, 400)

    def test_late_selected_page_change_cannot_release_stale_analysis(self):
        original = native.resources
        def changed(*args):
            result = original(*args)
            page = self.root / 'page-reviews' / (self.pages[0]['pageId'] + '.json')
            page.write_bytes(page.read_bytes().replace(b'Synthetic', b'Different'))
            return result
        with patch.object(native, 'resources', side_effect=changed), self.assertRaises(native.SemanticReviewError):
            self.probe(resource=3)

    def test_source_links_missing_graph_and_capacity_are_not_delivery(self):
        outside = Path(self.temp.name) / 'outside.bin'; data = self.attachment.read_bytes(); outside.write_bytes(data)
        self.attachment.unlink(); self.attachment.symlink_to(outside)
        with self.assertRaises(native.SemanticReviewError): self.probe()
        self.attachment.unlink(); self.attachment.write_bytes(data)
        with patch.object(native, 'MAX_RESOURCES', 1), self.assertRaises(native.SemanticReviewError) as raised:
            self.probe()
        self.assertEqual(raised.exception.status, 413)
        with patch.object(native, 'MAX_BYTES', 1), self.assertRaises(native.SemanticReviewError) as raised:
            self.probe()
        self.assertEqual(raised.exception.status, 413)
        (self.root / 'page-reviews' / (self.pages[0]['pageId'] + '.json')).unlink()
        with self.assertRaises(native.SemanticReviewError): self.probe()

    def test_compound_members_remain_individual_exact_resources(self):
        attachment = self.message['attachments'][0]; attachment['filename'] = 'synthetic.zip'
        content = b'Synthetic selected nested member'; sha = preservation.digest(content)
        relative = f'compound-sources/blobs/{sha}.bin'
        path = self.root / relative; path.parent.mkdir(parents=True); path.write_bytes(content)
        member = {'id': graph.identity(attachment['sha256'], 0, 'nested.txt'), 'parentId': attachment['sha256'],
                  'ordinal': 0, 'nameAsWritten': 'nested.txt', 'kind': 'file', 'path': relative, 'sha256': sha, 'bytes': len(content)}
        self.save(self.root / 'compound-sources' / 'indexes' / (attachment['sha256'] + '.json'),
                  {'schema': graph.COMPOUND, 'sourceSha256': attachment['sha256'], 'sourceBytes': attachment['bytes'],
                   'status': 'complete', 'errors': [], 'members': [member]})
        self.graph_files()
        packet = self.probe()
        index = next(i for i, row in enumerate(packet['resources']) if row['kind'] == 'compound_member')
        self.assertEqual(packet['resources'][index]['key'], member['id'])
        self.assertEqual(self.read(index), content)
        path.write_bytes(b'Changed selected nested member')
        with self.assertRaises(native.SemanticReviewError): self.probe(resource=index)

    def test_cli_never_calls_gmail_or_uses_runtime_authorization(self):
        out = io.StringIO()
        with patch.object(desk, 'native_settings', return_value={}), patch.dict(os.environ, {}, clear=True), \
                patch.object(desk, 'run_gog', side_effect=AssertionError('No provider')), redirect_stdout(out):
            desk.main(['--evidence-root', str(self.root), 'semantic-review', '--message', MID, '--thread', TID,
                       '--sha256', self.sha, '--request-id', self.request, '--resource', '0', '--offset', '0'])
        reply = json.loads(out.getvalue())
        self.assertEqual(reply['status'], 'success')
        self.assertEqual(base64.b64decode(reply['data']['page']['contentBase64']), self.raw.read_bytes())


if __name__ == '__main__': unittest.main()
