"""Exact correction requests copied from the runner's displayed archive."""
import json
import unittest

from integrations.coding.tests.test_coding_report_ledger import ledgers, snapshot, source


class RenderedEditsTest(unittest.TestCase):
    def setUp(self):
        self.section = '#### F2 — Old finding\nThe fifteen families are correct.\n'
        self.legacy = '# Original report\n\n#### F1 — Keep\nVerified.\n\n' + self.section + '\n#### F3 — Keep too\nVerified.\n'
        self.ledger = ledgers.new_ledger(snapshot(), legacy_markdown=self.legacy)

    def merge(self, edits):
        return ledgers.merge_step(self.ledger, [], {'documents': [], 'legacyEdits': edits}, source, 1, allow_empty=True)

    def test_displayed_heading_deletion_keeps_other_findings_and_coverage(self):
        before = json.dumps(ledgers.coverage(self.ledger), sort_keys=True)
        copied = ledgers.render_legacy(self.section).strip()
        receipt = self.merge([{'find': copied, 'replace': ''}])
        self.assertEqual(self.ledger['legacy'], self.legacy.replace(self.section.strip(), '', 1))
        self.assertEqual(receipt['renderedLegacyEdits'], [1])
        self.assertIn('#### F1', self.ledger['legacy'])
        self.assertIn('#### F3', self.ledger['legacy'])
        self.assertEqual(json.dumps(ledgers.coverage(self.ledger), sort_keys=True), before)

    def test_displayed_plain_text_replacement_has_the_exact_requested_display(self):
        copied = ledgers.render_legacy(self.section).strip()
        self.merge([{'find': copied, 'replace': 'Withdrawn after source verification.'}])
        self.assertEqual(ledgers.render_legacy(self.ledger['legacy']),
                         ledgers.render_legacy(self.legacy).replace(copied, 'Withdrawn after source verification.', 1))

    def test_missing_or_ambiguous_content_never_becomes_a_fuzzy_match(self):
        for text in [self.legacy, self.legacy + self.section]:
            for copied in [ledgers.render_legacy(self.section).replace('fifteen', 'sixteen').strip(),
                           ledgers.render_legacy(self.section).replace('families are', 'families  are').strip()]:
                self.ledger = ledgers.new_ledger(snapshot(), legacy_markdown=text)
                before = json.dumps(self.ledger, sort_keys=True)
                with self.assertRaises(ledgers.LedgerError):
                    self.merge([{'find': copied, 'replace': ''}])
                self.assertEqual(json.dumps(self.ledger, sort_keys=True), before)
        self.ledger = ledgers.new_ledger(snapshot(), legacy_markdown=self.legacy + self.section)
        with self.assertRaises(ledgers.LedgerError):
            self.merge([{'find': ledgers.render_legacy(self.section).strip(), 'replace': ''}])

    def test_heading_replacements_require_original_source_and_later_failure_is_atomic(self):
        before = json.dumps(self.ledger, sort_keys=True)
        copied = ledgers.render_legacy(self.section).strip()
        for edits in [[{'find': copied, 'replace': '###### New heading\nText.'}],
                      [{'find': copied, 'replace': ''}, {'find': 'Absent source', 'replace': ''}]]:
            with self.assertRaises(ledgers.LedgerError):
                self.merge(edits)
            self.assertEqual(json.dumps(self.ledger, sort_keys=True), before)

    def test_original_exact_edits_still_work_without_a_display_conversion(self):
        receipt = self.merge([{'find': self.section.strip(), 'replace': '#### Corrected heading\nText.'}])
        self.assertNotIn('renderedLegacyEdits', receipt)
        self.assertIn('#### Corrected heading', self.ledger['legacy'])


if __name__ == '__main__':
    unittest.main()
