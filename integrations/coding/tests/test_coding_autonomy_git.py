import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parents[1]
def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value
r = load('coding_run')
g = load('coding_git')

class GitReconciliationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.remote = self.root / 'origin.git'
        self.base = self.root / 'base'
        self.work = self.root / 'work'
        subprocess.run(['git', 'init', '--bare', '--initial-branch=main', str(self.remote)], check=True, capture_output=True)
        subprocess.run(['git', 'init', '--initial-branch=main', str(self.base)], check=True, capture_output=True)
        self.commit(self.base, 'source.py', 'base\n')
        r.git(self.base, 'remote', 'add', 'origin', str(self.remote))
        r.git(self.base, 'push', 'origin', 'main')
        subprocess.run(['git', 'clone', '--single-branch', '--no-tags', str(self.remote), str(self.work)], check=True, capture_output=True)
        self.branch = 'agentx/coding-task-0001'
        r.git(self.work, 'checkout', '-b', self.branch)

    def commit(self, work, name, text):
        path = work / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        r.git(work, 'add', '--', name)
        r.git(work, *r.AUTHOR, 'commit', '-m', 'Synthetic source change')

    def prepare(self):
        return g.reconcile(r.git, self.work, self.branch, 'main', r.AUTHOR, r.coding_progress.artifact)

    def test_advanced_main_is_merged_and_dirty_local_sources_survive(self):
        (self.work / 'task.py').write_text('unpublished local source\n')
        self.commit(self.base, 'upstream.py', 'concurrent upstream\n')
        r.git(self.base, 'push', 'origin', 'main')
        result = self.prepare()
        self.assertEqual(result['conflicts'], [])
        self.assertEqual((self.work / 'task.py').read_text(), 'unpublished local source\n')
        self.assertEqual((self.work / 'upstream.py').read_text(), 'concurrent upstream\n')
        self.assertEqual(r.git(self.work, 'status', '--porcelain'), '')
        self.assertEqual(g.changes(r.git, self.work, 'origin/main'), ['task.py'])
        self.assertEqual(g.audit(r.git, self.work, 'origin/main', r.coding_progress.artifact, ['task.py']), ['task.py'])

    def test_remote_operator_contribution_is_preserved_without_force(self):
        self.commit(self.work, 'task.py', 'worker\n')
        r.git(self.work, 'push', 'origin', self.branch)
        operator = self.root / 'operator'
        subprocess.run(['git', 'clone', '--single-branch', '--branch', self.branch, str(self.remote), str(operator)], check=True, capture_output=True)
        self.commit(operator, 'operator.py', 'operator contribution\n')
        published = r.git(operator, 'rev-parse', 'HEAD')
        r.git(operator, 'push', 'origin', self.branch)
        self.commit(self.work, 'local.py', 'worker unpublished\n')
        result = self.prepare()
        self.assertEqual(result['manualHead'], published)
        self.assertEqual((self.work / 'operator.py').read_text(), 'operator contribution\n')
        self.assertEqual((self.work / 'local.py').read_text(), 'worker unpublished\n')
        r.git(self.work, 'merge-base', '--is-ancestor', published, 'HEAD')
        r.git(self.work, 'push', 'origin', self.branch)  # A regular push succeeds.

    def test_conflicts_keep_versions_for_worker_and_runner_finishes_metadata(self):
        self.commit(self.work, 'source.py', 'worker version\n')
        self.commit(self.base, 'source.py', 'new main version\n')
        r.git(self.base, 'push', 'origin', 'main')
        result = self.prepare()
        self.assertEqual(result['conflicts'], ['source.py'])
        self.assertIn('<<<<<<<', (self.work / 'source.py').read_text())
        with self.assertRaises(g.GitRefusal):
            g.finish_merge(r.git, self.work, r.AUTHOR)
        self.assertTrue((self.work / '.git/MERGE_HEAD').exists())
        # A synthetic worker result, not a claim of live model qualification.
        (self.work / 'source.py').write_text('worker resolved both versions\n')
        g.finish_merge(r.git, self.work, r.AUTHOR)
        self.assertFalse((self.work / '.git/MERGE_HEAD').exists())
        self.assertEqual(r.git(self.work, 'diff', '--name-only', '--diff-filter=U'), '')

    def test_restarted_runner_retains_interrupted_merge_and_local_resolution(self):
        self.commit(self.work, 'source.py', 'worker version\n')
        self.commit(self.base, 'source.py', 'new main version\n')
        r.git(self.base, 'push', 'origin', 'main')
        self.prepare()
        (self.work / 'source.py').write_text('partially resolved source\n')
        result = self.prepare()
        self.assertTrue(result['interruptedMerge'])
        self.assertEqual((self.work / 'source.py').read_text(), 'partially resolved source\n')

    def test_fetch_does_not_import_unrelated_private_refs(self):
        r.git(self.base, 'push', 'origin', 'main:refs/heads/quarantined-fixture')
        self.prepare()
        self.assertNotIn('quarantined-fixture', r.git(self.work, 'for-each-ref', '--format=%(refname)'))

    def test_artifact_added_then_removed_is_still_refused(self):
        self.commit(self.work, 'receipts/private.json', 'synthetic private receipt\n')
        r.git(self.work, 'rm', 'receipts/private.json')
        r.git(self.work, *r.AUTHOR, 'commit', '-m', 'Remove synthetic receipt')
        self.assertEqual(g.changes(r.git, self.work, 'origin/main'), [])
        with self.assertRaises(g.GitRefusal):
            g.audit(r.git, self.work, 'origin/main', r.coding_progress.artifact, ['source.py'])

    def test_successive_upstream_versions_are_inherited_without_expanding_scope(self):
        self.commit(self.work, 'task.py', 'worker source\n')
        self.commit(self.base, 'upstream.py', 'first upstream version\n')
        r.git(self.base, 'push', 'origin', 'main')
        self.prepare()
        self.commit(self.base, 'upstream.py', 'second upstream version\n')
        r.git(self.base, 'push', 'origin', 'main')
        self.prepare()
        self.assertEqual(g.audit(r.git, self.work, 'origin/main', r.coding_progress.artifact, ['task.py']), ['task.py'])

    def test_outside_scope_conflict_resolution_is_not_inherited(self):
        self.commit(self.work, 'source.py', 'worker conflict\n')
        self.commit(self.base, 'source.py', 'upstream conflict\n')
        r.git(self.base, 'push', 'origin', 'main')
        self.assertEqual(self.prepare()['conflicts'], ['source.py'])
        (self.work / 'source.py').write_text('new resolved version\n')
        g.finish_merge(r.git, self.work, r.AUTHOR)
        with self.assertRaisesRegex(g.GitRefusal, 'authorized file scope'):
            g.audit(r.git, self.work, 'origin/main', r.coding_progress.artifact, ['task.py'])

    def test_foreign_merge_parent_is_not_trusted_as_upstream(self):
        r.git(self.work, 'checkout', '-b', 'foreign-fixture')
        self.commit(self.work, 'outside.py', 'foreign parent content\n')
        foreign = r.git(self.work, 'rev-parse', 'HEAD')
        r.git(self.work, 'checkout', self.branch)
        self.commit(self.work, 'task.py', 'worker source\n')
        r.git(self.work, *r.AUTHOR, 'merge', '--no-edit', foreign)
        with self.assertRaisesRegex(g.GitRefusal, 'authorized file scope'):
            g.audit(r.git, self.work, 'origin/main', r.coding_progress.artifact, ['task.py'])

    def test_secret_added_then_removed_is_still_inspected(self):
        self.commit(self.work, 'source.py', 'ghp_' + 'x' * 30)
        self.commit(self.work, 'source.py', 'base\n')
        self.assertEqual(g.changes(r.git, self.work, 'origin/main'), [])
        with self.assertRaisesRegex(g.GitRefusal, 'credentials'):
            g.audit(r.git, self.work, 'origin/main', r.coding_progress.artifact, ['source.py'])

    def test_mode_change_with_identical_blob_is_not_hidden_by_base(self):
        (self.work / 'source.py').chmod(0o755)
        r.git(self.work, 'add', 'source.py')
        r.git(self.work, *r.AUTHOR, 'commit', '-m', 'Change executable mode')
        (self.work / 'source.py').chmod(0o644)
        r.git(self.work, 'add', 'source.py')
        r.git(self.work, *r.AUTHOR, 'commit', '-m', 'Restore executable mode')
        self.assertEqual(g.changes(r.git, self.work, 'origin/main'), [])
        with self.assertRaisesRegex(g.GitRefusal, 'authorized file scope'):
            g.audit(r.git, self.work, 'origin/main', r.coding_progress.artifact, ['task.py'])

    def test_symlink_with_identical_blob_is_still_refused(self):
        (self.work / 'source.py').unlink()
        (self.work / 'source.py').symlink_to('base\n')
        r.git(self.work, 'add', 'source.py')
        r.git(self.work, *r.AUTHOR, 'commit', '-m', 'Replace source with symlink')
        self.assertEqual(r.git(self.work, 'rev-parse', 'HEAD:source.py'), r.git(self.work, 'rev-parse', 'origin/main:source.py'))
        (self.work / 'source.py').unlink()
        self.commit(self.work, 'source.py', 'base\n')
        with self.assertRaisesRegex(g.GitRefusal, 'link or submodule'):
            g.audit(r.git, self.work, 'origin/main', r.coding_progress.artifact, ['source.py'])

    def test_scope_secrets_and_links_are_refused(self):
        self.commit(self.work, 'source.py', 'ghp_' + 'x' * 30)
        with self.assertRaises(g.GitRefusal):
            g.audit(r.git, self.work, 'origin/main', r.coding_progress.artifact, ['source.py'])
        r.git(self.work, 'reset', '--hard', 'origin/main')  # Disposable fixture only.
        self.commit(self.work, 'outside.py', 'out of scope\n')
        with self.assertRaises(g.GitRefusal):
            g.audit(r.git, self.work, 'origin/main', r.coding_progress.artifact, ['source.py'])

    def test_foreign_branch_is_refused_without_changing_local_files(self):
        r.git(self.work, 'checkout', '-b', 'other-fixture-job')
        (self.work / 'local.py').write_text('keep\n')
        with self.assertRaises(g.GitRefusal): self.prepare()
        self.assertEqual((self.work / 'local.py').read_text(), 'keep\n')

    def test_public_description_uses_final_diff_without_raw_model_output(self):
        self.commit(self.work, 'source.py', 'final change\n')
        body = g.publication_body(r.git, self.work, 'origin/main', '0001', 'passed')
        self.assertIn('source.py', body)
        self.assertNotIn('final change', body)
        self.assertIn('Independent local verification: passed', body)
