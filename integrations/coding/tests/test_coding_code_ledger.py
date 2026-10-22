import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest


HERE = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ledger_module = load("coding_code_ledger")
steps_module = load("coding_code_steps")


def plan():
    value = {
        "schema": steps_module.PLAN_SCHEMA,
        "summary": "Implement parser and route.",
        "steps": [
            {"id": "step-01", "title": "Parser", "objective": "Implement the parser.",
             "paths": ["core/src/parser.js"], "testTargets": ["core/tests/parser.test.js"], "dependsOn": []},
            {"id": "step-02", "title": "Route", "objective": "Connect the route.",
             "paths": ["core/routes/example.js"], "testTargets": ["core/tests/example.test.js"],
             "dependsOn": ["step-01"]},
        ],
    }
    return steps_module.validate_plan(value, ["core/src/parser.js", "core/routes/example.js"])


def passed(target="core/tests/parser.test.js", duration=17):
    return [{"profile": "agentx-core-runner-tests/v1", "targets": [target],
             "outcome": "passed", "exitCode": 0, "durationMs": duration}]


class LedgerStateTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "private" / "steps.json"
        self.store = ledger_module.CodeStepLedger(self.path)
        self.ledger = self.store.create("0836", "a" * 40, plan(), created_at="2026-10-22T00:00:00Z")

    def test_create_is_private_atomic_and_resumable(self):
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.path.parent.stat().st_mode & 0o777, 0o700)
        self.assertFalse(list(self.path.parent.glob("*.tmp")))
        self.assertEqual(self.store.load(), self.ledger)
        with self.assertRaisesRegex(ledger_module.CodeLedgerError, "already exists"):
            self.store.create("0836", "a" * 40, plan())

    def test_runs_in_dependency_order_and_records_one_tested_commit(self):
        self.assertEqual(ledger_module.next_step(self.ledger)["id"], "step-01")
        running = self.store.start("step-01", 0)
        self.assertEqual((running["steps"][0]["state"], running["steps"][0]["attempts"]), ("running", 1))
        verified = self.store.record_verified("step-01", "b" * 40, ["core/src/parser.js"], passed(), 1)
        self.assertEqual(verified["steps"][0]["state"], "verified")
        self.assertEqual(ledger_module.next_step(verified)["id"], "step-02")
        self.assertEqual(ledger_module.summary(verified)[0]["commit"], "b" * 40)

    def test_refuses_stale_writers_and_a_step_before_dependencies(self):
        with self.assertRaisesRegex(ledger_module.CodeLedgerError, "next dependency-ready"):
            self.store.start("step-02", 0)
        self.store.start("step-01", 0)
        with self.assertRaises(ledger_module.LedgerConflict):
            self.store.record_failure("step-01", "stale", 0)

    def test_invalid_commit_scope_or_test_receipt_leaves_ledger_unchanged(self):
        running = self.store.start("step-01", 0)
        cases = [
            ("short", ["core/src/parser.js"], passed()),
            ("b" * 40, ["core/routes/example.js"], passed()),
            ("b" * 40, ["core/src/parser.js"], passed("core/tests/example.test.js")),
            ("b" * 40, ["core/src/parser.js"], [{**passed()[0], "outcome": "failed"}]),
        ]
        for commit, paths, receipts in cases:
            with self.subTest(commit=commit, paths=paths, receipts=receipts), self.assertRaises(ledger_module.CodeLedgerError):
                self.store.record_verified("step-01", commit, paths, receipts, 1)
            self.assertEqual(self.store.load(), running)

    def test_failure_retries_then_blocks_at_the_bound(self):
        revision = 0
        for attempt in range(1, 4):
            current = self.store.start("step-01", revision)
            revision = current["revision"]
            current = self.store.record_failure("step-01", f"failure {attempt}", revision)
            revision = current["revision"]
            expected = "blocked" if attempt == 3 else "failed"
            self.assertEqual(current["steps"][0]["state"], expected)
        self.assertIsNone(ledger_module.next_step(current))

    def test_failed_test_is_retained_but_cannot_verify_the_step(self):
        self.store.start("step-01", 0)
        failed = [{"profile": "agentx-core-runner-tests/v1", "targets": ["core/tests/parser.test.js"],
                   "outcome": "failed", "exitCode": 1, "durationMs": 30}]
        value = self.store.record_failure("step-01", "focused test failed", 1, verification=failed)
        self.assertEqual(value["steps"][0]["verification"], failed)
        self.assertIsNone(value["steps"][0]["commit"])

    def test_progress_projection_matches_the_bounded_core_contract(self):
        self.store.start("step-01", 0)
        value = self.store.record_verified("step-01", "b" * 40, ["core/src/parser.js"], passed(), 1)
        projected = ledger_module.progress_projection(value, 32768, "speed_knee")
        self.assertEqual(set(projected), {"schema", "planFingerprint", "stepContext", "budgetSource",
                                          "currentStep", "counts", "steps"})
        self.assertEqual(projected["schema"], "agentx.code-step-summary/v1")
        self.assertEqual(projected["counts"], {"pending": 1, "running": 0, "passed": 1, "failed": 0})
        self.assertEqual(projected["steps"][0], {"id": "step-01", "title": "Parser", "state": "passed",
            "commit": "b" * 40, "tests": [{"profile": "agentx-core-runner-tests/v1", "outcome": "passed", "durationMs": 17}]})
        self.assertNotIn("paths", json.dumps(projected))

    def test_load_refuses_a_world_readable_or_tampered_ledger(self):
        os.chmod(self.path, 0o644)
        with self.assertRaisesRegex(ledger_module.CodeLedgerError, "private regular file"):
            self.store.load()
        os.chmod(self.path, 0o600)
        value = json.loads(self.path.read_text())
        value["steps"][0]["objective"] = "tampered"
        self.path.write_text(json.dumps(value))
        os.chmod(self.path, 0o600)
        with self.assertRaisesRegex(ledger_module.CodeLedgerError, "fingerprint"):
            self.store.load()


class LedgerValidationTest(unittest.TestCase):
    def test_rejects_invalid_source_commits_and_plan_shape(self):
        with self.assertRaisesRegex(ledger_module.CodeLedgerError, "source commit"):
            ledger_module.new_ledger("0836", "main", plan())
        value = plan()
        value["steps"][1]["dependsOn"] = ["step-02"]
        with self.assertRaisesRegex(ledger_module.CodeLedgerError, "dependencies"):
            ledger_module.new_ledger("0836", "a" * 40, value)


if __name__ == "__main__":
    unittest.main()
