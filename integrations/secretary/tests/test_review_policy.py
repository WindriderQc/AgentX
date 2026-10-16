import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

from mail_catchup import page_prompt
from review_attempts import ReviewUncertain, hashed
from review_policy import context_for


class ReviewContextTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.archive = SimpleNamespace(root=Path(self.temp.name))
        self.page = {"pageId": "a" * 64, "threadId": "thread01", "headers": {"Date": "1 Sep 2020"},
                     "kind": "body", "offset": 0, "totalChars": 20, "moreOfThisSource": False,
                     "externalUntrustedContent": "Synthetic old source"}

    def test_replaying_a_page_after_the_clock_advances_keeps_its_original_analysis_date(self):
        with mock.patch('review_policy.now', side_effect=['2026-10-15T09:00:00Z', '2026-10-16T10:00:00Z']):
            first = page_prompt(self.archive, self.page, False)
            second = page_prompt(self.archive, self.page, False)
        self.assertEqual(first, second)
        metadata = json.loads(first.split('\n', 1)[1].split('\n\nUNTRUSTED', 1)[0])
        self.assertEqual(metadata['reviewContext']['asOf'], '2026-10-15T09:00:00Z')
        self.assertEqual(metadata['headers']['Date'], '1 Sep 2020')
        self.assertIn(self.page['externalUntrustedContent'], first)

    def test_distinct_pages_do_not_inherit_each_others_analysis_date(self):
        with mock.patch('review_policy.now', return_value='2026-10-15T09:00:00Z'):
            first = context_for(self.archive, self.page)
        with mock.patch('review_policy.now', return_value='2026-10-16T10:00:00Z'):
            second = context_for(self.archive, {**self.page, 'pageId': 'b' * 64})
        self.assertNotEqual(first['asOf'], second['asOf'])

    def test_corrupt_or_mismatched_saved_context_refuses_instead_of_rewriting_the_intent(self):
        context_for(self.archive, self.page)
        file = self.archive.root / 'review-contexts' / (hashed(self.page['pageId']) + '.json')
        for content in ('{broken', json.dumps({'schema': 'secretary.review-context/v1',
                       'pageId': 'another-page', 'asOf': '2026-10-15T09:00:00Z'}),
                       json.dumps({'schema': 'secretary.review-context/v1',
                       'pageId': self.page['pageId'], 'asOf': '2026-10-15T09:00:00'})):
            file.write_text(content)
            with self.assertRaises(ReviewUncertain):
                context_for(self.archive, self.page)
            self.assertEqual(file.read_text(), content)
