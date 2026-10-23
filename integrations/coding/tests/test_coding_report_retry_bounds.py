import copy
import unittest

from integrations.coding.tests.test_coding_report_ledger import ledgers, steps, snapshot, source


class RetryBoundsTest(unittest.TestCase):
    def test_two_stalled_attempted_executions_cannot_be_reset_by_a_new_continuation(self):
        ledger = ledgers.new_ledger(snapshot())
        ledgers.continuation_retries(ledger, 'first', None)
        for number, key, parent in [(1, 'second', 'first'), (3, 'third', 'second')]:
            ledgers.record_failure(ledger, ['docs/A.md'], number, 'No result')
            ledgers.record_failure(ledger, ['docs/A.md'], number + 1, 'No result')
            ledgers.continuation_retries(ledger, key, parent)
        row = ledger['documents']['docs/A.md']
        self.assertTrue(row['retryExhausted'])
        self.assertEqual(row['stalledExecutions'], 2)
        self.assertEqual(row['state'], 'blocked')
        before = copy.deepcopy(row)
        ledgers.continuation_retries(ledger, 'fourth', 'third')
        self.assertEqual(row, before)
        self.assertNotIn('docs/A.md', [p for group in steps.plan_groups(ledger, {}, steps.step_budget()) for p in group['documents']])
        self.assertNotIn('stalledExecutions', ledger['documents']['docs/B.md'])

    def test_new_verified_source_coverage_breaks_a_stall_and_same_request_is_idempotent(self):
        ledger = ledgers.new_ledger(snapshot())
        ledgers.continuation_retries(ledger, 'first', None)
        ledgers.record_failure(ledger, ['docs/A.md'], 1, 'No result')
        ledgers.continuation_retries(ledger, 'second', 'first')
        self.assertEqual(ledger['documents']['docs/A.md']['stalledExecutions'], 1)
        result = {'documents': [{'path': 'docs/A.md', 'state': 'partial', 'evidence': [
            {'path': 'core/config.js', 'line': 2, 'check': 'Retry value checked'}]}], 'findings': []}
        ledgers.merge_step(ledger, ['docs/A.md'], result, source, 2)
        ledgers.continuation_retries(ledger, 'third', 'second')
        self.assertEqual(ledger['documents']['docs/A.md']['stalledExecutions'], 0)
        before = copy.deepcopy(ledger)
        ledgers.continuation_retries(ledger, 'third', 'second')
        self.assertEqual(ledger, before)

    def test_coverage_exports_accepted_ranges_for_core_progress_comparison(self):
        ledger = ledgers.new_ledger(snapshot())
        ledger['documents']['docs/A.md']['ranges'] = [[1, 2]]
        row = next(row for row in ledgers.coverage(ledger)['documents'] if row['path'] == 'docs/A.md')
        self.assertEqual(row['ranges'], [[1, 2]])


if __name__ == '__main__':
    unittest.main()
