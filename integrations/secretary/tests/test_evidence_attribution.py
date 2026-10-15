import hashlib
import json
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from evidence_attribution import body_segments, page_context
from secretary_evidence import Archive, save
from mail_catchup import page_prompt


class AttributionTests(unittest.TestCase):
    def test_draft_direction_is_explicit_without_changing_source_page_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            payload = {'messages': [{'id': 'message1', 'body': 'Unsent synthetic intent',
                'labelIds': ['DRAFT'], 'headers': {'from': 'Synthetic owner'}}]}
            archive = Archive(Path(directory), lambda _: payload)
            page = next(archive.review_pages(archive.collect_thread('thread01')))
            self.assertEqual(page['sourceContext']['messageDirection'], 'draft')
            expected = hashlib.sha256(json.dumps(['thread01', 'message1', 'body', None, 0,
                                                  'Unsent synthetic intent']).encode()).hexdigest()
            self.assertEqual(page['pageId'], expected)

    def test_indented_non_header_lines_do_not_stall_source_scanning(self):
        # Execute separately so a regression cannot strand a worker or the test
        # runner. This tiny unmatched header used to explore overlapping spaces
        # across four continuation lines instead of respecting the read budget.
        script = """
from evidence_attribution import body_segments
body = 'On an ordinary line\\n' + (' ' * 300 + 'x\\n') * 5
spans = body_segments(body, {'from': 'Container author'})
assert len(spans) == 1
assert spans[0]['relation'] == 'authored'
assert body[spans[0]['start']:spans[0]['end']] == body
"""
        result = subprocess.run([sys.executable, '-c', script],
                                cwd=Path(__file__).resolve().parents[1],
                                capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_wrapped_french_nested_quote_keeps_context_across_page_boundary(self):
        header = 'Le 16 juillet 2026 à 20:00, Person A\n<a@example.invalid>\n a\n écrit :\n'
        body = 'Current reply.\n\n' + header + 'Please bring the backpack Monday.\n' * 180
        body += '\nOn June 1, 2026, Person B <b@example.invalid> wrote:\nOlder request.'
        spans = body_segments(body, {'from': 'Person B', 'date': 'October 9, 2026'})
        context = page_context(spans, 4000, 2000, kind='body', newer_messages=2)
        self.assertEqual(context['segments'][0]['relation'], 'quoted')
        self.assertIn('16 juillet', context['segments'][0]['quotedHeader'])
        self.assertIsNone(context['segments'][0]['author'])
        self.assertIsNone(context['segments'][0]['date'])
        self.assertEqual(spans[0]['author'], 'Person B')
        self.assertEqual(spans[-1]['relation'], 'quoted')
        self.assertIn('June 1', spans[-1]['quotedHeader'])
        self.assertEqual(''.join(body[s['start']:s['end']] for s in spans), body)
        self.assertTrue(context['containerHasNewerMessages'])

    def test_unknown_quotes_and_outlook_forwards_never_inherit_outer_author(self):
        for body in ['> Please pay this invoice.\n\nUncertain inline reply.',
                     'New reply.\n-----Original Message-----\nFrom: Person A\nSent: July 1\nOld request.',
                     'New reply.\nDe : Person A\nDate : 1 juillet\nAncienne demande.']:
            spans = body_segments(body, {'from': 'Person B', 'date': 'October 9'})
            quoted = spans[-1]
            self.assertEqual(quoted['relation'], 'quoted')
            self.assertIsNone(quoted['author'])
            self.assertIsNone(quoted['date'])
        context = page_context([], 0, 30, kind='attachment', newer_messages=0)
        self.assertEqual(context['segments'][0]['attribution'], 'unknown')

    def test_outlook_quoted_date_remains_visible_far_beyond_the_header(self):
        body = 'New reply.\n-----Original Message-----\nFrom: Person A\nSent: July 1, 2026\nTo: Person B\nSubject: Supplies\n\n' + 'Old request. ' * 900
        context = page_context(body_segments(body, {'from': 'Person B', 'date': 'October 9'}), 4000, 1000, kind='body', newer_messages=0)
        self.assertEqual(len(context['segments']), 1)
        quoted = context['segments'][0]
        self.assertIn('Person A', quoted['quotedHeader'])
        self.assertIn('July 1, 2026', quoted['quotedHeader'])
        self.assertNotIn('October 9', quoted['quotedHeader'])
        self.assertIsNone(quoted['date'])

    def test_partial_headers_are_unresolved_and_repeated_quotes_never_change_dates(self):
        header = 'On July 16, 2026, Person A\n'
        body = 'New reply.\n' + header + 'Bring the backpack Monday.\n' + header + 'Bring the backpack Monday.'
        quotes = [s for s in body_segments(body, {'from': 'Person B', 'date': 'October 9'}) if s['relation'] == 'quoted']
        self.assertEqual(len(quotes), 2)
        self.assertTrue(all(s['attribution'] == 'unknown' and s['author'] is None and s['date'] is None for s in quotes))
        self.assertTrue(all('July 16' in s['quotedHeader'] for s in quotes))

    def test_page_ids_raw_text_receipts_and_resumed_identity_survive_reader_upgrade(self):
        with tempfile.TemporaryDirectory() as directory:
            body = 'A reply.\nOn July 16, 2026, Person A wrote:\n' + 'Old request. ' * 900
            payload = {'messages': [
                {'id': 'message1', 'internalDate': '1', 'body': 'Original request.', 'headers': {'from': 'A'}},
                {'id': 'message2', 'internalDate': '2', 'body': body, 'headers': {'from': 'B', 'date': 'October 9'}}]}
            archive = Archive(Path(directory), lambda _: payload)
            manifest = archive.collect_thread('thread01')
            pages = list(archive.review_pages(manifest))
            for page in pages:
                key = hashlib.sha256(json.dumps(['thread01', page['messageId'], page['kind'], None,
                                                page['offset'], page['externalUntrustedContent']]).encode()).hexdigest()
                self.assertEqual(page['pageId'], key)
            self.assertEqual(''.join(p['externalUntrustedContent'] for p in pages if p['messageId'] == 'message2'), body)
            quote_page = pages[1]
            self.assertEqual(quote_page['sourceContext']['segments'][0]['relation'], 'quoted')
            self.assertIn('sourceContext', page_prompt(archive, quote_page, False))
            issued = {k: v for k, v in quote_page.items() if k != 'sourceContext'}
            save(archive.root / 'native-worker.json', {'issued': issued})
            receipt = archive.root / 'page-reviews' / (pages[0]['pageId'] + '.json')
            save(receipt, {'pageId': pages[0]['pageId'], 'summary': 'Already read'})
            before = receipt.read_bytes()
            resumed = archive.native_next()
            self.assertTrue(resumed['resumed'])
            self.assertEqual(resumed['page']['pageId'], issued['pageId'])
            self.assertEqual(resumed['page']['externalUntrustedContent'], issued['externalUntrustedContent'])
            self.assertEqual(resumed['page']['sourceContext'], quote_page['sourceContext'])
            self.assertEqual(receipt.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
