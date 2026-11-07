"""Quoted mail attribution and reconciliation on a synthetic corpus (AgentX#754).

Every message, person and address here is invented. No mailbox, model or
network is used.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from evidence_attribution import body_segments  # noqa: E402
from evidence_record import attribute_page_review, record_page  # noqa: E402
from evidence_store import load  # noqa: E402
import mail_catchup as catchup  # noqa: E402
from quote_attribution import (forward_claim, gmail_claim, normalized, page_context,  # noqa: E402
                               reconcile_proposals, segments)
from secretary_evidence import REVIEW_PAGE_CHARS, Archive  # noqa: E402

JULY = 1784246400000      # 2026-07-17 00:00 UTC
OCTOBER = 1791676800000   # 2026-10-11 00:00 UTC
CAMP = "Please bring the green backpack for camp on Monday."
INVOICES = "Could you organize the household invoices before Friday?"
GMAIL_FR = "Le jeu. 16 juil. 2026 à 20 h 00, Person A <a@example.invalid>\n a\n écrit :\n"
GMAIL_EN = "On Thu, Jul 16, 2026 at 8:00 PM Person A <a@example.invalid> wrote:\n"


def quoted(text, level=1):
    return "".join(">" * level + " " + line + "\n" for line in text.splitlines())


def text_of(body, span):
    return body[span["start"]:span["end"]]


class SegmentationTests(unittest.TestCase):
    def test_wrapped_gmail_headers_yield_claims_but_never_verified_authors(self):
        for header, author, date in [
                (GMAIL_FR, "Person A <a@example.invalid>", "jeu. 16 juil. 2026 à 20 h 00"),
                (GMAIL_EN, "Person A <a@example.invalid>", "Thu, Jul 16, 2026 at 8:00 PM"),
                ("On July 16, 2026, Person A\nwrote:\n", "Person A", "July 16, 2026")]:
            body = "Short reply.\n\n" + header + quoted(CAMP)
            spans = segments(body, {"from": "Person B <b@example.invalid>", "date": "Sun, 11 Oct 2026"})
            self.assertEqual(spans[0]["relation"], "authored")
            self.assertEqual(spans[0]["author"], "Person B <b@example.invalid>")
            quote = spans[1]
            self.assertEqual((quote["relation"], quote["attribution"]), ("quoted", "unverified-quoted-header"))
            self.assertEqual((quote["claimedAuthor"], quote["claimedDate"]), (author, date))
            self.assertIsNone(quote["author"])
            self.assertIsNone(quote["date"])
            self.assertEqual("".join(text_of(body, s) for s in spans), body)

    def test_ambiguous_and_partial_headers_keep_their_claims_unknown(self):
        self.assertEqual(gmail_claim("On Thursday, Person A wrote:"), (None, None))
        self.assertEqual(gmail_claim("On Jul 16, 2026 at 8:00 PM wrote:"), (None, None))
        self.assertEqual(gmail_claim("On 16 July 2026, Person 2026 wrote:"), (None, None))
        body = "New reply.\nOn July 16, 2026, Person A\n" + CAMP
        quote = segments(body, {"from": "Person B"})[-1]
        self.assertEqual((quote["attribution"], quote["claimedAuthor"], quote["claimedDate"]), ("unknown", None, None))
        self.assertIn("July 16", quote["quotedHeader"])

    def test_outlook_separators_claim_their_fields_and_conflicts_stay_unknown(self):
        body = ("New reply.\n-----Original Message-----\nFrom: Person A <a@example.invalid>\n"
                "Sent: July 16, 2026 8:00 PM\nTo: Person B\nSubject: Camp\n\n" + CAMP)
        spans = segments(body, {"from": "Person B", "date": "October 11"})
        self.assertEqual(len(spans), 2)  # the From line belongs to the separator block, not a second quote
        self.assertEqual((spans[1]["claimedAuthor"], spans[1]["claimedDate"]),
                         ("Person A <a@example.invalid>", "July 16, 2026 8:00 PM"))
        french = segments("Réponse.\nDe : Personne A\nEnvoyé : 16 juillet 2026\nObjet : Camp\n\n" + CAMP, {"from": "B"})
        self.assertEqual((french[1]["claimedAuthor"], french[1]["claimedDate"]), ("Personne A", "16 juillet 2026"))
        self.assertEqual(forward_claim("From: Person A\nFrom: Person C\nSent: July 16"), (None, None))

    def test_deep_nesting_never_hands_outer_text_to_the_inner_author(self):
        body = ("C's reply.\n\n" + GMAIL_EN.replace("Person A <a@", "Person B <b@").replace("Jul 16", "Aug 2")
                + "> B's answer before the older quote.\n"
                + quoted(GMAIL_EN.strip()) + quoted(INVOICES, 2)
                + "> B's inline remark after the older quote.\n"
                + ">> Headerless deeper text.\n"
                + "> B again.\n")
        spans = segments(body, {"from": "Person C"})
        by_text = {text_of(body, s).strip().splitlines()[-1]: s for s in spans}
        b_header = by_text["> B's answer before the older quote."]
        self.assertEqual(b_header["claimedAuthor"], "Person B <b@example.invalid>")
        a_quote = by_text[">> " + INVOICES]
        self.assertEqual((a_quote["claimedAuthor"], a_quote["quoteDepth"]), ("Person A <a@example.invalid>", 2))
        resumed = by_text["> B's inline remark after the older quote."]
        self.assertEqual((resumed["relation"], resumed["attribution"]), ("unresolved", "unknown"))
        self.assertIsNone(resumed.get("claimedAuthor"))
        self.assertIn("Person B", resumed["enclosingQuotedHeader"])  # context only, not an attribution
        deeper = by_text[">> Headerless deeper text."]
        self.assertEqual((deeper["relation"], deeper["attribution"], deeper.get("claimedAuthor")), ("quoted", "unknown", None))
        self.assertEqual(by_text["> B again."]["relation"], "unresolved")
        self.assertEqual("".join(text_of(body, s) for s in spans), body)

    def test_header_scanning_stays_bounded_on_hostile_text(self):
        # Separate process: a regression cannot strand the runner (see ba33ffef).
        script = """
from quote_attribution import segments
body = ('On an ordinary line\\n' + (' ' * 300 + 'x\\n') * 5) * 40 + ('> On a\\n' * 2000)
spans = segments(body, {'from': 'Container author'})
assert ''.join(body[s['start']:s['end']] for s in spans) == body
"""
        result = subprocess.run([sys.executable, "-c", script], cwd=Path(__file__).resolve().parents[1],
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_container_text_after_a_quote_stays_unresolved_as_in_v1(self):
        spans = segments("> Please pay this invoice.\n\nUncertain inline reply.", {"from": "Person B"})
        self.assertEqual([s["relation"] for s in spans], ["quoted", "unresolved"])
        self.assertIsNone(spans[-1]["author"])
        unprefixed = segments("Reply.\n" + GMAIL_EN + CAMP + "\nMore unprefixed text.", {"from": "B"})
        self.assertEqual(unprefixed[-1]["claimedAuthor"], "Person A <a@example.invalid>")

    def test_window_starting_inside_a_quotation_keeps_header_extent_and_boundary(self):
        body = "Reply.\n\n" + GMAIL_FR + quoted((CAMP + "\n") * 160)
        spans = segments(body, {"from": "Person B", "date": "October 11"})
        context = page_context(spans, REVIEW_PAGE_CHARS, REVIEW_PAGE_CHARS, kind="body", newer_messages=1, text=body)
        self.assertEqual(context["schema"], "secretary.source-context/v2")
        [segment] = context["segments"]
        self.assertTrue(segment["startsBeforePage"])
        self.assertLess(segment["segmentStart"], REVIEW_PAGE_CHARS)
        self.assertEqual(segment["claimedAuthor"], "Person A <a@example.invalid>")
        self.assertIsNone(segment["author"])
        boundary = context["boundary"]
        self.assertEqual(boundary["untrustedTextBefore"], body[REVIEW_PAGE_CHARS - 240:REVIEW_PAGE_CHARS])
        self.assertEqual(boundary["untrustedTextAfter"], body[2 * REVIEW_PAGE_CHARS:2 * REVIEW_PAGE_CHARS + 240])

    def test_v1_contract_used_by_objective_campaigns_and_dossiers_is_unchanged(self):
        body = "C.\n" + GMAIL_EN + quoted("B") + quoted(GMAIL_EN.strip()) + quoted(INVOICES, 2) + "> B again.\n"
        v1 = body_segments(body, {"from": "Person C"})
        self.assertTrue(all(set(s) <= {"start", "end", "relation", "attribution", "quotedHeader", "author", "date"}
                            for s in v1))
        self.assertEqual(v1[-1]["relation"], "quoted")
        self.assertIn("Person A", v1[-1]["quotedHeader"])  # known v1 limit kept for receipt stability

    def test_normalized_view_ignores_quote_markers_and_wrapping(self):
        text, index = normalized(">> Please bring\n>>   the GREEN backpack")
        self.assertEqual(text, "please bring the green backpack")
        self.assertEqual(index[0], 3)


class ArchiveCase(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.threads = {}
        self.archive = Archive(self.root, lambda command: self.threads[next(p for p in command if p in self.threads)])

    def thread(self, tid, *messages):
        self.threads[tid] = {"thread": {"messages": [
            {"id": mid, "body": body, "internalDate": str(date), "labelIds": ["INBOX"],
             "headers": {"from": sender, "date": written, "subject": "Synthetic camp"}}
            for mid, sender, written, date, body in messages]}}
        return self.archive.collect_thread(tid)

    def pages(self, manifest, message_id):
        return [p for p in self.archive.review_pages(manifest) if p["messageId"] == message_id]

    def finding(self, page, excerpt, text="Apporter le sac à dos vert", owner="Person B", status="current"):
        value = {"pageId": page["pageId"], "summary": "Synthetic page", "memories": [], "deliverables": [],
                 "invoices": [], "unresolved": [], "actions": [
                     {"text": text, "status": status, "owner": owner, "due": None, "excerpt": excerpt,
                      "messageId": page["messageId"], "attribution": {"state": "container", "forged": True}}]}
        return attribute_page_review(self.archive, page, value)


A = "Person A <a@example.invalid>"
B = "Person B <b@example.invalid>"


class AttributionTests(ArchiveCase):
    def camp_thread(self, with_original=True, padding=0):
        quote = GMAIL_EN + quoted(("Filler line about the trip.\n" * padding) + CAMP)
        reply = ("mB0000000000002", B, "Sun, 11 Oct 2026", OCTOBER, "Forwarding what you asked in July.\n\n" + quote)
        original = ("mA0000000000001", A, "Thu, 16 Jul 2026", JULY, CAMP + "\nThanks!")
        return self.thread("tcamp000000001", *([original, reply] if with_original else [reply]))

    def test_july_request_quoted_in_october_keeps_its_claimed_author_without_original(self):
        manifest = self.camp_thread(with_original=False, padding=200)
        pages = self.pages(manifest, "mB0000000000002")
        self.assertGreater(len(pages), 1)  # the request sits on a continuation window
        page = next(p for p in pages if CAMP in p["externalUntrustedContent"])
        self.assertTrue(page["sourceContext"]["segments"][0]["startsBeforePage"])
        result = self.finding(page, CAMP)["actions"][0]["attribution"]
        self.assertEqual((result["state"], result["claimedAuthor"]), ("quoted", A))
        self.assertEqual(result["claimedDate"], "Thu, Jul 16, 2026 at 8:00 PM")
        self.assertIsNone(result["author"])
        self.assertNotIn("forged", result)
        self.assertNotIn("October", json.dumps(result))
        self.assertTrue(result["quoteKey"])

    def test_quoted_request_matching_the_original_takes_its_verified_sender_and_date(self):
        manifest = self.camp_thread()
        page = self.pages(manifest, "mB0000000000002")[0]
        result = self.finding(page, "bring the green backpack for camp")["actions"][0]["attribution"]
        self.assertEqual(result["state"], "matched-original")
        self.assertEqual((result["author"], result["date"], result["originalMessageId"]),
                         (A, "Thu, 16 Jul 2026", "mA0000000000001"))
        self.assertEqual(result["anchor"]["messageId"], "mA0000000000001")
        self.assertEqual(result["containerMessageId"], "mB0000000000002")
        # The original, read on its own page, sees the later reply quoting it.
        own = self.finding(self.pages(manifest, "mA0000000000001")[0], CAMP)["actions"][0]["attribution"]
        self.assertEqual((own["state"], own["author"], own["laterMessageIds"]), ("container", A, ["mB0000000000002"]))

    def test_a_contradicting_quoted_claim_never_matches_another_sender(self):
        manifest = self.thread("tconflict00001",
            ("mA0000000000001", "Person C <c@example.invalid>", "July", JULY, CAMP),
            ("mB0000000000002", B, "October", OCTOBER, "Fwd.\n" + GMAIL_EN + quoted(CAMP)))
        result = self.finding(self.pages(manifest, "mB0000000000002")[0], CAMP)["actions"][0]["attribution"]
        self.assertEqual((result["state"], result["reason"]), ("quoted", "quoted-claim-contradicts-original-sender"))

    def test_excerpts_must_be_verbatim_on_the_page_and_in_one_attribution(self):
        body = "I will bring the green backpack for camp on Monday.\n" + GMAIL_EN + quoted(CAMP)
        manifest = self.thread("tambiguous0001", ("mB0000000000002", B, "October", OCTOBER, body))
        page = self.pages(manifest, "mB0000000000002")[0]
        states = {excerpt: self.finding(page, excerpt)["actions"][0]["attribution"]
                  for excerpt in ("green backpack for camp on Monday", "invented sentence absent here", "unknown", None)}
        self.assertEqual(states["green backpack for camp on Monday"]["reason"],
                         "excerpt-spans-differently-attributed-segments")
        self.assertEqual(states["invented sentence absent here"]["reason"], "excerpt-not-on-page")
        self.assertTrue(all(s["state"] == "unlocated" for s in states.values()))
        mine = self.finding(page, "I will bring the green backpack")["actions"][0]["attribution"]
        self.assertEqual((mine["state"], mine["author"]), ("container", B))

    def test_attachment_findings_keep_unknown_authorship(self):
        result = self.finding({"pageId": "p", "messageId": "m1", "kind": "attachment", "threadId": "t", "offset": 0}, CAMP)
        self.assertEqual(result["actions"][0]["attribution"]["state"], "attachment")


class ReconciliationTests(ArchiveCase):
    def proposals(self, page, value):
        return catchup.proposals_for({**page, "internalDate": int(time.time() * 1000)}, value)

    def test_mixed_page_separates_current_container_request_from_quoted_history(self):
        body = ("Could you send me the signed camp form today?\n\n" + GMAIL_EN + quoted(INVOICES))
        manifest = self.thread("tmixed00000001", ("mB0000000000002", B, "October", OCTOBER, body))
        page = self.pages(manifest, "mB0000000000002")[0]
        value = {"pageId": page["pageId"], "summary": "x", "memories": [], "deliverables": [], "invoices": [],
                 "unresolved": [], "actions": [
                     {"text": "Envoyer le formulaire", "status": "current", "owner": "owner", "due": None,
                      "excerpt": "send me the signed camp form", "messageId": page["messageId"]},
                     {"text": "Organiser les factures", "status": "current", "owner": "Person B", "due": None,
                      "excerpt": INVOICES, "messageId": page["messageId"]},
                     {"text": "Sans extrait", "status": "current", "owner": "owner", "due": None,
                      "excerpt": None, "messageId": page["messageId"]}]}
        rows = self.proposals(page, attribute_page_review(self.archive, page, value))
        self.assertEqual([r["kind"] for r in rows], ["action", "recheck", "recheck"])
        self.assertEqual(rows[1]["attribution"]["claimedAuthor"], A)
        self.assertNotIn("quotedHeader", rows[1]["attribution"])

    def test_requests_answered_later_or_repeated_from_earlier_mail_are_rechecked(self):
        manifest = self.thread("tlater00000001",
            ("mA0000000000001", A, "July", JULY, INVOICES),
            ("mB0000000000002", B, "October", OCTOBER, "Done, see attached.\n" + GMAIL_EN + quoted(INVOICES)),
            ("mC0000000000003", B, "October", OCTOBER + 1, INVOICES + " (as A asked)"))
        original = self.pages(manifest, "mA0000000000001")[0]
        rows = self.proposals(original, self.finding(original, INVOICES, owner="Person B"))
        self.assertEqual(rows[0]["kind"], "recheck")
        self.assertEqual(rows[0]["attribution"]["laterMessageIds"], ["mB0000000000002", "mC0000000000003"])
        repeat = self.pages(manifest, "mC0000000000003")[0]
        retyped = self.finding(repeat, INVOICES)["actions"][0]["attribution"]
        self.assertEqual((retyped["state"], retyped["earlierAuthoredMessageIds"]), ("container", ["mA0000000000001"]))
        self.assertEqual(self.proposals(repeat, self.finding(repeat, INVOICES))[0]["kind"], "recheck")

    def test_matched_quote_cites_the_original_and_duplicates_reconcile_without_resending(self):
        quote = GMAIL_EN + quoted(CAMP)
        manifest = self.thread("tdupes00000001",
            ("mA0000000000001", A, "Thu, 16 Jul 2026", JULY, CAMP),
            ("mB0000000000002", B, "October", OCTOBER, "First forward.\n" + quote),
            ("mC0000000000003", B, "October", OCTOBER + 1, "Second forward.\n" + quote))
        rows = []
        for mid in ("mC0000000000003", "mB0000000000002", "mA0000000000001"):  # newest first, as catch-up reads
            page = self.pages(manifest, mid)[0]
            new = reconcile_proposals(rows, self.proposals(page, self.finding(page, CAMP)), "2026-11-06T00:00:00Z")
            rows.extend(new)
        first = rows[0]
        self.assertEqual((first["kind"], first["messageId"], first["state"]), ("recheck", "mA0000000000001", "pending"))
        self.assertEqual(first["sourceDate"], "2026-07-17T00:00:00+00:00")
        self.assertEqual([r["state"] for r in rows[1:]], ["reconciled", "reconciled"])
        self.assertTrue(all(r["reconciledWith"] == first["key"] for r in rows[1:]))
        self.assertEqual(len({r["findingKey"] for r in rows[:2]}), 1)

    def test_unmatched_repeated_quotes_reconcile_by_header_and_excerpt_only(self):
        quote = GMAIL_EN + quoted(CAMP + "\n" + INVOICES)
        manifest = self.thread("tunmatched0001",
            ("mB0000000000002", B, "October", OCTOBER, "One.\n" + quote),
            ("mC0000000000003", B, "October", OCTOBER + 1, "Two.\n" + quote))
        first, second = (self.pages(manifest, mid)[0] for mid in ("mB0000000000002", "mC0000000000003"))
        rows = self.proposals(first, self.finding(first, CAMP))
        same = reconcile_proposals(rows, self.proposals(second, self.finding(second, CAMP)), "t")
        other = reconcile_proposals(rows, self.proposals(second, self.finding(second, INVOICES)), "t")
        self.assertEqual((same[0]["state"], other[0]["state"]), ("reconciled", "pending"))
        # Two findings on the same page are never merged with each other.
        page_twice = self.proposals(first, self.finding(first, CAMP))
        self.assertEqual(reconcile_proposals(page_twice[:1], page_twice, "t")[0]["state"], "pending")


class PreservationTests(ArchiveCase):
    def test_page_ids_originals_and_existing_receipts_survive_and_record_stores_attribution(self):
        body = "Reply.\n\n" + GMAIL_FR + quoted((CAMP + "\n") * 120)
        manifest = self.thread("tpreserve00001", ("mA0000000000001", A, "July", JULY, CAMP),
                               ("mB0000000000002", B, "October", OCTOBER, body))
        original_file = self.root / "threads" / "tpreserve00001" / "original.json"
        before = original_file.read_bytes()
        pages = self.pages(manifest, "mB0000000000002")
        for page in pages:
            expected = hashlib.sha256(json.dumps(["tpreserve00001", page["messageId"], "body", None,
                                                  page["offset"], page["externalUntrustedContent"]]).encode()).hexdigest()
            self.assertEqual(page["pageId"], expected)
        self.assertEqual("".join(p["externalUntrustedContent"] for p in pages), body)
        prior = self.root / "page-reviews" / (pages[0]["pageId"] + ".json")
        prior.parent.mkdir(parents=True, exist_ok=True)
        prior.write_text('{"pageId": "%s", "summary": "Read before the upgrade"}' % pages[0]["pageId"])
        receipt_before = prior.read_bytes()
        value = {"pageId": pages[1]["pageId"], "summary": "Synthetic page", "memories": [], "deliverables": [],
                 "invoices": [], "unresolved": [], "actions": [
                     {"text": "Apporter le sac", "status": "historical", "owner": "Person B", "due": None,
                      "excerpt": CAMP, "messageId": "mB0000000000002"}]}
        record_page(self.archive, pages[1], value, export=False)
        saved = load(self.root / "reviews" / "tpreserve00001.json")["actions"][0]["attribution"]
        self.assertEqual((saved["state"], saved["originalMessageId"]), ("matched-original", "mA0000000000001"))
        stored = load(self.root / "page-reviews" / (pages[1]["pageId"] + ".json"))
        self.assertEqual(stored["actions"][0]["attribution"]["state"], "matched-original")
        self.assertEqual(original_file.read_bytes(), before)
        self.assertEqual(prior.read_bytes(), receipt_before)
        self.assertNotIn("attribution", value["actions"][0])  # the caller's value is not mutated

    def test_catchup_records_attributed_findings_and_sends_the_quote_once(self):
        quote = GMAIL_EN + quoted(CAMP)
        now_ms = int(time.time() * 1000)
        self.thread("tcatchup000001",
            ("mB0000000000002", B, "Recent", now_ms - 2000, "First forward.\n" + quote),
            ("mC0000000000003", B, "Recent", now_ms - 1000, "Second forward.\n" + quote))

        class Client:
            calls, proposed = [], []

            def busy(self):
                return None

            def extract(self, system, prompt, light=False, request_id=None):
                self.calls.append(prompt)
                return {"summary": "Page lue", "memories": [], "deliverables": [], "invoices": [], "unresolved": [],
                        "actions": [{"text": "Apporter le sac", "status": "current", "owner": "Person B",
                                     "due": "unknown", "excerpt": CAMP}]}

            def propose(self, proposal):
                self.proposed.append(proposal)
                return {"kind": "signal", "id": "s" + proposal["key"][:6]}

        class Lock:
            def touch(self):
                pass

        client = Client()
        status = catchup.catchup(self.archive, client, Lock(), sleep=lambda _: None)
        self.assertEqual((status["reviewed"], status["proposals"], status["reconciledProposals"]), (2, 1, 1))
        self.assertEqual([p["kind"] for p in client.proposed], ["recheck"])
        self.assertIn("excerpt", json.dumps(catchup.REVIEW_SCHEMA))
        self.assertIn('"boundary"', client.calls[0])
        saved = load(self.root / catchup.PROPOSALS_NAME)
        self.assertEqual([p["state"] for p in saved], ["queued", "reconciled"])


if __name__ == "__main__":
    unittest.main()
