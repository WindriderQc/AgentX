from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from evidence_store import save
from structured_sources import MAX_BYTES, digest, objects, parse, prepare


def calendar(properties):
    return ("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\n" + properties
            + "\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n").encode()


class StructuredSourceTests(unittest.TestCase):
    def test_calendar_status_and_stamp_do_not_establish_attendance_or_event_time(self):
        source = calendar("UID:synthetic-event\r\nDTSTAMP:20200101T120000Z\r\nDTSTART;VALUE=DATE:20200102\r\n"
                          "DTEND;VALUE=DATE:20200103\r\nSTATUS:CONFIRMED\r\nSUMMARY:Synthetic appointment\r\nLAST-MOD:20200101T130000Z")
        result = parse(source); event = objects(result)[0]
        self.assertEqual(result["structureStatus"], "parsed")
        self.assertFalse(result["analysisComplete"])
        self.assertEqual(event["participation"], "unknown")
        self.assertEqual(event["assertionState"], "unknown")
        self.assertEqual(event["eventDates"][0]["date"]["value"], "2020-01-02")
        self.assertEqual(event["eventDates"][1]["date"]["value"], "2020-01-03")
        self.assertEqual(event["sourceDateCandidates"][0]["name"], "DTSTAMP")
        self.assertEqual(next(p for p in event["properties"] if p["name"] == "LAST-MOD")["rawValue"], "20200101T130000Z")

    def test_local_time_custom_timezone_and_recurrence_remain_explicit(self):
        event = objects(parse(calendar('UID:synthetic-recurring\r\nDTSTART;TZID="Custom:Zone":20201101T013000\r\n'
                                       'RRULE:FREQ=WEEKLY;COUNT=3\r\nEXDATE:20201108T013000\r\n'
                                       'RECURRENCE-ID:20201101T013000\r\nSEQUENCE:2\r\nSTATUS:CANCELLED')))[0]
        self.assertEqual(event["eventDates"][0]["date"]["kind"], "local")
        self.assertNotIn("value", event["eventDates"][0]["date"])
        self.assertEqual(event["eventDates"][0]["parameters"]["TZID"], ['"Custom:Zone"'])
        self.assertTrue(event["needsReconciliation"])
        self.assertEqual(event["calendarMethodAsWritten"], ["REQUEST"])
        self.assertEqual(event["participation"], "unknown")

    def test_folded_unicode_escaped_text_and_literal_value_quotes_are_preserved(self):
        source = calendar('SUMMARY:Une réunion\\, reportée\\navec un "devis\r\nDESCRIPTION:Suite\\; encore\\\\fin')
        source = source.replace('réunion'.encode(), b'r\xc3\r\n \xa9union')
        result = parse(source); event = objects(result)[0]
        self.assertEqual(result["structureStatus"], "parsed")
        summary = next(p for p in event["properties"] if p["name"] == "SUMMARY")
        self.assertEqual(summary["text"], 'Une réunion, reportée\navec un "devis')

    def test_vcard_without_dates_is_a_contact_assertion_without_a_meeting_date(self):
        data = b"BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Synthetic Person\r\nN:Person;Synthetic;;;\r\nitem1.EMAIL:first@example.invalid\r\nEMAIL:second@example.invalid\r\nEND:VCARD\r\n"
        card = objects(parse(data))[0]
        self.assertEqual(card["kind"], "contact")
        self.assertEqual(card["sourceDateCandidates"], [])
        self.assertEqual(card["eventDates"], [])
        self.assertEqual(len([p for p in card["properties"] if p["name"] == "EMAIL"]), 2)
        self.assertEqual(next(p for p in card["properties"] if p["group"])["group"], "ITEM1")

    def test_partial_text_invalid_and_conflicting_dates_never_gain_an_invented_day(self):
        data = b"BEGIN:VCARD\nVERSION:4.0\nBDAY:--0229\nANNIVERSARY;VALUE=text:20200101\nREV:20200230T000000Z\nEND:VCARD\n"
        card = objects(parse(data))[0]
        self.assertEqual(card["eventDates"][0]["date"]["kind"], "unparsed")
        self.assertEqual(card["eventDates"][1]["date"]["kind"], "text")
        self.assertEqual(card["sourceDateCandidates"][0]["date"]["kind"], "unparsed")
        event = objects(parse(calendar("DTSTART;VALUE=DATE:20200101T120000Z\r\nDTEND;TZID=Custom:20200101T130000Z")))[0]
        self.assertTrue(all(p["date"]["kind"] == "unparsed" for p in event["eventDates"]))

    def test_nested_alarms_do_not_become_separate_life_events(self):
        data = calendar("SUMMARY:Synthetic event\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Synthetic reminder\r\nEND:VALARM")
        rows = objects(parse(data))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["nestedComponents"][0]["type"], "VALARM")

    def test_legacy_encoding_malformed_input_and_limits_stay_visible(self):
        legacy = b"BEGIN:VCARD\nFN;ENCODING=QUOTED-PRINTABLE;CHARSET=ISO-8859-1:Ren=E9\nEND:VCARD\n"
        result = parse(legacy)
        self.assertEqual(result["structureStatus"], "needs_review")
        self.assertNotIn("text", objects(result)[0]["properties"][0])
        self.assertEqual(parse(b"BEGIN:VCARD\nFN:Incomplete")["structureStatus"], "needs_review")
        self.assertEqual(parse(b"x" * (MAX_BYTES + 1))["issues"][0]["code"], "source_exceeds_bounded_reader")
        self.assertEqual(parse(b"BEGIN:X\n" * 40)["issues"][0]["code"], "component_depth_limit")

    def test_only_the_selected_existing_outlook_export_is_read_and_hashes_are_verified(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            selected, other = "a" * 64, "b" * 64
            data = b"BEGIN:VCARD\nVERSION:3.0\nFN:Synthetic Person\nEND:VCARD\n"
            path = "outlook/items/synthetic.vcf"
            (root / path).parent.mkdir(parents=True)
            (root / path).write_bytes(data)
            save(root / "outlook/exports.json", {selected: {}, other: {}})
            save(root / "outlook/inventory.json", {"items": {digest(data): {
                "sha256": digest(data), "bytes": len(data), "path": path, "kind": "contact", "exports": [selected]}}})
            report = prepare(root, selected)
            self.assertEqual(report["counts"]["contact"], 1)
            self.assertEqual(report["sources"][0]["occurrences"][0]["sourceTimestamp"], None)
            self.assertFalse(report["analysisComplete"])
            self.assertEqual(report["providerEffects"], 0)
            self.assertEqual(prepare(root, other)["counts"]["selected"], 0)
            identity = report["sources"][0]["objects"][0]["sourceAssertionId"]
            self.assertEqual(identity, prepare(root, selected)["sources"][0]["objects"][0]["sourceAssertionId"])
            (root / path).write_bytes(b"corrupt")
            self.assertEqual(prepare(root, selected)["sources"][0]["issues"][0]["code"], "preservation_receipt_mismatch")
            with self.assertRaisesRegex(ValueError, "existing recorded"):
                prepare(root, "c" * 64)


if __name__ == "__main__":
    unittest.main()
