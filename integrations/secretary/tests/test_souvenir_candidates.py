import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from evidence_store import load, save
from history_import import entry_key
import souvenir_candidates as sc
from value_lanes import LANES_NAME

DAY_MS = 86_400_000
BASE = 1_528_000_000_000  # mid-2018
OWNER = "Propriétaire Fictif <owner@example.test>"


class Lock:
    def touch(self):
        pass


class Client:
    """Fake Core: merges every finding into one candidate per distinct text."""

    def __init__(self, busy=(), fail=False):
        self.calls, self.busy_reasons, self.fail = [], list(busy), fail
        self.base, self.task_type = "http://core.test", "mail_review"

    def busy(self):
        return self.busy_reasons.pop(0) if self.busy_reasons else None

    def extract(self, system, prompt, light=False, request_id=None):
        if self.fail:
            raise TimeoutError("lost answer")
        self.calls.append(prompt)
        shown = json.loads(prompt.split("\n", 1)[1])
        lake = [f["ref"] for f in shown if "lac" in f["text"].lower()]
        rest = [f for f in shown if "lac" not in f["text"].lower()]
        out = [{"text": "Voyage au lac fictif avec une amie fictive.", "eventDate": "2018-07-14",
                "people": ["Amie fictive", "Propriétaire Fictif", "PROPRIETAIRE"], "places": ["Lac fictif"], "category": "travel", "refs": lake + ["f999"]}] if lake else []
        out += [{"text": f["text"], "eventDate": "2018", "people": [], "places": [], "category": "unknown-kind",
                 "refs": [f["ref"]]} for f in rest if "publicité" not in f["text"]]
        return {"candidates": out}


class SouvenirCandidateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.manifests, lanes = [], {}
        plan = [  # thread, message, lane, memory text, written date
            ("t1", "m1", "person", "Une amie fictive propose une fin de semaine au lac fictif.", "14 juillet"),
            ("t2", "m2", "person", "Confirmation du séjour au lac fictif le 14 juillet.", "14 juillet"),
            ("t3", "m3", "important", "L'agence fictive confirme le nouveau numéro de dossier.", ""),
            ("t4", "m4", "important", "L'agence fictive confirme le nouveau numéro de dossier.", ""),  # exact repeat
            ("t5", "m5", "bulk", "Une publicité fictive annonce des soldes.", ""),
            ("t6", "m6", "person", "Une publicité fictive transférée par un ami.", ""),
        ]
        for n, (tid, mid, lane, text, written) in enumerate(plan):
            manifest = {"threadId": tid, "evidenceHash": str(n) * 64, "messages": [
                {"id": mid, "internalDate": str(BASE + n * DAY_MS),
                 "headers": {"from": OWNER if mid == "m2" else f"Correspondant {n} <c{n}@example.test>",
                             "to": "c0@example.test" if mid == "m2" else "owner@example.test"}}]}
            self.manifests.append(manifest)
            original = self.root / "raw" / f"{mid}.eml"
            original.parent.mkdir(exist_ok=True)
            original.write_bytes(b"Synthetic source")
            save(self.root / "raw-receipts" / f"{mid}.json", {"sha256": f"{n + 1:x}" * 64, "bytes": 16,
                                                              "path": f"raw/{mid}.eml"})
            save(self.root / "threads" / tid / "original.json", {"thread": {"messages": [
                {"id": mid, "labelIds": ["SENT"] if mid == "m2" else ["INBOX"]}]}})
            save(self.root / "reviews" / f"{tid}.json", {"evidenceHash": str(n) * 64, "memories": [
                {"messageId": mid, "text": text, "date": written, "status": "historical"}]})
            lanes[mid] = {"threadId": tid, "lane": lane, "reason": "synthetic"}
        save(self.root / LANES_NAME, {"messages": lanes})
        self.archive = SimpleNamespace(root=self.root, manifests=lambda: self.manifests)

    def test_keeps_person_and_important_mail_and_merges_exact_repeats(self):
        rows, counts = sc.findings(self.archive)
        self.assertEqual(counts["bulk"], 1)
        self.assertEqual(counts["exactRepeatsMerged"], 1)
        self.assertEqual(len(rows), 4)
        repeat = next(r for r in rows if "dossier" in r["text"])
        self.assertEqual([s["messageId"] for s in repeat["sources"]], ["m3", "m4"])
        self.assertEqual(len(repeat["ids"]), 2)

    def test_findings_already_in_the_history_review_are_skipped(self):
        rows, _ = sc.findings(self.archive)
        source = {k: v for k, v in rows[0]["sources"][0].items() if k != "sourceDate"}
        rows, counts = sc.findings(self.archive, delivered={entry_key({"kind": "fact", "source": source}): {}})
        self.assertEqual(counts["alreadyInHistoryReview"], 1)
        self.assertEqual(len(rows), 3)

    def test_consolidates_into_dated_candidates_with_every_source(self):
        rows, _ = sc.findings(self.archive)
        owner = sc.owner_names(self.archive)
        self.assertEqual(owner, {"proprietaire fictif"})
        client = Client()
        status = sc.consolidate(self.archive, client, Lock(), rows, sleep=lambda _: None, owner=owner)
        self.assertEqual(status["phase"], "done")
        results = [load(f) for f in (self.root / sc.WORK / "batches").glob("*.json")]
        entries, overflow = sc.entries(rows, results, owner)
        self.assertEqual(overflow, 0)
        lake = next(e for e in entries if "lac" in e["text"])
        self.assertEqual((lake["eventDate"], lake["eventDatePrecision"]), ("2018-07-14", "day"))
        self.assertEqual(lake["people"], ["Amie fictive"])
        self.assertEqual(lake["source"]["messageId"], "m1")  # earliest source first
        self.assertEqual([s["messageId"] for s in lake["relatedSources"]], ["m2"])
        self.assertRegex(lake["source"]["findingId"], r"^[a-f0-9]{64}$")
        self.assertNotIn("sourceDate", lake["source"])
        dossier = next(e for e in entries if "dossier" in e["text"])
        self.assertEqual((dossier["eventDate"], dossier["eventDatePrecision"], dossier["eventDateAsWritten"]),
                         ("", "unknown", "2018"))
        self.assertEqual(dossier["category"], "other")
        self.assertEqual(len(dossier["findingIds"]), 2)
        self.assertFalse(any("publicité" in e["text"] for e in entries))  # left out by the model
        self.assertTrue(all(e["kind"] == "fact" for e in entries))

    def test_the_owner_is_never_one_of_the_people(self):
        owner = {"yanik exemple"}
        self.assertFalse(sc.not_owner("Yanik Exemple", owner))
        self.assertFalse(sc.not_owner("YANIK", owner))
        self.assertFalse(sc.not_owner("  ", owner))
        self.assertTrue(sc.not_owner("Daniel Exemple", owner))  # a relative sharing the surname stays
        self.assertIn("health: care, accidents, medical", sc.INSTRUCTIONS)

    def test_resumes_without_repeating_a_saved_batch(self):
        rows, _ = sc.findings(self.archive)
        first = Client()
        sc.consolidate(self.archive, first, Lock(), rows)
        again = Client()
        sc.consolidate(self.archive, again, Lock(), rows)
        self.assertTrue(first.calls)
        self.assertEqual(again.calls, [])

    def test_pauses_while_core_is_busy_then_continues(self):
        rows, _ = sc.findings(self.archive)
        slept = []
        status = sc.consolidate(self.archive, Client(busy=["benchmark running"]), Lock(), rows, sleep=slept.append)
        self.assertEqual(status["phase"], "done")
        self.assertEqual(slept, [60])
        self.assertNotIn("paused", load(self.root / sc.WORK / "status.json"))

    def test_an_uncertain_answer_is_never_repeated(self):
        rows, _ = sc.findings(self.archive)
        self.assertEqual(sc.consolidate(self.archive, Client(fail=True), Lock(), rows)["phase"], "uncertain")
        retry = Client()
        self.assertEqual(sc.consolidate(self.archive, retry, Lock(), rows)["phase"], "uncertain")
        self.assertEqual(retry.calls, [])

    def test_max_findings_bounds_a_trial(self):
        rows, _ = sc.findings(self.archive)
        client = Client()
        status = sc.consolidate(self.archive, client, Lock(), rows, max_findings=1, batch_size=2)
        self.assertEqual(status["phase"], "partial")
        self.assertEqual(len(client.calls), 1)

    def test_batches_keep_one_source_year_and_skip_covered_findings(self):
        rows, _ = sc.findings(self.archive)
        rows[-1]["sourceDate"] = "2019-01-01T00:00:00+00:00"
        made = list(sc.batches(rows, size=2))
        self.assertTrue(all(len({r["sourceDate"][:4] for r in b["findings"]}) == 1 for b in made))
        covered = set(rows[0]["ids"])
        self.assertFalse(any(rows[0] in b["findings"] for b in sc.batches(rows, covered)))


if __name__ == "__main__":
    unittest.main()
