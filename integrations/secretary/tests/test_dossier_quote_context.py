"""Same synthetic quote regressions through the personal-dossier consumer."""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dossier_sources import read_dossier
from secretary_evidence import Archive
from quote_consumer_fixtures import A, B, CAMP, INVOICES, JULY, OCTOBER, GMAIL, cases, quoted
from source_quote_context import DOSSIER_CONTRACT


class DossierQuoteContextTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.messages, self.calls = [], []

        def provider(command):
            self.calls.append(command)
            self.assertEqual(command[:3], ["gmail", "thread", "get"])
            return {"thread": {"messages": self.messages}}

        self.archive = Archive(self.root, run=provider)

    def mail(self, mid, body, *, sender=B, date=OCTOBER, timestamp=1791720000000, draft=False):
        return {"id": mid, "threadId": "bbbbbbbbbbbbbbbb", "body": body,
                "internalDate": str(timestamp), "labelIds": ["DRAFT"] if draft else ["INBOX"],
                "headers": {"from": sender, "to": A if sender == B else B, "date": date}}

    def read(self, **kwargs):
        return read_dossier(self.archive, "bbbbbbbbbbbbbbbb", **kwargs)

    def test_shared_corpus_preserves_claims_spans_raw_source_and_no_automatic_reading(self):
        for name, body, text, claimed, relation in cases():
            with self.subTest(name=name):
                self.messages = [self.mail("aaaaaaaaaaaaaaa1", body)]
                before = len(self.calls)
                read = self.read()
                self.assertEqual(len(self.calls), before + 1)
                self.assertEqual(read["schema"], DOSSIER_CONTRACT)
                source = next(s for s in read["sources"] if text in s["text"])
                self.assertEqual(source["readerContract"], DOSSIER_CONTRACT)
                self.assertEqual(source["sourceContext"]["schema"], "secretary.source-context/v2")
                span = source["sourceContext"]["segments"][0]
                self.assertEqual((span["relation"], span.get("claimedAuthor")), (relation, claimed))
                self.assertIsNone(source["date"])
                self.assertIsNone(source["from"])
                self.assertIsNone(span["author"])
                self.assertIsNone(span["date"])
                start, end = source["span"]["start"], source["span"]["end"]
                self.assertEqual(body[start:end], source["text"])
                self.assertEqual("".join(s["text"] for s in read["sources"]), body)
                self.assertTrue(source["attribution"]["requiresReconciliation"])
                # No page review or model-attempt storage is created by a dossier.
                self.assertFalse((self.root / "page-reviews").exists())
                self.assertFalse((self.root / "review-attempts").exists())
                self.assertEqual(read["sourceHash"], source["sourceHash"])

    def test_originals_later_answers_and_repeated_quotes_do_not_invert_actors_or_resolve_requests(self):
        for request in (CAMP, INVOICES):
            with self.subTest(request=request):
                self.messages = [
                    self.mail("aaaaaaaaaaaaaaa1", request, sender=A, date=JULY, timestamp=1784232000000),
                    self.mail("aaaaaaaaaaaaaaa2", GMAIL + quoted(request)),
                    self.mail("aaaaaaaaaaaaaaa3", "Later answer without repeating the old request.", timestamp=1791806400000),
                    self.mail("aaaaaaaaaaaaaaa4", GMAIL + quoted(request), timestamp=1791892800000)]
                read = self.read()
                original = next(s for s in read["sources"] if s["messageId"] == self.messages[0]["id"])
                repeated = [s for s in read["sources"] if s["relation"] == "quoted"]
                self.assertEqual(len(repeated), 2)
                for source in repeated:
                    found = source["attribution"]
                    self.assertEqual((found["state"], found["author"], found["date"]), ("matched-original", A, JULY))
                    self.assertEqual(found["originalMessageId"], original["messageId"])
                    self.assertEqual(found["assertionKey"], original["attribution"]["assertionKey"])
                    self.assertIsNone(source["date"])
                    self.assertIsNone(source["from"])
                    self.assertNotIn("resolved", found)
                self.assertIn(self.messages[2]["id"], original["attribution"]["laterMessageIds"])
                self.assertTrue(original["attribution"]["requiresReconciliation"])

    def test_legacy_contract_replays_old_nested_boundaries_without_extra_metadata(self):
        body = "C.\n" + GMAIL + quoted("B") + quoted(GMAIL.strip()) + quoted(INVOICES, 2) + "> B again.\n"
        self.messages = [self.mail("aaaaaaaaaaaaaaa1", body)]
        old = self.read(contract="secretary.dossier-sources/v1")
        self.assertNotIn("schema", old)
        self.assertNotIn("attributionPolicy", old)
        self.assertTrue(all(not {"readerContract", "sourceContext", "span", "attribution"}.intersection(s) for s in old["sources"]))
        last = old["sources"][-1]
        self.assertEqual(last["relation"], "quoted")
        self.assertIn("B again.", last["text"])
        current = self.read()
        self.assertEqual(current["sources"][-1]["relation"], "unresolved")
        self.assertEqual(old["sourceHash"], current["sourceHash"])
        self.assertEqual("".join(s["text"] for s in old["sources"]), body)
        again = self.read(contract="secretary.dossier-sources/v1")
        self.assertEqual(old["sources"], again["sources"])
        self.assertEqual(old["sourceHash"], again["sourceHash"])

    def test_draft_cannot_verify_a_quote_or_supply_a_later_sent_reply(self):
        self.messages = [self.mail("aaaaaaaaaaaaaaa1", CAMP, sender=A, date=JULY, timestamp=1784232000000, draft=True),
                         self.mail("aaaaaaaaaaaaaaa2", GMAIL + quoted(CAMP)),
                         self.mail("aaaaaaaaaaaaaaa3", "Unsent answer", timestamp=1791806400000, draft=True)]
        source = next(s for s in self.read()["sources"] if s["relation"] == "quoted")
        self.assertEqual(source["attribution"]["state"], "quoted")
        self.assertNotIn("laterMessageIds", source["attribution"])

    def test_repeated_unmatched_quotes_share_a_key_but_several_originals_do_not_verify_an_author(self):
        self.messages = [self.mail("aaaaaaaaaaaaaaa1", GMAIL + quoted(INVOICES)),
                         self.mail("aaaaaaaaaaaaaaa2", GMAIL + quoted(INVOICES), timestamp=1791806400000)]
        sources = [s for s in self.read()["sources"] if s["relation"] == "quoted"]
        self.assertEqual(sources[0]["attribution"]["state"], "quoted")
        self.assertEqual(sources[0]["attribution"]["assertionKey"], sources[1]["attribution"]["assertionKey"])
        self.messages.extend([
            self.mail("aaaaaaaaaaaaaaa3", INVOICES, sender=A, date=JULY, timestamp=1784232000000),
            self.mail("aaaaaaaaaaaaaaa4", INVOICES, sender=A, date=JULY, timestamp=1784318400000)])
        found = next(s for s in self.read()["sources"] if s["relation"] == "quoted")["attribution"]
        self.assertEqual((found["state"], found["reason"]), ("quoted", "several-earlier-originals"))
        self.assertIsNone(found["author"])
        self.assertIsNone(found["date"])

    def test_source_truncation_retains_full_segment_extent_and_missing_coverage(self):
        self.messages = [self.mail("aaaaaaaaaaaaaaa1", "🙂 First line.\n" + GMAIL + quoted(CAMP * 40))]
        with patch("dossier_sources.MAX_CHARS", 100):
            read = self.read()
        self.assertFalse(read["complete"])
        source = next(s for s in read["sources"] if s["relation"] == "quoted")
        self.assertTrue(source["truncated"])
        self.assertGreater(source["span"]["segmentEnd"], source["span"]["end"])
        span = source["sourceContext"]["segments"][0]
        self.assertTrue(span["continuesAfterPage"])
        self.assertEqual(sum(len(s["text"]) for s in read["sources"]), 100)


if __name__ == "__main__":
    unittest.main()
