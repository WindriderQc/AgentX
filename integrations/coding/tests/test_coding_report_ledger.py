import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ledgers, steps = load('coding_report_ledger'), load('coding_report_steps')

SOURCES = {
    'docs/A.md': b'# A\nThe retry limit is 5.\nDefault port 3080.\n',
    'docs/B.md': b'# B\nUse /api/old.\n',
    'docs/sub/C.md': b'# C\nNothing.\n',
    'core/config.js': b"'use strict';\nconst RETRY_LIMIT = 7;\nmodule.exports = { RETRY_LIMIT };\n",
}


def source(path):
    if path not in SOURCES:
        raise ValueError('missing')
    return SOURCES[path]


def snapshot():
    docs = [{'path': p, 'sha256': hashlib.sha256(SOURCES[p]).hexdigest()} for p in sorted(SOURCES) if p.endswith('.md')]
    return {'sourceCommit': 'a' * 40, 'sha256': 'b' * 64, 'documents': docs}


def good_result():
    return {'documents': [{'path': 'docs/A.md', 'state': 'reviewed',
                           'evidence': [{'path': 'core/config.js', 'line': 2, 'check': 'RETRY_LIMIT value'}]}],
            'findings': [{'kind': 'inaccuracy', 'severity': 'high', 'title': 'Retry limit is 7, not 5',
                          'document': {'path': 'docs/A.md', 'line': 2},
                          'evidence': [{'path': 'core/config.js', 'line': 2, 'check': 'RETRY_LIMIT = 7'}],
                          'correction': 'Say the retry limit is 7.'}]}


class LedgerTest(unittest.TestCase):
    def test_merges_a_verified_step_and_fills_source_digests(self):
        ledger = ledgers.new_ledger(snapshot())
        receipt = ledgers.merge_step(ledger, ['docs/A.md', 'docs/B.md'], good_result(), source, 1)
        self.assertEqual(receipt, {'step': 1, 'documents': ['docs/A.md'], 'findings': 1, 'legacyEdits': 0})
        row = ledger['documents']['docs/A.md']
        self.assertEqual(row['state'], 'reviewed')
        self.assertEqual(row['evidence'][0]['sha256'], hashlib.sha256(SOURCES['core/config.js']).hexdigest())
        self.assertEqual(ledger['findings'][0]['number'], 1)
        self.assertEqual(ledgers.counts(ledger), {'reviewed': 1, 'partial': 0, 'blocked': 0, 'pending': 2})

    def test_rejects_the_whole_step_on_one_bad_reference(self):
        ledger = ledgers.new_ledger(snapshot())
        before = json.dumps(ledger, sort_keys=True)
        for mutate, message in [
            (lambda r: r['documents'][0]['evidence'][0].update(line=99), 'outside core/config.js'),
            (lambda r: r['documents'][0].update(path='docs/sub/C.md'), 'not a document of this group'),
            (lambda r: r['findings'][0].update(evidence=[]), 'needs source evidence'),
            (lambda r: r['findings'][0]['evidence'][0].update(path='secret.txt'), 'not in the frozen snapshot'),
            (lambda r: r['documents'][0].update(state='done'), 'state must be one of'),
            (lambda r: r['documents'][0].update(evidence=[]), 'reviewed document needs source evidence'),
        ]:
            result = good_result()
            mutate(result)
            with self.subTest(message=message), self.assertRaisesRegex(ledgers.LedgerError, message):
                ledgers.merge_step(ledger, ['docs/A.md', 'docs/B.md'], result, source, 1)
            self.assertEqual(json.dumps(ledger, sort_keys=True), before)

    def test_blocks_documents_after_two_failed_steps(self):
        ledger = ledgers.new_ledger(snapshot())
        self.assertEqual(ledgers.record_failure(ledger, ['docs/B.md'], 1, 'no result file was written'), [])
        self.assertEqual(ledgers.record_failure(ledger, ['docs/B.md'], 2, 'no result file was written'), ['docs/B.md'])
        self.assertEqual(ledger['documents']['docs/B.md']['state'], 'blocked')
        self.assertIn('Blocked after 2 attempts', ledger['documents']['docs/B.md']['note'])

    def test_renders_a_report_whose_embedded_ledger_resumes_exactly(self):
        ledger = ledgers.new_ledger(snapshot())
        ledgers.merge_step(ledger, ['docs/A.md'], good_result(), source, 1)
        markdown = ledgers.render(ledger, 'Documentation review — task 0939', [['docs/B.md']])
        self.assertIn('#### F1 — Retry limit is 7, not 5 *(high)*', markdown)
        self.assertIn('| 1 | 0 | 0 | 2 | 1 |', markdown)
        self.assertIn('- Next group 1: `docs/B.md`', markdown)
        self.assertEqual(ledgers.embedded(markdown), json.loads(json.dumps(ledger)))
        coverage = ledgers.coverage(ledger)
        self.assertFalse(coverage['declaredComplete'])
        self.assertEqual([row['state'] for row in coverage['documents']], ['reviewed', 'pending', 'pending'])

    def test_keeps_earlier_findings_verbatim_and_applies_only_exact_corrections(self):
        legacy_report = ('# Old review\n\n## 1. Findings\n\n#### F2 — Data lists fifteen kinds\nThe count is wrong.\n\n'
                         '#### F10 — Six IoT families\nSix families.\n\n## 3. Coverage table\n| a | b |\n')
        narrative = ledgers.legacy_narrative(legacy_report)
        self.assertNotIn('Coverage table', narrative)
        ledger = ledgers.new_ledger(snapshot(), None, narrative)
        edits = {'documents': [], 'legacyEdits': [{'find': 'Six families.', 'replace': 'Eight IoT families.', 'reason': 'note'}]}
        ledgers.merge_step(ledger, [], edits, source, 1, allow_empty=True)
        self.assertIn('Eight IoT families.', ledger['legacy'])
        with self.assertRaisesRegex(ledgers.LedgerError, 'must occur once'):
            ledgers.merge_step(ledger, [], {'documents': [], 'legacyEdits': [{'find': 'F', 'replace': 'x'}]}, source, 2, allow_empty=True)
        ledgers.merge_step(ledger, ['docs/A.md'], good_result(), source, 3)
        self.assertEqual(ledger['findings'][0]['number'], 11)
        markdown = ledgers.render(ledger, 'Review', [])
        self.assertIn('## Findings from earlier executions (preserved)', markdown)
        self.assertIn('#### F11 — Retry limit', markdown)
        self.assertIn('###### F10 — Six IoT families', markdown)


class StepPlanTest(unittest.TestCase):
    def test_step_size_comes_from_the_lane_capability(self):
        self.assertEqual(steps.step_budget({'agent': {'recommendedStepContext': 32768}, 'context': {'knee': 65536}})['source'], 'agent_workload')
        self.assertEqual(steps.step_budget({'context': {'knee': 32768}})['stepContext'], 32768)
        self.assertEqual(steps.step_budget(None), {'stepContext': 24576, 'docTokens': 8601, 'calls': 16, 'seconds': 1200, 'source': 'default'})
        self.assertEqual(steps.step_budget({'agent': {'recommendedStepContext': 2048}})['stepContext'], 8192)

    def test_groups_related_documents_within_the_budget_and_retries_alone(self):
        ledger = ledgers.new_ledger(snapshot())
        docs = lambda groups: [group['documents'] for group in groups]
        sizes = {'docs/A.md': 36000, 'docs/B.md': 36000, 'docs/sub/C.md': 100}
        self.assertEqual(docs(steps.plan_groups(ledger, sizes, {'docTokens': 15000})), [['docs/A.md'], ['docs/B.md'], ['docs/sub/C.md']])
        self.assertEqual(docs(steps.plan_groups(ledger, sizes, {'docTokens': 50000})), [['docs/A.md', 'docs/B.md'], ['docs/sub/C.md']])
        ledgers.record_failure(ledger, ['docs/A.md', 'docs/B.md'], 1, 'invalid')
        self.assertEqual(docs(steps.plan_groups(ledger, sizes, {'docTokens': 50000})), [['docs/A.md'], ['docs/B.md'], ['docs/sub/C.md']])
        ledger['documents']['docs/sub/C.md']['state'] = 'reviewed'
        self.assertEqual(docs(steps.plan_groups(ledger, sizes, {'docTokens': 50000}, limit=1)), [['docs/A.md']])

    def test_reviews_a_large_document_in_line_ranges_until_every_range_is_done(self):
        ledger = ledgers.new_ledger(snapshot())
        for path in ('docs/B.md', 'docs/sub/C.md'):
            ledger['documents'][path]['state'] = 'reviewed'
        sizes, lines, budget = {'docs/A.md': 72000}, {'docs/A.md': 300}, {'docTokens': 10000}
        first = steps.plan_groups(ledger, sizes, budget, line_counts=lines)[0]
        self.assertEqual(first['range'], (1, 150, False))
        result = {'documents': [{'path': 'docs/A.md', 'state': 'reviewed', 'evidence': [{'path': 'core/config.js', 'line': 1, 'check': 'strict'}]}]}
        ledgers.merge_step(ledger, ['docs/A.md'], result, source, 1, line_range=first['range'])
        self.assertEqual(ledger['documents']['docs/A.md']['state'], 'partial')
        second = steps.plan_groups(ledger, sizes, budget, line_counts=lines)[0]
        self.assertEqual(second['range'], (151, 300, True))
        ledgers.merge_step(ledger, ['docs/A.md'], good_result(), source, 2, line_range=second['range'])
        row = ledger['documents']['docs/A.md']
        self.assertEqual(row['state'], 'reviewed')
        self.assertEqual(len(row['evidence']), 2)
        prompt = steps.group_prompt(ledger, ['docs/A.md'], '/o.json', {}, 'note', second['range'])
        self.assertIn('Review ONLY lines 151-300 of docs/A.md', prompt)
        self.assertIn('strict (core/config.js:1)', prompt)
        self.assertEqual(steps.plan_groups(ledger, sizes, budget, line_counts=lines), [])

    def test_a_document_that_stays_partial_without_progress_stops_being_planned(self):
        ledger = ledgers.new_ledger(snapshot())
        partial = {'documents': [{'path': 'docs/B.md', 'state': 'partial', 'evidence': [], 'note': 'route table unchecked'}]}
        for step in range(1, 4):
            ledgers.merge_step(ledger, ['docs/B.md'], partial, source, step)
        self.assertEqual(ledger['documents']['docs/B.md']['partialRounds'], 3)
        planned = [group['documents'] for group in steps.plan_groups(ledger, {}, {'docTokens': 50000})]
        self.assertNotIn(['docs/B.md'], planned)
        self.assertIn('route table unchecked', ledgers.render(ledger, 'Review', []))

    def test_prompts_carry_only_the_group_and_the_verified_findings(self):
        ledger = ledgers.new_ledger(snapshot())
        ledgers.merge_step(ledger, ['docs/A.md'], good_result(), source, 1)
        task = {'pipelineId': '0939', 'title': 'Documentation peer review',
                'feedback': [{'by': 'operator', 'text': 'Old note'}, {'by': 'coding-team', 'text': 'x'}, {'by': 'operator', 'text': 'F10 is eight families.'}]}
        prompt = steps.group_prompt(ledger, ['docs/A.md', 'docs/B.md'], '/out/step-02.json', task, 'workspace note')
        self.assertIn('- docs/A.md\n- docs/B.md', prompt)
        self.assertIn('F1 (inaccuracy, high) Retry limit is 7, not 5', prompt)
        self.assertIn('F10 is eight families.', prompt)
        self.assertNotIn('Old note', prompt)
        self.assertNotIn('docs/sub/C.md', prompt)
        writer = steps.writer_prompt(ledger, '/out/step-03.json')
        self.assertIn('"id": "F1"', writer)
        self.assertNotIn("const RETRY_LIMIT", writer)


if __name__ == '__main__':
    unittest.main()
