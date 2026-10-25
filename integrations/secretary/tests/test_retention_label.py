from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from evidence_store import load, save
from gmail_provider import GmailProviderError, label_gmail
import retention_label as rl

IDS = ["a1b2c3d4e5f60001", "a1b2c3d4e5f60002", "a1b2c3d4e5f60003", "a1b2c3d4e5f60004", "a1b2c3d4e5f60005"]


class FakeGmail:
    def __init__(self):
        self.labels = {"INBOX": "INBOX", "CATEGORY_UPDATES": "CATEGORY_UPDATES"}
        self.messages = {IDS[0]: ["INBOX"], IDS[1]: ["CATEGORY_UPDATES"], IDS[2]: ["TRASH"], IDS[3]: ["DRAFT"]}
        self.writes, self.fail_modify = [], False

    def read(self, command):
        if command[:3] == ["gmail", "labels", "list"]:
            return [{"id": i, "name": n} for n, i in self.labels.items()]
        mid = command[2]
        if mid not in self.messages:
            raise GmailProviderError("gmail.get", 1, "not_found")
        return {"message": {"id": mid, "threadId": "t-" + mid, "labelIds": list(self.messages[mid])}}

    def write(self, command, label):
        self.writes.append(command)
        if command[:3] == ["gmail", "labels", "create"]:
            self.labels[label] = "Label_99"
            return {}
        if self.fail_modify:
            raise GmailProviderError("gmail.batch.modify", 1, "transient")
        lid = self.labels[label]
        for mid in [part for part in command[3:] if not part.startswith("--")]:
            if command[-1].startswith("--add="):
                self.messages[mid] = sorted(set(self.messages[mid]) | {lid})
            else:
                self.messages[mid] = [x for x in self.messages[mid] if x != lid]
        return {}


class RetentionLabelTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.dir = Path(self.temp.name)
        self.manifest = self.dir / "manifest.json"
        save(self.manifest, {"planSha256": "p" * 64, "batches": [{"batch": "2024-1", "messages": [
            {"messageId": mid, "threadId": "t-" + mid, "sourceSha256": str(n) * 64} for n, mid in enumerate(IDS)]}]})
        self.gmail = FakeGmail()
        self.out = self.dir / "batch-2024-1"

    def prepared(self):
        return rl.prepare(self.manifest, "2024-1", self.out, read=self.gmail.read)

    def apply(self, intent, **options):
        return rl.apply(self.out, intent["batchSha256"], "Owner in chat, synthetic", read=self.gmail.read,
                        write=self.gmail.write, clock=datetime.now(timezone.utc), **options)

    def test_prepare_holds_trash_drafts_and_gone_messages_and_changes_nothing(self):
        intent = self.prepared()
        self.assertEqual([i["messageId"] for i in intent["ready"]], IDS[:2])
        self.assertEqual(intent["held"], {IDS[2]: "already_in_trash", IDS[3]: "draft", IDS[4]: "gone_at_gmail"})
        self.assertEqual(self.gmail.writes, [])

    def test_apply_needs_the_approved_fingerprint_and_a_fresh_check(self):
        intent = self.prepared()
        with self.assertRaises(SystemExit):
            rl.apply(self.out, "0" * 64, "Owner", read=self.gmail.read, write=self.gmail.write)
        stale = datetime.now(timezone.utc) + timedelta(hours=2)
        with self.assertRaises(SystemExit):
            rl.apply(self.out, intent["batchSha256"], "Owner", read=self.gmail.read, write=self.gmail.write, clock=stale)
        with self.assertRaises(SystemExit):
            self.apply(intent)  # the label does not exist yet and was not allowed to be created
        self.assertEqual(self.gmail.writes, [])

    def test_apply_adds_only_the_label_to_ready_messages_and_checks_each_one(self):
        intent = self.prepared()
        effect = self.apply(intent, create_label=True)
        self.assertEqual(effect["confirmed"], 2)
        self.assertEqual(effect["otherLabelsChanged"], [])
        self.assertEqual((effect["trashed"], effect["deleted"]), (0, 0))
        self.assertEqual(self.gmail.messages[IDS[2]], ["TRASH"])
        self.assertIn("Label_99", self.gmail.messages[IDS[0]])
        self.assertEqual(self.gmail.writes[-1][-1], "--add=" + rl.LABEL)

    def test_a_second_dispatch_is_refused_and_remove_undoes_the_label(self):
        intent = self.prepared()
        self.apply(intent, create_label=True)
        with self.assertRaises(SystemExit):
            self.apply(intent)
        undo = self.apply(intent, remove=True)
        self.assertEqual(undo["confirmed"], 2)
        self.assertNotIn("Label_99", self.gmail.messages[IDS[0]])

    def test_an_uncertain_modify_is_recorded_and_read_back_never_retried(self):
        intent = self.prepared()
        self.gmail.fail_modify = True
        effect = self.apply(intent, create_label=True)
        self.assertIn("transient", effect["error"])
        self.assertEqual(effect["confirmed"], 0)
        self.assertEqual(sum(1 for w in self.gmail.writes if w[:3] == ["gmail", "batch", "modify"]), 1)
        self.assertTrue((self.out / "dispatch-add.json").exists())

    def test_the_transport_allows_only_one_named_label_on_exact_ids(self):
        for command in (["gmail", "trash", IDS[0]], ["gmail", "batch", "modify", IDS[0], "--add=TRASH"],
                        ["gmail", "batch", "modify", "not-an-id", "--add=" + rl.LABEL],
                        ["gmail", "batch", "modify", IDS[0], "--add=" + rl.LABEL, "--remove=INBOX"],
                        ["gmail", "batch", "modify", "--add=" + rl.LABEL]):
            with self.assertRaises(ValueError):
                label_gmail(command, rl.LABEL)


if __name__ == "__main__":
    unittest.main()
