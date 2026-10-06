from pathlib import Path
import subprocess
import tempfile
import unittest

from integrations.coding import coding_task_worktrees as worktrees
from integrations.coding.coding_dispatch_evidence import PipelineApiError


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


def local_ssh(_host, command, **options):
    return subprocess.run(["bash", "-c", command], **options)


class TaskWorktreeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name) / ".openclaw/workspace-coder/repo"
        self.base.mkdir(parents=True)
        git(self.base, "init", "--quiet")
        git(self.base, "config", "user.email", "synthetic@example.invalid")
        git(self.base, "config", "user.name", "Synthetic fixture")
        (self.base / "file.txt").write_text("source\n")
        (self.base / ".gitignore").write_text("core/node_modules/\n")
        (self.base / "core/node_modules").mkdir(parents=True)
        (self.base / "core/package-lock.json").write_text('{"lockfileVersion":3}\n')
        git(self.base, "add", ".")
        git(self.base, "commit", "--quiet", "-m", "Synthetic base")
        self.revision = git(self.base, "rev-parse", "HEAD")

    def prepare(self, task_id="0377", revision=None):
        return Path(worktrees.prepare_remote_worktree(local_ssh, "synthetic", str(self.base),
            task_id, revision or self.revision, "coder"))

    def test_task_isolation_and_retry_preserve_the_original_patch(self):
        first = self.prepare()
        (first / "file.txt").write_text("task one patch\n")
        second = self.prepare("0378")
        self.assertEqual((second / "file.txt").read_text(), "source\n")
        self.assertEqual((self.base / "file.txt").read_text(), "source\n")
        self.assertEqual(git(self.base, "status", "--porcelain"), "")
        self.assertEqual(self.prepare(), first)
        self.assertEqual((first / "file.txt").read_text(), "task one patch\n")
        self.assertEqual(git(first, "rev-parse", "HEAD"), self.revision)

    def test_a_changed_base_refuses_instead_of_resetting_an_existing_task(self):
        first = self.prepare()
        (first / "file.txt").write_text("preserved patch\n")
        (self.base / "file.txt").write_text("new main\n")
        git(self.base, "add", ".")
        git(self.base, "commit", "--quiet", "-m", "Next synthetic base")
        with self.assertRaises(PipelineApiError):
            self.prepare(revision=git(self.base, "rev-parse", "HEAD"))
        self.assertEqual((first / "file.txt").read_text(), "preserved patch\n")

    def test_foreign_repository_or_symlink_is_not_adopted(self):
        target = Path(worktrees.task_worktree_path(str(self.base), "0377"))
        target.mkdir(parents=True)
        git(target, "init", "--quiet")
        with self.assertRaises(PipelineApiError):
            self.prepare()
        self.assertTrue((target / ".git").is_dir())
        second = Path(worktrees.task_worktree_path(str(self.base), "0378"))
        second.symlink_to(self.base, target_is_directory=True)
        with self.assertRaises(PipelineApiError):
            self.prepare("0378")

    def test_dependency_mount_checks_the_operator_lock_and_is_read_only(self):
        target = self.prepare()
        prefix, mount = worktrees.node_dependency_mount(str(target))
        self.assertEqual(mount, ["--ro-bind", str(self.base / "core/node_modules"), "/workspace/core/node_modules"])
        self.assertEqual(subprocess.run(["bash", "-c", prefix + "true"]).returncode, 0)
        (self.base / "core/package-lock.json").write_text("different\n")
        git(self.base, "add", ".")
        git(self.base, "commit", "--quiet", "-m", "Different dependencies")
        self.assertNotEqual(subprocess.run(["bash", "-c", prefix + "true"]).returncode, 0)

    def test_profile_and_task_path_reject_scope_escape_and_ambiguous_configuration(self):
        for value in ["../377", "0377/other", "", "x"]:
            with self.assertRaises(PipelineApiError):
                worktrees.task_worktree_path(str(self.base), value)
        with self.assertRaises(PipelineApiError):
            worktrees.reviewed_profile({"remoteRepo": str(self.base), "agent": "other"})
        with self.assertRaises(PipelineApiError):
            worktrees.reviewed_profile({"remoteRepo": str(self.base), "agent": "coder", "taskWorktree": "true"})
