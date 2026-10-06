import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from integrations.coding.coding_advisory_control import tick


class AdvisoryControlTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.config = {"apiBase": "http://core.test", "advisoryReview": {
            "enabled": True, "coreContainer": "core-test", "model": "pinned-model", "hostUrl": "http://host.test:11434"}}
        self.packet = {"pipelineId": "0700", "attempt": 1, "workerReceiptFingerprint": "a" * 64}
        self.calls = []
        self.receipt_status = "completed"
        self.receipt_changes = {}
        self.missing_receipt = False
        self.lost_ack = False

    def tearDown(self):
        self.temporary.cleanup()

    def fake_command(self, argv):
        self.calls.append(argv)
        if argv[:3] == ["docker", "exec", "--detach"] and self.lost_ack:
            raise subprocess.TimeoutExpired(argv, 15)
        if argv[:2] == ["docker", "cp"] and argv[2].startswith("core-test:"):
            if self.missing_receipt:
                raise subprocess.CalledProcessError(1, argv)
            pending = json.loads((self.root / "control.json").read_text())["pending"]
            receipt = {"schema": "agentx.coding-advisory-review/v1", "status": self.receipt_status,
                "packetFingerprint": pending["fingerprint"], "pipelineId": "0700", "attempt": 1,
                "requestedModel": "pinned-model", "requestedHost": "http://host.test:11434",
                "usage": {"modelCalls": 0 if self.receipt_status == "deferred_before_dispatch" else 1}}
            receipt.update(self.receipt_changes)
            Path(argv[3]).write_text(json.dumps(receipt))

    def invoke(self, now=1000):
        return tick(self.config, self.root, run=self.fake_command, tasks=lambda *_args, **_kw: [{"status": "review"}],
            build=lambda *_args: self.packet, now=lambda: now)

    def launches(self):
        return [call for call in self.calls if call[:3] == ["docker", "exec", "--detach"]]

    def test_restart_collects_exact_receipt_without_replaying_completed_patch(self):
        self.assertEqual(self.invoke()["status"], "submitted")
        state = json.loads((self.root / "control.json").read_text())
        self.assertEqual(state["pending"]["pipelineId"], "0700")
        self.assertEqual(self.invoke()["status"], "completed")
        self.assertEqual(self.invoke()["status"], "no_verified_review_task")
        self.assertEqual(len(self.launches()), 1)
        self.assertEqual((self.root / "control.json").stat().st_mode & 0o777, 0o600)

    def test_lost_launch_acknowledgement_remains_fenced_until_exact_receipt(self):
        self.lost_ack = True
        self.assertEqual(self.invoke()["status"], "unknown")
        self.missing_receipt = True
        self.assertEqual(self.invoke(now=1001)["status"], "running")
        self.assertEqual(self.invoke(now=1400)["status"], "unknown")
        self.assertEqual(len(self.launches()), 1)
        self.missing_receipt = False
        self.assertEqual(self.invoke(now=1401)["status"], "completed")

    def test_stale_running_receipt_does_not_restart_process(self):
        self.invoke()
        self.receipt_status = "running"
        self.assertEqual(self.invoke(now=1400)["status"], "unknown")
        self.assertIn("pending", json.loads((self.root / "control.json").read_text()))
        self.assertEqual(len(self.launches()), 1)

    def test_changed_identity_or_unproven_busy_refusal_keeps_pending_execution(self):
        self.invoke()
        self.receipt_changes = {"packetFingerprint": "b" * 64}
        with self.assertRaisesRegex(ValueError, "identity changed"):
            self.invoke()
        self.receipt_changes = {"usage": {"modelCalls": None}}
        self.receipt_status = "deferred_before_dispatch"
        with self.assertRaisesRegex(ValueError, "proven zero-call"):
            self.invoke()
        self.assertIn("pending", json.loads((self.root / "control.json").read_text()))
        self.assertEqual(len(self.launches()), 1)

    def test_only_proven_before_dispatch_refusal_allows_later_tick(self):
        self.invoke()
        self.receipt_status = "deferred_before_dispatch"
        self.assertEqual(self.invoke()["status"], "deferred_before_dispatch")
        self.assertEqual(self.invoke(now=1001)["status"], "submitted")
        self.assertEqual(len(self.launches()), 2)

    def test_disabled_tick_has_no_process_or_state_effect(self):
        self.config["advisoryReview"]["enabled"] = False
        self.assertEqual(self.invoke(), {"status": "disabled"})
        self.assertEqual(self.calls, [])
        self.assertFalse((self.root / "control.json").exists())


if __name__ == "__main__":
    unittest.main()
