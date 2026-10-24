import importlib.util
import copy
import json
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('coding_direct_plan', HERE / 'coding_direct_plan.py')
direct = importlib.util.module_from_spec(spec)
spec.loader.exec_module(direct)


class BoundedPairTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = 'integrations/coding/example.py'
        self.test = 'integrations/coding/tests/test_example.py'
        for path in [self.source, self.test]:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('VALUE = 1\n')
        self.manifest = {'scope': [self.source, self.test],
                         'verificationProfile': 'agentx-dispatcher-tests/v1',
                         'qualification': {'acceptanceCriteria': ['Observable behavior passes.']}}

    def test_reviewed_pair_becomes_one_integrated_native_tested_step(self):
        before = copy.deepcopy(self.manifest)
        plan = direct.build(self.root, self.manifest)
        self.assertEqual(len(plan['steps']), 1)
        step = plan['steps'][0]
        self.assertEqual(step['paths'], self.manifest['scope'])
        self.assertEqual(step['testTargets'], [self.test])
        self.assertEqual(step['dependsOn'], [])
        command = direct.verification.focused_command(self.root, self.manifest['verificationProfile'], step['testTargets'])
        self.assertEqual(command, ['python3', '-m', 'unittest', self.test])
        self.assertEqual(self.manifest, before)

    def test_complete_pair_context_preserves_current_source_and_test_bytes(self):
        (self.root / self.source).write_text('VALUE = "quoted"\n')
        text = direct.source_context(self.root, self.manifest['scope'])
        files = json.loads(text[text.index('[{'):])
        self.assertEqual(files, [{'path': self.source, 'content': 'VALUE = "quoted"\n'},
                                 {'path': self.test, 'content': 'VALUE = 1\n'}])
        self.assertIn('only editing tools', text)

    def test_context_refuses_links_binary_missing_and_excessive_files(self):
        path = self.root / self.source
        for content in [b'\0', b'\xff', b'x' * (2 * direct.MAX_PAIR_BYTES)]:
            path.write_bytes(content)
            with self.assertRaises(direct.steps.CodePlanError):
                direct.source_context(self.root, self.manifest['scope'])
        path.unlink(); path.symlink_to(self.root / self.test)
        with self.assertRaises(direct.steps.CodePlanError):
            direct.source_context(self.root, self.manifest['scope'])
        path.unlink()
        with self.assertRaises(direct.steps.CodePlanError):
            direct.source_context(self.root, self.manifest['scope'])

    def test_missing_review_or_tighter_native_lane_defers_without_widening_it(self):
        self.manifest.pop('qualification')
        self.assertIsNone(direct.build(self.root, self.manifest))
        self.manifest['qualification'] = {'acceptanceCriteria': ['Observable behavior.']}
        lane = {'agent': {'codeStepLimits': {'maxFilesPerStep': 1}}}
        self.assertIsNone(direct.build(self.root, self.manifest, lane))

    def test_unavailable_or_mismatched_test_defers_to_existing_planning(self):
        self.manifest['verificationProfile'] = 'agentx-core-runner-tests/v1'
        self.assertIsNone(direct.build(self.root, self.manifest))
        self.manifest['verificationProfile'] = 'agentx-dispatcher-tests/v1'
        (self.root / self.test).unlink()
        self.assertIsNone(direct.build(self.root, self.manifest))

    def test_file_and_parent_links_cannot_select_a_different_source(self):
        source = self.root / self.source
        source.unlink()
        source.symlink_to(self.root / self.test)
        self.assertIsNone(direct.build(self.root, self.manifest))
        source.unlink()
        source.write_text('VALUE = 1\n')
        alias = self.root / 'alias'
        alias.symlink_to(self.root / 'integrations', target_is_directory=True)
        self.manifest['scope'][0] = 'alias/coding/example.py'
        self.assertIsNone(direct.build(self.root, self.manifest))

    def test_exact_byte_ceiling_passes_and_larger_input_keeps_existing_planner(self):
        test_size = (self.root / self.test).stat().st_size
        (self.root / self.source).write_bytes(b'x' * (direct.MAX_PAIR_BYTES - test_size))
        self.assertIsNotNone(direct.build(self.root, self.manifest))
        with (self.root / self.source).open('ab') as output:
            output.write(b'x')
        self.assertIsNone(direct.build(self.root, self.manifest))

    def test_other_scope_shapes_are_never_silently_collapsed(self):
        for scope in [[self.source], [self.source, self.test, 'extra.py'],
                      [self.source, self.source], [self.test, 'integrations/coding/tests/test_other.py']]:
            with self.subTest(scope=scope):
                self.manifest['scope'] = scope
                self.assertIsNone(direct.build(self.root, self.manifest))
