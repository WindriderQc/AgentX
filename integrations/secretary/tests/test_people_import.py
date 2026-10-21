import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from evidence_store import load, save
import people_import
from secretary_evidence import Archive
from value_lanes import LANES_NAME

OWNER = "Owner Example <owner@example.test>"
VCARD = b"BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Synthetic Cousin\r\nEMAIL:cousin@example.test\r\nEMAIL:cousin.work@example.test\r\nTEL:+1 514 555 0101\r\nORG:Synthetic Org;\r\nEND:VCARD\r\n"


class Response:
    def __init__(self, body):
        self.body = body
    def __enter__(self):
        return self
    def __exit__(self, *_):
        return False
    def read(self):
        return json.dumps(self.body).encode()


class PeopleImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        plan = [  # thread, message, labels, lane, headers
            ("t1", "m1", ["SENT"], "person", {"from": OWNER, "to": "Friend <friend@example.test>", "cc": "Other <other@example.test>, owner@example.test"}),
            ("t2", "m2", ["INBOX"], "person", {"from": "Friend <friend@example.test>", "to": OWNER}),
            ("t3", "m3", ["INBOX"], "important", {"from": "Service <no-reply@service.example>", "to": OWNER}),
            ("t4", "m4", ["INBOX"], "bulk", {"from": "Store <deals@store.example>", "to": OWNER}),
            ("t5", "m5", ["INBOX"], "person", {"from": "Broken <broken@nowhere>", "to": OWNER}),
        ]
        lanes = {}
        for tid, mid, labels, lane, headers in plan:
            message = {"id": mid, "internalDate": "1546344000000", "headers": headers, "attachments": []}
            if mid == "m2":
                card = self.root / "files" / "cousin.vcf"
                card.parent.mkdir(exist_ok=True)
                card.write_bytes(VCARD)
                message["attachments"] = [{"filename": "cousin.vcf", "mimeType": "text/vcard", "path": "files/cousin.vcf",
                                           "sha256": hashlib.sha256(VCARD).hexdigest(), "bytes": len(VCARD)}]
            save(self.root / "threads" / tid / "manifest.json", {"threadId": tid, "evidenceHash": "a" * 64, "messages": [message]})
            save(self.root / "threads" / tid / "original.json", {"thread": {"messages": [{"id": mid, "labelIds": labels}]}})
            raw = self.root / "raw" / f"{mid}.eml"
            raw.parent.mkdir(exist_ok=True)
            raw.write_bytes(b"Synthetic source")
            save(self.root / "raw-receipts" / f"{mid}.json", {"sha256": mid[-1] * 64, "bytes": 16, "path": f"raw/{mid}.eml"})
            lanes[mid] = {"threadId": tid, "lane": lane, "reason": "synthetic"}
        save(self.root / LANES_NAME, {"messages": lanes})
        self.archive = Archive(self.root, run=lambda _: (_ for _ in ()).throw(RuntimeError("off")))

    def test_mail_headers_keep_people_and_leave_out_the_owner_bulk_and_robots(self):
        manifest = people_import.prepare(self.archive)
        mail = [o for o in manifest["observations"] if o["source"] == "gmail-header"]
        self.assertEqual(sorted((o["role"], o["email"]) for o in mail),
                         [("cc", "other@example.test"), ("from", "friend@example.test"), ("to", "friend@example.test")])
        sent = next(o for o in mail if o["role"] == "to")
        self.assertEqual((sent["direction"], sent["occurredAt"], sent["ref"]["sourceSha256"]), ("sent", "2019-01-01T12:00:00Z", "1" * 64))
        self.assertEqual(manifest["counts"]["messagesNotPersonOrImportant"], 1)
        self.assertEqual(manifest["counts"]["ownerAutomatedOrInvalidAddresses"], 3)  # owner cc, no-reply, no domain

    def test_a_contact_card_becomes_one_observation_per_address_with_its_phone(self):
        cards = [o for o in people_import.prepare(self.archive)["observations"] if o["role"] == "vcard"]
        self.assertEqual([o["email"] for o in cards], ["cousin@example.test", "cousin.work@example.test"])
        self.assertTrue(all(o["source"] == "gmail-vcf" and o["name"] == "Synthetic Cousin" and o["phones"] == ["+1 514 555 0101"]
                            and o["organization"] == "Synthetic Org" and len(o["ref"]["assertionId"]) == 64 for o in cards))

    def test_delivery_sends_each_batch_once_and_keeps_an_uncertain_answer_replayable(self):
        manifest = people_import.prepare(self.archive)
        state = self.root.parent / (self.root.name + "-delivery.json")
        self.addCleanup(lambda: state.unlink(missing_ok=True))
        sent = []

        def lost(request, timeout):
            raise TimeoutError("lost")
        with self.assertRaises(RuntimeError):
            people_import.deliver(manifest, "http://core.test", state, opener=lost)
        self.assertEqual(load(state)["phase"], "unconfirmed")

        def ok(request, timeout):
            batch = json.loads(request.data)["observations"]
            sent.append(len(batch))
            return Response({"status": "success", "data": {"created": len(batch), "replayed": 0, "people": 3, "proposals": 1}})
        result = people_import.deliver(manifest, "http://core.test", state, opener=ok)
        self.assertEqual((result["phase"], result["created"], sent), ("delivered", 5, [5]))
        people_import.deliver(manifest, "http://core.test", state, opener=ok)
        self.assertEqual(sent, [5])


if __name__ == "__main__":
    unittest.main()
