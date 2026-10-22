import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


CODING = Path(__file__).resolve().parents[1]
WORKSPACE_SPEC = importlib.util.spec_from_file_location("coding_step_workspace", CODING / "coding_step_workspace.py")
workspace = importlib.util.module_from_spec(WORKSPACE_SPEC)
WORKSPACE_SPEC.loader.exec_module(workspace)
sys.modules["coding_step_workspace"] = workspace
ASSEMBLY_SPEC = importlib.util.spec_from_file_location("coding_step_assembly", CODING / "coding_step_assembly.py")
assembly = importlib.util.module_from_spec(ASSEMBLY_SPEC)
ASSEMBLY_SPEC.loader.exec_module(assembly)


def git(repository, *args, env=None):
    environment = os.environ.copy()
    if env:
        environment.update(env)
    result = subprocess.run(["git", "-C", str(repository), *args], capture_output=True,
                            text=True, env=environment)
    if result.returncode:
        raise AssertionError(result.stderr)
    return result.stdout.strip()


class AssemblyTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "source"
        git(self.root, "init", "source")
        git(self.source, "config", "user.name", "CPU Test")
        git(self.source, "config", "user.email", "cpu@example.test")
        (self.source / "common.txt").write_text("base\n", encoding="utf-8")
        git(self.source, "add", "common.txt")
        git(self.source, "commit", "-m", "base")
        self.base = git(self.source, "rev-parse", "HEAD")
        # Clone before step refs exist, so adoption really imports each object.
        self.destination = self.root / "assembly"
        git(self.root, "clone", "--no-local", str(self.source), str(self.destination))
        git(self.destination, "config", "user.name", "Assembly Test")
        git(self.destination, "config", "user.email", "assembly@example.test")
        self.journal = self.root / "journal"

    def step(self, step_id, request_id, relative, contents, *, depends=None):
        worktree = self.root / f"work-{step_id}"
        workspace.prepare_worktree(self.source, worktree, self.base, f"branch-{step_id}")
        changed = worktree / relative
        changed.parent.mkdir(parents=True, exist_ok=True)
        changed.write_text(contents, encoding="utf-8")
        git(worktree, "add", relative)
        git(worktree, "commit", "-m", step_id)
        commit = git(worktree, "rev-parse", "HEAD")
        artifact = self.root / "artifacts" / f"{step_id}.bundle"
        receipt = workspace.export_commit(worktree, artifact, self.base, commit, [relative])
        return {"id": step_id, "requestId": request_id, "dependsOn": list(depends or []),
                "commit": commit, "parent": self.base, "artifactPath": str(artifact),
                "artifactSha256": receipt["sha256"], "artifactSize": receipt["size"],
                "allowedPaths": [relative]}

    def test_adopts_ready_steps_in_stable_dag_order(self):
        later = self.step("b-step", "request-b", "src/b.txt", "b\n")
        first = self.step("a-step", "request-a", "src/a.txt", "a\n")
        dependent = self.step("c-step", "request-c", "src/c.txt", "c\n", depends=["b-step"])
        receipts = assembly.Assembly(self.destination, self.journal).adopt([dependent, later, first])
        # a and b are initially ready, so lexical id is the deterministic tie-break.
        self.assertEqual([row["stepId"] for row in receipts], ["a-step", "b-step", "c-step"])
        self.assertTrue(all(row["status"] == "adopted" for row in receipts))
        self.assertEqual((self.destination / "src/a.txt").read_text(), "a\n")
        self.assertEqual((self.destination / "src/b.txt").read_text(), "b\n")
        self.assertEqual((self.destination / "src/c.txt").read_text(), "c\n")
        self.assertEqual(git(self.destination, "rev-list", "--count", f"{self.base}..HEAD"), "3")

    def test_reconciles_commit_after_lost_adoption_ack_without_duplicate(self):
        entry = self.step("lost-step", "request-lost", "lost.txt", "present\n")

        def lose_reply(_receipt):
            raise TimeoutError("simulated lost acknowledgement")

        with self.assertRaises(TimeoutError):
            assembly.Assembly(self.destination, self.journal, after_commit=lose_reply).adopt_one(entry)
        committed = git(self.destination, "rev-parse", "HEAD")
        self.assertEqual(git(self.destination, "rev-list", "--count", f"{self.base}..HEAD"), "1")

        receipt = assembly.Assembly(self.destination, self.journal).adopt_one(entry)
        self.assertTrue(receipt["reconciled"])
        self.assertEqual(receipt["resultCommit"], committed)
        self.assertEqual(git(self.destination, "rev-list", "--count", f"{self.base}..HEAD"), "1")
        self.assertEqual(assembly.Assembly(self.destination, self.journal).adopt_one(entry), receipt)

    def test_conflict_receipt_is_deterministic_and_replayed_cleanly(self):
        first = self.step("a-change", "request-first", "common.txt", "first\n")
        second = self.step("b-change", "request-second", "common.txt", "second\n")
        runner = assembly.Assembly(self.destination, self.journal)
        receipts = runner.adopt([second, first])
        self.assertEqual([row["status"] for row in receipts], ["adopted", "conflict"])
        conflict = receipts[-1]
        self.assertEqual(conflict["conflictPaths"], ["common.txt"])
        self.assertRegex(conflict["conflictFingerprint"], r"^[0-9a-f]{64}$")
        head = git(self.destination, "rev-parse", "HEAD")
        self.assertEqual(git(self.destination, "status", "--porcelain"), "")
        self.assertEqual(runner.adopt_one(second), conflict)
        self.assertEqual(git(self.destination, "rev-parse", "HEAD"), head)
        with self.assertRaises(assembly.AdoptionConflict) as raised:
            runner.adopt_one(second, raise_conflict=True)
        self.assertEqual(raised.exception.receipt, conflict)

    def test_rejects_cycles_and_unknown_dependencies_before_mutation(self):
        with self.assertRaisesRegex(assembly.AssemblyError, "unknown dependencies"):
            assembly.ordered_steps([{"id": "a", "dependsOn": ["missing"]}])
        with self.assertRaisesRegex(assembly.AssemblyError, "cycle"):
            assembly.ordered_steps([
                {"id": "a", "dependsOn": ["b"]},
                {"id": "b", "dependsOn": ["a"]},
            ])


if __name__ == "__main__":
    unittest.main()
