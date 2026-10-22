import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from evidence_store import load, save
import recall_index
from secretary_evidence import Archive
from value_lanes import LANES_NAME

OWNER = "Owner Example <owner@example.test>"


class Response:
    def __init__(self, body):
        self.body = body
    def __enter__(self):
        return self
    def __exit__(self, *_):
        return False
    def read(self):
        return json.dumps(self.body).encode()


class Core:
    """Fake Core: records each request; busy reasons are consumed first."""

    def __init__(self, busy=(), lose=False):
        self.requests, self.busy_reasons, self.lose = [], list(busy), lose

    def busy(self):
        return self.busy_reasons.pop(0) if self.busy_reasons else None

    def opener(self, request, timeout):
        body = json.loads(request.data)
        self.requests.append((request.full_url.rsplit("/api", 1)[1], body))
        if self.lose and request.full_url.endswith("/documents"):
            raise TimeoutError("lost")
        if request.full_url.endswith("/documents"):
            return Response({"status": "success", "data": {"indexed": len(body["documents"])}})
        return Response({"status": "success", "data": {"indexed": 2, "removed": 0, "remaining": 0}})


class RecallIndexTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "archive"
        plan = [("t1", "m1", ["SENT"], "person", {"from": OWNER, "to": "Friend <friend@example.test>", "subject": "Synthetic canoe"}, "Synthetic plan for the lake"),
                ("t2", "m2", ["INBOX"], "important", {"from": "School <office@school.example>", "to": OWNER, "subject": "Synthetic report"}, "Synthetic report card attached"),
                ("t3", "m3", ["INBOX"], "bulk", {"from": "Store <deals@store.example>", "to": OWNER, "subject": "Sale"}, "Synthetic sale")]
        lanes = {}
        for tid, mid, labels, lane, headers, body in plan:
            message = {"id": mid, "internalDate": "1469016000000", "headers": headers, "attachments": []}
            if mid == "m2":
                text = self.root / "files" / "report.txt"
                text.parent.mkdir(parents=True, exist_ok=True)
                text.write_text("Synthetic grades:\x00 excellent in mathematics", encoding="utf-8")
                message["attachments"] = [{"filename": "report.pdf", "sha256": "c" * 64, "textPath": "files/report.txt"},
                                          {"filename": "photo.jpg", "sha256": "d" * 64}]
            save(self.root / "threads" / tid / "manifest.json", {"threadId": tid, "evidenceHash": "a" * 64, "messages": [message]})
            save(self.root / "threads" / tid / "original.json", {"thread": {"messages": [{"id": mid, "labelIds": labels, "body": body}]}})
            raw = self.root / "raw" / f"{mid}.eml"
            raw.parent.mkdir(exist_ok=True)
            raw.write_bytes(b"Synthetic source")
            save(self.root / "raw-receipts" / f"{mid}.json", {"sha256": mid[-1] * 64, "bytes": 16, "path": f"raw/{mid}.eml"})
            lanes[mid] = {"threadId": tid, "lane": lane, "reason": "synthetic"}
        save(self.root / LANES_NAME, {"messages": lanes})
        self.archive = Archive(self.root, run=lambda _: (_ for _ in ()).throw(RuntimeError("off")))
        self.state = Path(self.temp.name) / "recall-state.json"

    def test_bodies_and_read_attachments_of_kept_mail_with_provenance(self):
        from collections import Counter
        counts = Counter()
        docs = list(recall_index.documents(self.archive, counts))
        self.assertEqual([d["documentId"] for d in docs], ["mail:m1", "mail:m2", f"file:{'c' * 32}_m2"])
        sent = docs[0]
        self.assertEqual((sent["kind"], sent["title"], sent["people"], sent["occurredAt"]),
                         ("mail", "Synthetic canoe", ["Friend"], "2016-07-20T12:00:00Z"))
        self.assertEqual(sent["source"], {"messageId": "m1", "threadId": "t1", "sourceSha256": "1" * 64})
        self.assertEqual(docs[2]["source"]["filename"], "report.pdf")
        self.assertNotIn("\x00", docs[2]["text"])  # Core refuses NUL characters
        self.assertEqual(recall_index.clean("Bravo \U0001F389 et merci"), "Bravo  et merci")
        self.assertEqual((counts["messagesNotPersonOrImportant"], counts["attachmentsWithoutReadText"]), (1, 1))

    def test_run_pauses_for_core_then_indexes_once_and_syncs(self):
        core, slept = Core(busy=["benchmark running"]), []
        state = recall_index.run(self.archive, "http://core.test", self.state, client=core, opener=core.opener, sleep=slept.append)
        self.assertEqual((state["phase"], slept), ("done", [60]))
        paths = [path for path, _ in core.requests]
        self.assertEqual(paths, ["/secretary/recall/documents", "/secretary/recall/sync"])
        self.assertEqual(len(core.requests[0][1]["documents"]), 3)
        again = Core()
        recall_index.run(self.archive, "http://core.test", self.state, client=again, opener=again.opener)
        self.assertEqual([path for path, _ in again.requests], ["/secretary/recall/sync"])

    def test_a_lost_answer_is_reported_and_the_same_documents_replay(self):
        lost = Core(lose=True)
        with self.assertRaises(RuntimeError):
            recall_index.run(self.archive, "http://core.test", self.state, client=lost, opener=lost.opener)
        self.assertEqual(load(self.state)["phase"], "unconfirmed")
        retry = Core()
        recall_index.run(self.archive, "http://core.test", self.state, client=retry, opener=retry.opener)
        self.assertEqual(retry.requests[0][1]["documents"], lost.requests[0][1]["documents"])

    def test_batches_respect_document_and_size_bounds(self):
        docs = [{"text": "x" * 600_000} for _ in range(5)] + [{"text": "y"} for _ in range(30)]
        sizes = [len(b) for b in recall_index.batches(docs)]
        self.assertTrue(all(sum(len(d["text"]) for d in b) <= recall_index.MAX_BATCH_CHARS or len(b) == 1 for b in recall_index.batches(docs)))
        self.assertTrue(max(sizes) <= recall_index.MAX_BATCH_DOCUMENTS)


if __name__ == "__main__":
    unittest.main()
