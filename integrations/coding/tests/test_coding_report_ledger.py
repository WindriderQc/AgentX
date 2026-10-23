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
    def test_prior_failure_eligibility_requires_each_open_document_and_a_local_failure(self):
        ledger = ledgers.new_ledger(snapshot())
        self.assertFalse(steps.prior_failed_group(ledger, ['docs/A.md']))
        ledger['steps'] = [{'result': 'failed', 'documents': ['docs/A.md']}]
        self.assertTrue(steps.prior_failed_group(ledger, ['docs/A.md']))
        self.assertFalse(steps.prior_failed_group(ledger, ['docs/A.md', 'docs/B.md']))
        ledger['documents']['docs/A.md']['state'] = 'reviewed'
        self.assertFalse(steps.prior_failed_group(ledger, ['docs/A.md']))
        ledger['documents']['docs/A.md']['state'] = 'partial'
        ledger['steps'][0]['escalated'] = True
        self.assertFalse(steps.prior_failed_group(ledger, ['docs/A.md']))
        self.assertFalse(steps.prior_failed_group(ledger, []))

    def test_identical_findings_keep_their_original_number_within_and_across_steps(self):
        ledger = ledgers.new_ledger(snapshot())
        result = good_result()
        result['findings'].append(json.loads(json.dumps(result['findings'][0])))
        first = ledgers.merge_step(ledger, ['docs/A.md'], result, source, 1)
        self.assertEqual((first['findings'], first['duplicateFindings']), (1, 1))
        repeated = good_result()
        repeated['findings'][0]['evidence'][0]['check'] = 'Same source, reworded proof'
        again = ledgers.merge_step(ledger, ['docs/A.md'], repeated, source, 2)
        self.assertEqual((again['findings'], again['duplicateFindings']), (0, 1))
        self.assertEqual([row['number'] for row in ledger['findings']], [1])
        separate = good_result()
        separate['findings'][0]['correction'] = 'A distinct proposed correction.'
        ledgers.merge_step(ledger, ['docs/A.md'], separate, source, 3)
        self.assertEqual([row['number'] for row in ledger['findings']], [1, 2])

    def test_rendering_a_historical_duplicate_preserves_its_embedded_ledger(self):
        ledger = ledgers.new_ledger(snapshot())
        ledgers.merge_step(ledger, ['docs/A.md'], good_result(), source, 1)
        duplicate = json.loads(json.dumps(ledger['findings'][0]))
        duplicate.update(number=22, step=2)
        ledger['findings'].append(duplicate)
        original = json.dumps(ledger, sort_keys=True)
        markdown = ledgers.render(ledger, 'Review')
        self.assertIn('#### F1 — Retry limit', markdown)
        self.assertNotIn('#### F22 — Retry limit', markdown)
        self.assertIn('| 1 | 0 | 0 | 2 | 1 |', markdown)
        self.assertEqual(ledgers.embedded(markdown), ledger)
        self.assertEqual(json.dumps(ledger, sort_keys=True), original)
        writer = steps.writer_prompt({**ledger, 'findings': ledgers.distinct_findings(ledger)}, '/out.json')
        self.assertNotIn('F22', writer)

    def test_duplicate_findings_still_require_valid_frozen_source_evidence(self):
        ledger = ledgers.new_ledger(snapshot())
        ledgers.merge_step(ledger, ['docs/A.md'], good_result(), source, 1)
        before = json.dumps(ledger, sort_keys=True)
        bad = good_result()
        bad['findings'][0]['evidence'][0]['line'] = 999
        with self.assertRaises(ledgers.LedgerError):
            ledgers.merge_step(ledger, ['docs/A.md'], bad, source, 2)
        self.assertEqual(json.dumps(ledger, sort_keys=True), before)

    def test_document_evidence_keeps_detailed_checks_up_to_core_coverage_bound(self):
        ledger = ledgers.new_ledger(snapshot())
        value = good_result()
        value['documents'][0]['evidence'] = [{'path': 'core/config.js', 'line': 2,
            'check': f'Verified claim {number}'} for number in range(48)]
        ledgers.merge_step(ledger, ['docs/A.md'], value, source, 1)
        self.assertEqual(len(ledger['documents']['docs/A.md']['evidence']), 48)
        self.assertEqual(len(ledgers.coverage(ledger)['documents'][0]['evidence']), 48)
        invalid = good_result()
        invalid['documents'][0]['evidence'] = value['documents'][0]['evidence'] + [
            {'path': 'core/config.js', 'line': 99, 'check': 'Invalid late reference'}]
        before = json.dumps(ledger, sort_keys=True)
        with self.assertRaises(ledgers.LedgerError):
            ledgers.merge_step(ledger, ['docs/A.md'], invalid, source, 2)
        self.assertEqual(json.dumps(ledger, sort_keys=True), before)

    def test_document_and_finding_reference_limits_remain_bounded(self):
        for target, count in [('document', ledgers.MAX_DOC_EVIDENCE + 1),
                              ('finding', ledgers.MAX_EVIDENCE + 1)]:
            with self.subTest(target=target):
                ledger = ledgers.new_ledger(snapshot())
                value = good_result()
                row = value['documents'][0] if target == 'document' else value['findings'][0]
                row['evidence'] = [{'path': 'core/config.js', 'line': 2, 'check': 'Checked'}] * count
                with self.assertRaises(ledgers.LedgerError):
                    ledgers.merge_step(ledger, ['docs/A.md'], value, source, 1)
                self.assertEqual(ledger['documents']['docs/A.md']['state'], 'pending')
                self.assertEqual(ledger['steps'], [])

    def test_continuation_restores_local_attempts_for_pending_documents_too(self):
        ledger = ledgers.new_ledger(snapshot())
        ledgers.record_failure(ledger, ['docs/A.md'], 1, 'no result')
        ledger['documents']['docs/B.md']['state'] = 'blocked'
        before = json.loads(json.dumps(ledger['documents']['docs/B.md']))
        ledgers.continuation_retries(ledger, 'new-request', 'parent-request')
        self.assertEqual(ledger['documents']['docs/A.md']['state'], 'pending')
        self.assertEqual(ledger['documents']['docs/A.md']['attempts'], 0)
        self.assertEqual(ledger['documents']['docs/B.md'], before)
        self.assertEqual(ledger['steps'][-1]['documents'], ['docs/A.md'])

    def test_authorized_continuation_retries_failed_documents_without_erasing_work(self):
        ledger = ledgers.new_ledger(snapshot())
        ledgers.merge_step(ledger, ['docs/A.md'], good_result(), source, 1)
        ledgers.record_failure(ledger, ['docs/B.md'], 2, 'no result')
        ledgers.record_failure(ledger, ['docs/B.md'], 3, 'no result')
        row = ledger['documents']['docs/sub/C.md']
        row.update(state='partial', partialRounds=3, ranges=[[1, 1]])
        previous_steps = json.loads(json.dumps(ledger['steps']))
        reviewed = json.loads(json.dumps(ledger['documents']['docs/A.md']))
        ledgers.continuation_retries(ledger, 'new-request', None)
        self.assertEqual(ledger['documents']['docs/B.md']['state'], 'blocked')
        ledgers.continuation_retries(ledger, 'new-request', 'parent-request')
        self.assertEqual(ledger['documents']['docs/B.md']['state'], 'pending')
        self.assertEqual(row['partialRounds'], 0)
        self.assertEqual(row['ranges'], [[1, 1]])
        self.assertEqual(ledger['documents']['docs/A.md'], reviewed)
        self.assertEqual(ledger['steps'][:-1], previous_steps)
        self.assertEqual(ledger['steps'][-1]['parentRequestId'], 'parent-request')
        self.assertEqual(ledger['steps'][-1]['previous'][0]['attempts'], 2)
        self.assertFalse(ledgers.coverage(ledger)['declaredComplete'])
        restored = ledgers.embedded(ledgers.render(ledger, 'Review'))
        before = json.dumps(restored, sort_keys=True)
        ledgers.continuation_retries(restored, 'new-request', 'parent-request')
        self.assertEqual(json.dumps(restored, sort_keys=True), before)

    def test_failed_legacy_corrections_remain_pending_after_checkpoint_restore(self):
        for value in [None, {}, {'legacyEdits': 'invalid'}, {'legacyEdits': ['unexpected']},
                      {'legacyEdits': [1]}, {'legacyEdits': [False]}, {'legacyEdits': [[]]},
                      {'legacyEdits': [{'find': 'missing', 'replace': 'corrected'}]}]:
            with self.subTest(value=value):
                ledger = ledgers.new_ledger(snapshot(), legacy_markdown='Six families.')
                ledger['legacyReviewed'] = True  # Historical flag without a successful receipt.
                self.assertTrue(ledgers.legacy_review_required(ledger, 'Check the family count.'))
                ledgers.merge_legacy_review(ledger, value, 'no result file was written',
                                           'Check the family count.', source, 1, 'a' * 36)
                restored = ledgers.embedded(ledgers.render(ledger, 'Review'))
                self.assertEqual(restored['legacy'], 'Six families.')
                self.assertFalse(restored['legacyReviewed'])
                self.assertEqual(restored['steps'][-1]['result'], 'failed')
                self.assertEqual(restored['steps'][-1]['kind'], 'legacy')
                self.assertTrue(ledgers.legacy_review_required(restored, 'Check the family count.'))
                self.assertIn('corrections to the earlier findings remain pending', ledgers.render(restored, 'Review'))
                for row in restored['documents'].values():
                    row['state'] = 'reviewed'
                self.assertFalse(ledgers.coverage(restored)['declaredComplete'])

    def test_successful_corrections_are_bound_to_notes_and_resulting_content(self):
        ledger = ledgers.new_ledger(snapshot(), legacy_markdown='Six families.')
        result = {'legacyEdits': [{'find': 'Six families.', 'replace': 'Eight families.'}]}
        ledgers.merge_legacy_review(ledger, result, None, 'Check count.', source, 1, 'a' * 36)
        restored = ledgers.embedded(ledgers.render(ledger, 'Review'))
        self.assertFalse(ledgers.legacy_review_required(restored, 'Check count.'))
        self.assertFalse(restored['legacyReviewPending'])
        self.assertEqual(restored['legacy'], 'Eight families.')
        self.assertTrue(ledgers.legacy_review_required(restored, 'Also check the version.'))
        restored['legacy'] += '\nChanged finding.'
        self.assertTrue(ledgers.legacy_review_required(restored, 'Check count.'))

    def test_explicit_empty_corrections_can_acknowledge_already_correct_content(self):
        ledger = ledgers.new_ledger(snapshot(), legacy_markdown='Eight families.')
        ledgers.merge_legacy_review(ledger, {'legacyEdits': []}, None, 'Check count.', source, 1, 'a' * 36)
        self.assertFalse(ledgers.legacy_review_required(ledger, 'Check count.'))

    def test_reviewer_recheck_withdraws_only_selected_coverage_and_preserves_proofs(self):
        ledger = ledgers.new_ledger(snapshot(), legacy_markdown='Earlier findings.')
        ledgers.merge_step(ledger, ['docs/A.md'], good_result(), source, 1)
        for row in ledger['documents'].values():
            row['state'] = 'reviewed'
        row = ledger['documents']['docs/A.md']
        row.update(note='No contradiction found.', ranges=[[1, 3]], attempts=2, partialRounds=3)
        before = json.loads(json.dumps(ledger))
        marker = ledgers.progress_marker(ledger)
        notes = 'The completed docs/A.md missed a source contradiction; recheck it.'
        ledgers.merge_legacy_review(ledger, {'legacyEdits': [], 'recheckDocuments': ['docs/A.md']},
                                   None, notes, source, 2, 'a' * 36)
        self.assertEqual(ledgers.counts(ledger), {'reviewed': 2, 'partial': 1, 'blocked': 0, 'pending': 0})
        self.assertEqual(row['evidence'], before['documents']['docs/A.md']['evidence'])
        self.assertEqual(row['note'], 'No contradiction found.')  # Prior content, not rewritten by the runner.
        self.assertEqual((row['ranges'], row['attempts'], row['partialRounds']), ([], 0, 0))
        self.assertEqual(ledger['findings'], before['findings'])
        self.assertEqual(ledger['steps'][:-1], before['steps'])
        for path in ['docs/B.md', 'docs/sub/C.md']:
            self.assertEqual(ledger['documents'][path], before['documents'][path])
        receipt = ledger['legacyReview']['recheckedDocuments'][0]
        self.assertEqual(receipt['previous'], {key: before['documents']['docs/A.md'][key]
            for key in ('state', 'note', 'ranges', 'attempts', 'partialRounds')})
        self.assertEqual(receipt['sha256'], before['documents']['docs/A.md']['sha256'])
        self.assertFalse(any(ledgers.progress_marker(ledger)[key] - marker[key] for key in marker))
        restored = ledgers.embedded(ledgers.render(ledger, 'Review'))
        self.assertFalse(ledgers.coverage(restored)['declaredComplete'])
        self.assertFalse(ledgers.legacy_review_required(restored, notes))
        self.assertIn('docs/A.md', steps.plan_groups(restored,
            {path: len(source(path)) for path in restored['documents']}, steps.step_budget(None))[0]['documents'])

    def test_invalid_rechecks_cannot_apply_other_corrections_or_advance_coverage(self):
        for paths, notes, changed_source, bad_legacy in [
            (None, 'Recheck.', False, False), (['missing.md'], 'Recheck.', False, False),
            (['docs/A.md', 'docs/A.md'], 'Recheck.', False, False),
            (['docs/B.md'], 'Recheck.', False, False), (['docs/A.md'], '', False, False),
            (['docs/A.md'], 'Recheck.', True, False), (['docs/A.md'], 'Recheck.', False, True),
            (['docs/A.md'] * (ledgers.MAX_LEGACY_EDITS + 1), 'Recheck.', False, False),
        ]:
            with self.subTest(paths=paths, changed_source=changed_source, bad_legacy=bad_legacy):
                ledger = ledgers.new_ledger(snapshot(), legacy_markdown='Earlier findings.')
                ledgers.merge_step(ledger, ['docs/A.md'], good_result(), source, 1)
                before = json.loads(json.dumps(ledger))
                value = {'legacyEdits': [{'find': 'missing' if bad_legacy else 'Earlier', 'replace': 'Checked'}],
                    'evidenceEdits': [{'document': 'docs/A.md', 'path': 'core/config.js', 'line': 2,
                                      'find': 'RETRY_LIMIT value', 'replace': 'Corrected proof text'}],
                    'recheckDocuments': paths}
                get = lambda path: b'# Changed\n' if changed_source and path == 'docs/A.md' else source(path)
                ledgers.merge_legacy_review(ledger, value, None, notes, get, 2, 'a' * 36)
                for key in ('documents', 'findings', 'legacy'):
                    self.assertEqual(ledger[key], before[key])
                self.assertEqual(ledger['steps'][-1]['result'], 'failed')

    def test_same_reviewer_notes_cannot_reopen_completed_work_twice(self):
        ledger = ledgers.new_ledger(snapshot(), legacy_markdown='Earlier findings.')
        ledgers.merge_step(ledger, ['docs/A.md'], good_result(), source, 1)
        notes = 'Recheck docs/A.md.'
        value = {'legacyEdits': [], 'recheckDocuments': ['docs/A.md']}
        ledgers.merge_legacy_review(ledger, value, None, notes, source, 2, 'a' * 36)
        ledgers.merge_step(ledger, ['docs/A.md'], good_result(), source, 3)
        before = json.loads(json.dumps(ledger['documents']))
        for step_id, feedback, answer in [(4, notes, value), (5, notes, value),
                (6, 'Another correction.', {'legacyEdits': [{'find': 'missing', 'replace': 'Changed'}]}),
                (7, notes, value)]:
            ledgers.merge_legacy_review(ledger, answer, None, feedback, source, step_id, 'a' * 36)
            self.assertEqual(ledger['documents'], before)
            self.assertEqual(ledger['steps'][-1]['result'], 'failed')

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
    def test_retry_receives_rejection_and_its_own_existing_json_path(self):
        ledger = ledgers.new_ledger(snapshot())
        ledgers.record_failure(ledger, ['docs/A.md'], 3, 'docs/B.md is outside this group')
        ledger['steps'][-1].update(requestId='current-run', jsonResultAvailable=True)
        output = '/home/agent/deliverables/current-run/step-04.json'
        prompt = steps.group_prompt(ledger, ['docs/A.md'], output, {}, 'workspace')
        self.assertIn('Previous result rejected', prompt)
        self.assertIn('docs/B.md is outside this group', prompt)
        self.assertIn('/home/agent/deliverables/current-run/step-03.json', prompt)
        self.assertIn('Do not overwrite the earlier file', prompt)
        self.assertEqual(ledger['documents']['docs/A.md']['state'], 'pending')

    def test_retry_does_not_invent_an_artifact_for_another_request_or_missing_result(self):
        ledger = ledgers.new_ledger(snapshot())
        ledgers.record_failure(ledger, ['docs/A.md'], 3, 'invalid result')
        row = ledger['steps'][-1]
        for metadata in [{'requestId': 'earlier-run', 'jsonResultAvailable': True},
                         {'requestId': 'current-run', 'jsonResultAvailable': False},
                         {'requestId': 'current-run', 'jsonResultAvailable': True, 'step': True}]:
            ledger['steps'][-1] = {**row, **metadata}
            text = steps.retry_feedback(ledger, ['docs/A.md'], '/out/current-run/step-04.json')
            self.assertIn('invalid result', text)
            self.assertNotIn('Read your rejected JSON', text)

    def test_new_continuation_and_successful_retry_do_not_receive_stale_failures(self):
        ledger = ledgers.new_ledger(snapshot())
        ledgers.record_failure(ledger, ['docs/A.md'], 1, 'stale error')
        ledger['documents']['docs/A.md']['attempts'] = 0
        self.assertEqual(steps.retry_feedback(ledger, ['docs/A.md'], '/new/step-02.json'), '')
        ledger['documents']['docs/A.md']['attempts'] = 1
        ledgers.merge_step(ledger, ['docs/A.md'], good_result(), source, 2)
        self.assertEqual(steps.retry_feedback(ledger, ['docs/A.md'], '/new/step-03.json'), '')

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
        self.assertEqual(docs(steps.plan_groups(ledger, sizes, {'docTokens': 50000})), [['docs/sub/C.md'], ['docs/A.md'], ['docs/B.md']])
        ledger['documents']['docs/sub/C.md']['state'] = 'reviewed'
        self.assertEqual(docs(steps.plan_groups(ledger, sizes, {'docTokens': 50000}, limit=1)), [['docs/A.md']])

    def test_a_failed_range_waits_for_unfailed_groups_and_ranges_without_losing_its_scope(self):
        ledger = ledgers.new_ledger(snapshot())
        sizes = {'docs/A.md': 72000, 'docs/B.md': 72000, 'docs/sub/C.md': 100}
        lines = {'docs/A.md': 300, 'docs/B.md': 300}
        ledgers.record_failure(ledger, ['docs/A.md'], 1, 'no result file was written')
        planned = steps.plan_groups(ledger, sizes, {'docTokens': 10000}, line_counts=lines)
        self.assertEqual([group['documents'] for group in planned],
                         [['docs/sub/C.md'], ['docs/B.md'], ['docs/A.md']])
        self.assertEqual(planned[-1]['range'], (1, 150, False))
        self.assertEqual(ledger['documents']['docs/A.md']['attempts'], 1)
        self.assertEqual(ledger['documents']['docs/A.md']['state'], 'pending')
        self.assertEqual(ledger['documents']['docs/A.md']['ranges'], [])
        self.assertEqual(ledger['steps'][0]['reason'], 'no result file was written')

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

    def test_completing_a_stalled_range_keeps_its_evidence_and_opens_the_next_range(self):
        ledger = ledgers.new_ledger(snapshot())
        for path in ('docs/B.md', 'docs/sub/C.md'):
            ledger['documents'][path]['state'] = 'reviewed'
        row = ledger['documents']['docs/A.md']
        row.update(state='partial', partialRounds=3, attempts=1)
        result = good_result()
        ledgers.merge_step(ledger, ['docs/A.md'], result, source, 4, line_range=(1, 150, False))
        self.assertEqual(row['state'], 'partial')
        self.assertEqual((row['attempts'], row['partialRounds']), (0, 0))
        self.assertEqual(row['ranges'], [[1, 150]])
        self.assertEqual(len(row['evidence']), 1)
        planned = steps.plan_groups(ledger, {'docs/A.md': 72000}, {'docTokens': 10000}, line_counts={'docs/A.md': 300})
        self.assertEqual(planned[0]['range'], (151, 300, True))

    def test_untouched_documents_run_before_a_started_one_even_after_a_continuation(self):
        ledger = ledgers.new_ledger(snapshot())
        sizes = {'docs/A.md': 3600, 'docs/B.md': 3600, 'docs/sub/C.md': 3600}
        partial = {'documents': [{'path': 'docs/A.md', 'state': 'partial',
                                  'evidence': [{'path': 'core/config.js', 'line': 1, 'check': 'strict'}]}]}
        ledgers.merge_step(ledger, ['docs/A.md'], partial, source, 1)
        ledgers.record_failure(ledger, ['docs/B.md'], 2, 'no result file was written')
        ledgers.continuation_retries(ledger, 'next-run', 'earlier-run')
        self.assertEqual(ledger['documents']['docs/B.md']['attempts'], 0)
        planned = [group['documents'] for group in steps.plan_groups(ledger, sizes, {'docTokens': 50000})]
        self.assertEqual(planned, [['docs/B.md'], ['docs/sub/C.md'], ['docs/A.md']])

    def test_a_long_document_within_the_token_budget_is_reviewed_in_equal_ranges(self):
        ledger = ledgers.new_ledger(snapshot())
        for path in ('docs/B.md', 'docs/sub/C.md'):
            ledger['documents'][path]['state'] = 'reviewed'
        sizes, lines, budget = {'docs/A.md': 36000}, {'docs/A.md': 913}, {'docTokens': 22937}
        ranges = []
        for step in range(1, 6):
            planned = steps.plan_groups(ledger, sizes, budget, line_counts=lines)
            if not planned:
                break
            ranges.append(planned[0]['range'])
            ledgers.merge_step(ledger, ['docs/A.md'], good_result(), source, step, line_range=planned[0]['range'])
        self.assertEqual(ranges, [(1, 229, False), (230, 458, False), (459, 687, False), (688, 913, True)])
        self.assertEqual(ledger['documents']['docs/A.md']['state'], 'reviewed')
        self.assertEqual(ledger['documents']['docs/A.md'].get('partialRounds', 0), 0)

    def test_absolute_snapshot_paths_are_accepted_as_repository_paths(self):
        ledger = ledgers.new_ledger(snapshot())
        result = good_result()
        result['documents'][0]['path'] = '/workspace/docs/A.md'
        result['documents'][0]['evidence'][0]['path'] = '/workspace/core/config.js'
        result['findings'][0]['document']['path'] = './docs/A.md'
        result['findings'][0]['evidence'][0]['path'] = '/workspace/./core/config.js'
        ledgers.merge_step(ledger, ['docs/A.md'], result, source, 1)
        row = ledger['documents']['docs/A.md']
        self.assertEqual(row['state'], 'reviewed')
        self.assertEqual(row['evidence'][0]['path'], 'core/config.js')
        self.assertEqual(ledger['findings'][0]['document']['path'], 'docs/A.md')
        self.assertEqual(ledger['findings'][0]['evidence'][0]['path'], 'core/config.js')
        outside = good_result()
        outside['documents'][0]['evidence'][0]['path'] = '/etc/passwd'
        with self.assertRaises(ledgers.LedgerError):
            ledgers.merge_step(ledgers.new_ledger(snapshot()), ['docs/A.md'], outside, source, 1)

    def test_a_long_note_is_kept_whole_for_the_next_step_and_only_capped_with_a_marker(self):
        ledger = ledgers.new_ledger(snapshot())
        remains = 'Still unchecked: ' + '; '.join(f'claim {n} at line {n}' for n in range(60))
        self.assertGreater(len(remains), 600)
        partial = {'documents': [{'path': 'docs/A.md', 'state': 'partial',
                                  'evidence': [{'path': 'core/config.js', 'line': 1, 'check': 'strict'}], 'note': remains}]}
        ledgers.merge_step(ledger, ['docs/A.md'], partial, source, 1)
        self.assertEqual(ledger['documents']['docs/A.md']['note'], remains)
        self.assertIn('claim 59 at line 59', steps.group_prompt(ledger, ['docs/A.md'], '/o.json', {}, 'note'))
        self.assertNotIn('claim 59 at line 59', ledgers.render(ledger, 'Review', []).split('## Coverage')[1])
        huge = good_result()
        huge['documents'][0]['note'] = 'x' * 9000
        ledgers.merge_step(ledgers.new_ledger(snapshot()), ['docs/A.md'], huge, source, 1)
        capped = ledgers.new_ledger(snapshot())
        ledgers.merge_step(capped, ['docs/A.md'], huge, source, 1)
        self.assertEqual(len(capped['documents']['docs/A.md']['note']), 4000)
        self.assertTrue(capped['documents']['docs/A.md']['note'].endswith('[note truncated]'))
        empty = good_result()
        empty['documents'][0]['note'] = '   '
        ledgers.merge_step(ledgers.new_ledger(snapshot()), ['docs/A.md'], empty, source, 1)
        bad = good_result()
        bad['documents'][0]['note'] = ['not text']
        with self.assertRaises(ledgers.LedgerError):
            ledgers.merge_step(ledgers.new_ledger(snapshot()), ['docs/A.md'], bad, source, 1)

    def test_a_document_that_stays_partial_without_progress_stops_being_planned(self):
        ledger = ledgers.new_ledger(snapshot())
        partial = {'documents': [{'path': 'docs/B.md', 'state': 'partial', 'evidence': [], 'note': 'route table unchecked'}]}
        for step in range(1, 4):
            ledgers.merge_step(ledger, ['docs/B.md'], partial, source, step)
        self.assertEqual(ledger['documents']['docs/B.md']['partialRounds'], 3)
        planned = [group['documents'] for group in steps.plan_groups(ledger, {}, {'docTokens': 50000})]
        self.assertNotIn(['docs/B.md'], planned)
        self.assertIn('route table unchecked', ledgers.render(ledger, 'Review', []))

    def test_rewording_the_same_source_cannot_reset_the_partial_round_limit(self):
        ledger = ledgers.new_ledger(snapshot())
        for step in range(1, 5):
            result = {'documents': [{'path': 'docs/B.md', 'state': 'partial',
                'evidence': [{'path': 'core/config.js', 'line': 1, 'check': f'Same source, wording {step}'}]}]}
            ledgers.merge_step(ledger, ['docs/B.md'], result, source, step)
        self.assertEqual(ledger['documents']['docs/B.md']['partialRounds'], 3)
        planned = steps.plan_groups(ledger, {}, {'docTokens': 50000})
        self.assertNotIn(['docs/B.md'], [row['documents'] for row in planned])
        self.assertEqual(len(ledger['documents']['docs/B.md']['evidence']), 4)

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


class EscalationContextTest(unittest.TestCase):
    def test_a_range_selects_its_cited_source_before_earlier_evidence(self):
        ledger = ledgers.new_ledger(snapshot())
        ledgers.merge_step(ledger, ['docs/A.md'], good_result(), source, 1)
        docs = {'docs/A.md': 'See core/config.js and EARLY_ONLY.\nSee core/later.js and `LATER_ONLY`.'}
        scoped = steps.scoped_texts(docs, (2, 2, True))
        self.assertNotIn('EARLY_ONLY', scoped['docs/A.md'])
        self.assertEqual(steps.code_terms(scoped), ['LATER_ONLY'])
        self.assertEqual(steps.referenced_sources(ledger, ['docs/A.md'], scoped,
            ['core/config.js', 'core/later.js']), ['core/later.js', 'core/config.js'])

    def test_prior_local_failures_cover_only_their_recorded_scope(self):
        ledger = ledgers.new_ledger(snapshot())
        ledger['steps'] = [{'result': 'failed', 'documents': ['docs/A.md'], 'lineRange': [1, 150, False]}]
        self.assertTrue(steps.prior_failed_group(ledger, ['docs/A.md'], (1, 150, False)))
        self.assertFalse(steps.prior_failed_group(ledger, ['docs/A.md'], (151, 300, True)))
        self.assertFalse(steps.prior_failed_group(ledger, ['docs/A.md']))
        del ledger['steps'][0]['lineRange']
        self.assertTrue(steps.prior_failed_group(ledger, ['docs/A.md'], (151, 300, True)))
        ledger['documents']['docs/A.md']['state'] = 'reviewed'
        self.assertFalse(steps.prior_failed_group(ledger, ['docs/A.md'], (151, 300, True)))

    def test_finds_the_sources_a_group_cites_or_names(self):
        ledger = ledgers.new_ledger(snapshot())
        ledgers.merge_step(ledger, ['docs/A.md'], good_result(), source, 1)
        docs = {'docs/A.md': 'See core/config.js and missing/file.js.', 'docs/B.md': 'Uses `RETRY_LIMIT` and `start()`; RETRY_LIMIT again, MAX_POOL_SIZE.'}
        self.assertEqual(steps.referenced_sources(ledger, ['docs/A.md'], docs, ['core/config.js', 'docs/A.md']), ['core/config.js'])
        self.assertEqual(steps.code_terms({'docs/B.md': docs['docs/B.md']}), ['RETRY_LIMIT', 'MAX_POOL_SIZE'])

    def test_the_cloud_request_carries_numbered_sources_and_the_schema(self):
        messages = steps.escalation_prompt(ledgers.new_ledger(snapshot()), ['docs/A.md'], {'docs/A.md': 'line1\nline2\nline3'},
                                           {'core/config.js': 'a\nb'}, (2, 3, True))
        user = messages[1]['content']
        self.assertIn('=== DOCUMENT docs/A.md (lines 2-3) ===\nline2\nline3', user)
        self.assertIn('=== SOURCE core/config.js (line numbers prefixed) ===\n1: a\n2: b', user)
        self.assertIn('Review lines 2-3 of the documents above', user)
        self.assertEqual(steps.parse_json_object('```json\n{"documents": []}\n```'), ({'documents': []}, None))
        self.assertEqual(steps.parse_json_object('no json')[1], 'the answer contains no JSON object')


if __name__ == '__main__':
    unittest.main()
