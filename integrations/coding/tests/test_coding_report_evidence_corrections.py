import copy
import unittest

from integrations.coding.tests.test_coding_report_ledger import ledgers, steps, source, snapshot, good_result


class EvidenceCorrectionsTest(unittest.TestCase):
    def setUp(self):
        self.ledger = ledgers.new_ledger(snapshot(), legacy_markdown='Earlier prose.')
        ledgers.merge_step(self.ledger, ['docs/A.md'], good_result(), source, 1)
        self.ref = self.ledger['documents']['docs/A.md']['evidence'][0]
        self.ref['check'] = 'The retry limit is 5.'
        self.edit = {'document': 'docs/A.md', 'path': 'core/config.js', 'line': 2,
                     'find': 'The retry limit is 5.', 'replace': 'The retry limit is 7.'}

    def merge(self, edits=None, legacy=None):
        value = {'legacyEdits': legacy or [], 'evidenceEdits': [self.edit] if edits is None else edits}
        ledgers.merge_legacy_review(self.ledger, value, None, 'Correct the retry evidence.', source, 2, 'request')

    def test_correction_changes_only_existing_check_and_retains_source_and_history(self):
        before = copy.deepcopy(self.ledger['documents'])
        facts = ledgers.progress_marker(self.ledger)
        self.merge()
        after = self.ledger['documents']
        before['docs/A.md']['evidence'][0]['check'] = self.edit['replace']
        self.assertEqual(before, after)
        self.assertEqual(facts, ledgers.progress_marker(self.ledger))
        receipt = self.ledger['legacyReview']['evidenceCorrections'][0]
        self.assertEqual(receipt['before'], self.edit['find'])
        self.assertEqual(receipt['after'], self.edit['replace'])
        self.assertEqual(receipt['sha256'], self.ref['sha256'])
        self.assertFalse(ledgers.legacy_review_required(self.ledger, 'Correct the retry evidence.'))
        self.ref['check'] = self.edit['find']
        self.assertTrue(ledgers.legacy_review_required(self.ledger, 'Correct the retry evidence.'))

    def test_invalid_target_or_unauthorized_state_change_rolls_back_all_corrections(self):
        for update in ({'document': []}, {'document': 'absent.md'}, {'path': {}}, {'line': True},
                       {'line': 99}, {'find': 'not the original text'}, {'replace': ''}, {'state': 'reviewed'}):
            with self.subTest(update=update):
                before = copy.deepcopy(self.ledger['documents'])
                self.merge([{**self.edit, **update}], [{'find': 'Earlier', 'replace': 'Corrected'}])
                self.assertEqual(self.ledger['documents'], before)
                self.assertEqual(self.ledger['legacy'], 'Earlier prose.')
                self.assertEqual(self.ledger['steps'][-1]['result'], 'failed')
                self.assertTrue(self.ledger['legacyReviewPending'])

    def test_failed_legacy_or_duplicate_evidence_cannot_partly_apply(self):
        for edits, legacy in (([self.edit], [{'find': 'absent', 'replace': 'value'}]),
                              ([self.edit, self.edit], []), (None, []), ('invalid', [])):
            with self.subTest(edits=edits, legacy=legacy):
                value = {'legacyEdits': legacy, 'evidenceEdits': edits}
                ledgers.merge_legacy_review(self.ledger, value, None, 'Notes', source, 2, 'request')
                self.assertEqual(self.ref['check'], self.edit['find'])
                self.assertEqual(self.ledger['legacy'], 'Earlier prose.')
                self.assertEqual(self.ledger['steps'][-1]['result'], 'failed')

    def test_changed_source_hash_and_ambiguous_saved_reference_are_rejected(self):
        self.ref['sha256'] = '0'*64
        self.merge()
        self.assertTrue(self.ledger['legacyReviewPending'])
        self.assertEqual(self.ref['check'], self.edit['find'])
        self.ledger['documents']['docs/A.md']['evidence'].append(copy.deepcopy(self.ref))
        self.merge()
        self.assertTrue(self.ledger['legacyReviewPending'])

    def test_structured_report_can_receive_reviewer_corrections_without_legacy_prose(self):
        self.ledger['legacy'] = None
        self.assertTrue(ledgers.legacy_review_required(self.ledger, 'Correct the retry evidence.', review_evidence=True))
        self.merge()
        restored = ledgers.embedded(ledgers.render(self.ledger, 'Review'))
        self.assertFalse(ledgers.legacy_review_required(restored, 'Correct the retry evidence.', review_evidence=True))
        self.assertIsNone(restored['legacy'])
        self.assertEqual(restored['documents']['docs/A.md']['state'], 'reviewed')
        self.assertEqual(restored['documents']['docs/A.md']['evidence'][0]['check'], self.edit['replace'])

    def test_prompt_exposes_existing_private_coverage_without_authorizing_direct_edits(self):
        prompt = steps.legacy_prompt(self.ledger, '/home/agent/deliverables/request/step-01.json',
            {'feedback': [{'by': 'operator', 'text': 'Correct docs/A.md.'}]}, 'Read-only source.')
        self.assertIn('/home/agent/deliverables/request/coverage.json', prompt)
        self.assertIn('"evidenceEdits"', prompt)
        self.assertIn('Do not edit coverage.json', prompt)


if __name__ == '__main__':
    unittest.main()
