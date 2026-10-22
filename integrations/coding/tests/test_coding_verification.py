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


if __name__ == '__main__':
    unittest.main()
