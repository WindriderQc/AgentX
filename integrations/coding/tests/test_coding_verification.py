import importlib.util
from pathlib import Path
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location('coding_verification', Path(__file__).resolve().parents[1] / 'coding_verification.py')
verification = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verification)


class VerificationCommandTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for name in ('integrations/coding/tests/test_worker.py', 'core/tests/unit/example.test.js',
                     'benchmark/tests/example.test.js'):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('// fixture')

    def test_python_targets_use_the_fixed_profile(self):
        self.assertEqual(verification.focused_command(self.root, 'agentx-dispatcher-tests/v1',
          ['integrations/coding/tests/test_worker.py']),
          ['python3', '-m', 'unittest', 'integrations/coding/tests/test_worker.py'])

    def test_jest_targets_keep_the_installed_config(self):
        command = verification.focused_command(self.root, 'agentx-core-runner-tests/v1',
                                                ['core/tests/unit/example.test.js'])
        self.assertIn('core/jest.coding.config.js', command)
        self.assertEqual(command[-2:], ['--runTestsByPath', 'core/tests/unit/example.test.js'])

    def test_unknown_missing_duplicate_and_escaping_targets_refuse(self):
        cases = [
            ('unknown', ['core/tests/unit/example.test.js']),
            ('agentx-core-runner-tests/v1', []),
            ('agentx-core-runner-tests/v1', ['../secret.js']),
            ('agentx-core-runner-tests/v1', ['/core/tests/unit/example.test.js']),
            ('agentx-core-runner-tests/v1', ['benchmark/tests/example.test.js']),
            ('agentx-core-runner-tests/v1', ['core/tests/unit/missing.test.js']),
            ('agentx-core-runner-tests/v1', ['core/tests/unit/example.test.js'] * 2),
        ]
        for profile, targets in cases:
            with self.subTest(profile=profile, targets=targets), self.assertRaises(verification.VerificationError):
                verification.focused_command(self.root, profile, targets)

    def test_plan_preflight_accepts_a_profile_compatible_test_created_by_its_step(self):
        target = 'core/tests/unit/new.test.js'
        command = verification.focused_command(self.root, 'agentx-core-runner-tests/v1', [target],
                                                require_exists=False)
        self.assertEqual(command[-2:], ['--runTestsByPath', target])
        with self.assertRaises(verification.VerificationError):
            verification.focused_command(self.root, 'agentx-core-runner-tests/v1', [target])

    def test_schedule_profile_runs_only_named_ui_suites_with_installed_configuration(self):
        profile = verification.SCHEDULE_UI
        for target in profile['testFiles']:
            path = self.root / target
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('// fixture')
        targets = list(profile['testFiles'])
        command = verification.focused_command(self.root, profile['id'], targets)
        self.assertEqual(command[:5], ['/opt/node/bin/node', 'core/node_modules/jest/bin/jest.js',
                                     '--config', '/opt/coding/jest.schedule-ui.config.cjs', '--runInBand'])
        self.assertEqual(command[5:], ['--runTestsByPath', *targets])
        self.assertNotIn('--runTestsByPath', verification.full_command(profile['id']))

    def test_schedule_profile_refuses_unreviewed_tests_even_before_file_creation(self):
        for target in ['core/tests/unit/unrelated.test.js',
                       'core/tests/unit/clusterScheduleInventedUi.test.js',
                       'core/public/js/cluster-schedule-upcoming.js',
                       'core/tests/unit/../unit/clusterScheduleUpcomingUi.test.js']:
            with self.subTest(target=target), self.assertRaises(verification.VerificationError):
                verification.focused_command(self.root, verification.SCHEDULE_UI['id'], [target],
                                            require_exists=False)


if __name__ == '__main__':
    unittest.main()
