import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location(
    "coding_step_workspace", Path(__file__).resolve().parents[1] / "coding_step_workspace.py")
workspace = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(workspace)


def git(repository, *args, env=None):
    environment = os.environ.copy()
    if env:
        environment.update(env)
    result = subprocess.run(["git", "-C", str(repository), *args], capture_output=True,
                            text=True, env=environment)
    if result.returncode:
        raise AssertionError(result.stderr)
    return result.stdout.strip()


class WorkspaceTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.repository = self.root / "source"
        git(self.root, "init", "source")
        git(self.repository, "config", "user.name", "CPU Test")
        git(self.repository, "config", "user.email", "cpu@example.test")
        (self.repository / "README.md").write_text("base\n", encoding="utf-8")
        git(self.repository, "add", "README.md")
        git(self.repository, "commit", "-m", "base")
        self.base = git(self.repository, "rev-parse", "HEAD")

    def make_step(self, name="step-one", path="src/one.txt", contents="one\n"):
        target = self.root / name
        prepared = workspace.prepare_worktree(self.repository, target, self.base, name)
        changed = target / path
        changed.parent.mkdir(parents=True, exist_ok=True)
        changed.write_text(contents, encoding="utf-8")
        git(target, "add", path)
        git(target, "commit", "-m", name)
        return target, git(target, "rev-parse", "HEAD"), prepared

    def test_prepares_only_the_exact_parent_and_reconciles_identical_replay(self):
        target, commit, prepared = self.make_step()
        self.assertFalse(prepared["replayed"])
        self.assertEqual(git(target, "rev-parse", "HEAD^"), self.base)
        # Reconciliation is deliberately strict: only the untouched prepared
        # worktree can replay, not one that has already advanced.
        with self.assertRaises(workspace.WorkspaceError):
            workspace.prepare_worktree(self.repository, target, self.base, "step-one")

        untouched = self.root / "untouched"
        workspace.prepare_worktree(self.repository, untouched, self.base, "untouched")
        replay = workspace.prepare_worktree(self.repository, untouched, self.base, "untouched")
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["baseCommit"], self.base)
        self.assertNotEqual(commit, self.base)

    def test_exports_and_imports_one_bounded_scoped_commit(self):
        target, commit, _ = self.make_step()
        artifact = self.root / "artifacts" / "one.bundle"
        receipt = workspace.export_commit(target, artifact, self.base, commit, ["src"], max_bytes=1024 * 1024)
        self.assertEqual(receipt["changedPaths"], ["src/one.txt"])
        self.assertEqual(receipt["size"], artifact.stat().st_size)
        self.assertEqual(artifact.stat().st_mode & 0o777, 0o600)

        destination = self.root / "destination"
        git(self.root, "clone", "--no-local", str(self.repository), str(destination))
        imported = workspace.import_bundle(
            destination, artifact, expected_sha256=receipt["sha256"],
            expected_size=receipt["size"], expected_parent=self.base, commit=commit,
            allowed_paths=["src"])
        self.assertEqual(imported["commit"], commit)
        self.assertEqual(git(destination, "cat-file", "-t", commit), "commit")
        # Import adds an object, never runner state or a checkout mutation.
        self.assertEqual(git(destination, "rev-parse", "HEAD"), self.base)
        self.assertEqual(git(destination, "status", "--porcelain"), "")
        with self.assertRaisesRegex(workspace.ArtifactError, "outside its scope"):
            workspace.import_bundle(
                destination, artifact, expected_sha256=receipt["sha256"],
                expected_size=receipt["size"], expected_parent=self.base, commit=commit,
                allowed_paths=["docs"])

    def test_rejects_tampering_extra_commits_and_out_of_scope_changes(self):
        target, first, _ = self.make_step()
        artifact = self.root / "one.bundle"
        receipt = workspace.export_commit(target, artifact, self.base, first, ["src"])
        payload = bytearray(artifact.read_bytes())
        payload[-1] ^= 1
        artifact.write_bytes(payload)
        with self.assertRaisesRegex(workspace.ArtifactError, "digest"):
            workspace.import_bundle(
                self.repository, artifact, expected_sha256=receipt["sha256"],
                expected_size=receipt["size"], expected_parent=self.base, commit=first,
                allowed_paths=["src"])

        (target / "src/two.txt").write_text("two\n", encoding="utf-8")
        git(target, "add", "src/two.txt")
        git(target, "commit", "-m", "second")
        second = git(target, "rev-parse", "HEAD")
        with self.assertRaisesRegex(workspace.ArtifactError, "one non-merge commit"):
            workspace.export_commit(target, self.root / "two.bundle", self.base, second, ["src"])
        with self.assertRaisesRegex(workspace.ArtifactError, "outside its scope"):
            workspace.export_commit(target, self.root / "wrong.bundle", first, second, ["docs"])
        with self.assertRaisesRegex(workspace.ArtifactError, "exceeds"):
            workspace.export_commit(target, self.root / "too-large.bundle", first, second,
                                    ["src"], max_bytes=16)
        self.assertFalse((self.root / "too-large.bundle").exists())


if __name__ == "__main__":
    unittest.main()
