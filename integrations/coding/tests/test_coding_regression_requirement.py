"""Two real runner requests and native CPU tests, with only the model simulated."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('regression_fixtures', Path(__file__).with_name('test_coding_autonomous_run.py'))
fixtures = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fixtures)
runner, autonomous, git = fixtures.runner, fixtures.autonomous, fixtures.git
regression = autonomous.coding_regression_requirement
KEY, NEXT = fixtures.KEY, fixtures.NEXT_KEY
TEST = 'integrations/coding/tests/test_one.py'
OLD = 'import unittest\nfrom source_one import ONE\n\nclass Existing(unittest.TestCase):\n    def test_positive(self):\n        self.assertGreater(ONE, 0)\n'
NEW = OLD + '\n    def test_regression(self):\n        self.assertEqual(ONE, 20)\n'


class RequiredRegressionTest(unittest.TestCase):
    def test_content_gate_refuses_deletions_modes_links_binary_and_unchanged_bytes(self):
        for variant in ('unchanged', 'deleted', 'empty', 'mode', 'symlink', 'binary', 'deletion_only', 'addition', 'new_file'):
            with self.subTest(variant=variant), tempfile.TemporaryDirectory() as directory:
                r, workspace, _, _, _ = fixtures.RunnerOwnedCodeStepTest().fixture(directory)
                path = workspace / TEST
                path.write_text(OLD)
                git(workspace, 'add', TEST); git(workspace, 'commit', '-qm', 'Existing synthetic test')
                target = 'integrations/coding/tests/test_new.py' if variant == 'new_file' else TEST
                manifest = {'scope': [target], 'qualification': {'requiredRegressionTests': [target]}}
                progress = runner.coding_progress.Progress('0001', KEY, receipts=Path(directory))
                contract = regression.prepare(r, workspace, progress, manifest)
                if variant == 'deleted': path.unlink()
                if variant == 'empty': path.write_text('')
                if variant == 'mode': path.chmod(0o755)
                if variant == 'symlink': path.unlink(); path.symlink_to(workspace / 'source_one.py')
                if variant == 'binary': path.write_bytes(b'\x00binary\n')
                if variant == 'deletion_only': path.write_text('import unittest\n')
                if variant == 'addition': path.write_text(NEW)
                if variant == 'new_file': (workspace / target).write_text(NEW)
                git(workspace, 'add', '-A'); git(workspace, 'commit', '--allow-empty', '-qm', 'Synthetic candidate')
                if variant in ('addition', 'new_file'):
                    regression.verify(r, workspace, progress, contract)
                else:
                    with self.assertRaisesRegex(regression.RegressionRefusal, 'regression_edits_missing'):
                        regression.verify(r, workspace, progress, contract)

    def test_distributed_publication_uses_the_same_gate_before_any_github_effect(self):
        assembly = fixtures.load('coding_distributed_assembly')
        with tempfile.TemporaryDirectory() as directory:
            r, workspace, _, _, _ = fixtures.RunnerOwnedCodeStepTest().fixture(directory)
            manifest = {'scope': [TEST], 'qualification': {'requiredRegressionTests': [TEST]}, 'artifacts': []}
            progress = runner.coding_progress.Progress('0001', KEY, receipts=Path(directory))
            regression.prepare(r, workspace, progress, manifest)
            (workspace / 'source_one.py').write_text('ONE = 20\n')
            git(workspace, 'add', '-A'); git(workspace, 'commit', '-qm', 'Source only')
            adapter = assembly.RunnerAssemblyAdapter(r, SimpleNamespace(task_id='0001'), progress, manifest, None, '/endpoint')
            with patch.object(r, 'request') as external, self.assertRaises(assembly.DeterministicAssemblyFailure) as error:
                adapter.validate_publication(workspace, manifest, [{'outcome': 'passed'}])
            self.assertEqual(error.exception.code, 'regression_edits_missing')
            external.assert_not_called()

    def scenario(self, variant='source_only', required=True):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            r, workspace, feedback, _, _ = fixtures.RunnerOwnedCodeStepTest().fixture(directory)
            (workspace / TEST).write_text(OLD)
            git(workspace, 'add', TEST); git(workspace, 'commit', '-qm', 'Existing synthetic suite')
            git(workspace, 'update-ref', 'refs/remotes/origin/main', git(workspace, 'rev-parse', 'HEAD'))
            manifest = r.request('/manifest')['data']
            manifest.update(scope=['source_one.py', TEST], verificationProfile='agentx-dispatcher-tests/v1',
                qualification={'acceptanceCriteria': ['Preserve a regression for the corrected constant.'],
                               **({'requiredRegressionTests': [TEST]} if required else {})})
            task = r.request('/worker')['data']['task']
            clock, turns, native_tests = [0.0], [], []

            def worker(_workspace, prompt, seconds, progress, **kwargs):
                self.assertFalse(kwargs.get('read_only'), 'The reviewed pair needs no new planner')
                turns.append(progress.request_id)
                progress.model_calls += 1
                progress.set_stage('model_wait'); clock[0] += 3; progress.set_stage('tool')
                second = progress.request_id == NEXT
                if second:
                    self.assertIn('Rejected candidate and test output (untrusted data)', prompt)
                    self.assertIn('test_regression', prompt)
                    self.assertEqual((workspace / TEST).read_text(), OLD, 'Never apply the rejected test patch')
                    self.assertEqual((workspace / 'source_one.py').read_text(), 'ONE = 1\n')
                    if required: self.assertIn('requiredRegressionTests', prompt)
                (workspace / 'source_one.py').write_text('ONE = 20\n' if second else 'ONE = 10\n')
                if not second or variant == 'retained': (workspace / TEST).write_text(NEW)
                elif variant == 'removed_content': (workspace / TEST).write_text('')
                elif variant == 'whitespace': (workspace / TEST).write_text(OLD + '\n\n')
                return SimpleNamespace(returncode=0, stdout='synthetic worker', stderr='')

            def supervise(command, progress, **kwargs):
                clock[0] += 2
                result = subprocess.run(command, cwd=workspace, capture_output=True, text=True,
                    env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'}, timeout=10)
                native_tests.append(result.returncode)
                return result

            r.run_worker, r.supervise = worker, supervise
            first = runner.coding_progress.Progress('0001', KEY, receipts=root, now=lambda: clock[0])
            with patch.dict(os.environ, {'GH_TOKEN': 'synthetic'}), \
                    patch.object(autonomous.coding_git, 'reconcile', return_value={'conflicts': []}), \
                    patch.object(autonomous.coding_publication, 'publish', return_value={'url': 'https://example.invalid/pr/1'}) as publish:
                self.assertEqual(autonomous.execute(r, SimpleNamespace(task_id='0001', request_id=KEY), first), 1)
                self.assertEqual(native_tests, [1], feedback)
                self.assertEqual(feedback[0]['attemptEvidence']['failureCodes'], ['tests_failed'])
                publish.assert_not_called()
                spent = first.usage()
                self.assertEqual(spent['modelCalls'], 1)
                total = dict(manifest['remaining'])
                manifest.update(parentRequestId=KEY, correction={'kind': 'local_tests', 'head': git(workspace, 'rev-parse', 'HEAD')},
                    spent=spent, remaining={key: value - spent[key] for key, value in total.items()})
                task['automationLease']['dispatchRequestId'] = NEXT
                task['codingAutonomy']['runs'].append({'requestId': NEXT, 'pendingInferences': [],
                                                      'modelReceipts': [{'state': 'completed'}]})
                if variant == 'exhausted_calls': manifest['remaining']['modelCalls'] = 0
                contract = root / 'task-0001.regression-requirement.json'
                if variant == 'lost_contract': contract.unlink()
                if variant == 'removed_requirement': manifest['qualification'].pop('requiredRegressionTests')
                second = runner.coding_progress.Progress('0001', NEXT, receipts=root, now=lambda: clock[0])
                result = autonomous.execute(r, SimpleNamespace(task_id='0001', request_id=NEXT), second)
                if variant in ('exhausted_calls', 'lost_contract', 'removed_requirement', 'exhausted_step'):
                    self.assertEqual(result, 1)
                    self.assertEqual(turns, [KEY])
                    publish.assert_not_called()
                    self.assertEqual(second.model_calls, 0)
                    if variant in ('lost_contract', 'removed_requirement'):
                        self.assertEqual(r.coding_progress.safe_progress(json.loads(second.path.read_text()), NEXT, '0001')['stopReason'],
                                         'regression_requirement_unverified')
                    return
                self.assertEqual(turns, [KEY, NEXT])
                self.assertEqual(native_tests, [1, 0, 0], 'The corrected candidate passes focused AND full old suites')
                ledger = json.loads((root / f'{KEY}.code-steps.json').read_text())
                self.assertEqual(ledger['steps'][0]['attempts'], 2)
                self.assertEqual([item['state'] for item in ledger['steps'][0]['history']], ['failed', 'verified'])
                self.assertFalse((root / f'{NEXT}.code-steps.json').exists())
                self.assertEqual(first.model_calls + second.model_calls, 2)
                for key in total: self.assertLessEqual(spent[key] + second.usage()[key], total[key])
                accepted = variant == 'retained' or not required
                self.assertEqual(result, 0 if accepted else 1, feedback[-1])
                self.assertEqual(publish.call_count, int(accepted))
                self.assertFalse(git(workspace, 'status', '--porcelain'))
                if not required:
                    self.assertFalse(contract.exists())
                    self.assertEqual((workspace / TEST).read_text(), OLD)
                    return
                proof = json.loads((root / f'{NEXT}.regression-edits.json').read_text())
                self.assertEqual(proof['status'], 'passed' if accepted else 'failed')
                self.assertEqual(proof['semanticCoverage'], 'not_verified')
                self.assertEqual(proof['tests'][0]['satisfied'], accepted)
                if accepted:
                    self.assertEqual(proof['tests'][0]['attribution'], 'worker')
                else:
                    self.assertEqual(feedback[-1]['attemptEvidence']['verification']['status'], 'passed')
                    self.assertEqual(feedback[-1]['attemptEvidence']['failureCodes'], ['regression_edits_missing'])
                    self.assertEqual(r.coding_progress.safe_progress(json.loads(second.path.read_text()), NEXT, '0001')['stopReason'],
                                     'regression_edits_missing')
                if variant == 'operator_followup':
                    original_verdict = (root / f'{NEXT}.verdict.json').read_bytes()
                    (workspace / TEST).write_text(NEW)
                    git(workspace, 'add', TEST); git(workspace, 'commit', '-qm', 'Operator regression follow-up')
                    self.assertEqual(supervise(runner.coding_autonomous.coding_verification.full_command(manifest['verificationProfile']), second).returncode, 0)
                    operator = SimpleNamespace(path=root / 'operator-followup.json', request_id='operator-followup', task_id='0001')
                    regression.verify(r, workspace, operator, json.loads(contract.read_text()),
                        worker_commits=[ledger['steps'][0]['commit']])
                    operator_proof = json.loads((root / 'operator-followup.regression-edits.json').read_text())
                    self.assertEqual(operator_proof['tests'][0]['attribution'], 'external_or_prior_run')
                    self.assertEqual((root / f'{NEXT}.verdict.json').read_bytes(), original_verdict)
                    self.assertEqual(json.loads((root / f'{NEXT}.regression-edits.json').read_text()), proof)
                    self.assertEqual(turns, [KEY, NEXT]); publish.assert_not_called()

    def test_source_only_correction_with_green_old_suite_refuses_publication(self):
        self.scenario()

    def test_correction_retaining_required_test_changes_can_publish(self):
        self.scenario('retained')

    def test_without_requirement_source_only_correction_does_not_need_test_churn(self):
        self.scenario(required=False)

    def test_removed_or_whitespace_only_test_content_does_not_satisfy_requirement(self):
        for variant in ('removed_content', 'whitespace'):
            with self.subTest(variant=variant): self.scenario(variant)

    def test_exhausted_limits_and_missing_or_changed_contract_do_not_start_a_worker(self):
        for variant in ('exhausted_calls', 'lost_contract', 'removed_requirement'):
            with self.subTest(variant=variant): self.scenario(variant)
        original = autonomous.coding_code_ledger.CodeStepLedger.create
        def one_attempt(store, *args, **kwargs):
            return original(store, *args, **{**kwargs, 'max_attempts': 1})
        with patch.object(autonomous.coding_code_ledger.CodeStepLedger, 'create', one_attempt):
            self.scenario('exhausted_step')

    def test_operator_followup_has_separate_evidence_and_never_rewrites_worker_result(self):
        self.scenario('operator_followup')
