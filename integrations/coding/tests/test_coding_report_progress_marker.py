import copy
import unittest

from integrations.coding.tests.test_coding_report import load

ledger = load('coding_report_ledger')


class ProgressMarkerTest(unittest.TestCase):
    def test_notes_receipts_reworded_checks_and_retry_resets_are_not_new_scope(self):
        value = {'legacy': 'Existing report.', 'documents': {'README.md': {'state': 'partial',
            'evidence': [{'path': 'config.js', 'sha256': 'a'*64, 'line': 1, 'check': 'Retry setting'}],
            'ranges': [[1, 20]], 'note': 'Still open', 'attempts': 1}}, 'steps': [],
            'findings': [{'kind': 'inaccuracy', 'document': {'path': 'README.md', 'line': 2},
                'title': 'Wrong retry setting', 'evidence': [
                    {'path': 'config.js', 'sha256': 'a'*64, 'line': 1, 'check': 'Retry setting'}]}]}
        before = ledger.progress_marker(value)
        changed = copy.deepcopy(value)
        row = changed['documents']['README.md']
        row.update(note='Reworded note', attempts=0)
        row['evidence'][0]['check'] = 'Same source, another wording'
        row['ranges'].append([1, 20])
        changed['steps'].append({'result': 'failed'})
        changed['findings'][0]['title'] = 'Same finding, reworded'
        changed['findings'][0]['evidence'].append(copy.deepcopy(changed['findings'][0]['evidence'][0]))
        self.assertEqual(ledger.progress_marker(changed), before)
        for key, change in [('reviewed', lambda: row.update(state='reviewed')),
                            ('ranges', lambda: row['ranges'].append([21, 40])),
                            ('evidence', lambda: row['evidence'].append(
                                {'path': 'config.js', 'sha256': 'a'*64, 'line': 2, 'check': 'New source line'}))]:
            change()
            self.assertTrue(ledger.progress_marker(changed)[key] - before[key])


if __name__ == '__main__':
    unittest.main()
