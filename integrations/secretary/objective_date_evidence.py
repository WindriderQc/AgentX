"""Literal date selections; message headers never date an underlying event."""
from datetime import date, datetime
import re
import unicodedata


def folded(text):
    return "".join(c for c in unicodedata.normalize("NFKD", text.lower()) if not unicodedata.combining(c)).rstrip(".")


MONTHS = {}
for number, names in enumerate(("janvier janv january jan", "février fevrier févr fevr february feb",
    "mars march mar", "avril april avr apr", "mai may", "juin june jun", "juillet july juil jul",
    "août aout august aug", "septembre september sept sep", "octobre october oct",
    "novembre november nov", "décembre decembre déc dec december"), 1):
    for name in names.split():
        MONTHS[folded(name)] = number
MONTH_PATTERN = "(?:" + "|".join(sorted((re.escape(s) for s in MONTHS), key=len, reverse=True)) + r")\.?"
ACCENTS = str.maketrans({chr(n): folded(chr(n)) for n in range(0xC0, 0x180)
                        if len(folded(chr(n))) == 1 and folded(chr(n)).isascii()})
# Matching is accent-insensitive, but every retained text/offset refers to the
# untouched original. NFKD accents are removed one character at a time below.
PATTERNS = [
    (re.compile(r"(?<!\d)(?P<year>[12]\d{3})-(?P<number>\d{2})(?:-(?P<day>\d{2}))?(?![\d-])"), None),
    (re.compile(r"(?<!\w)(?P<day>\d{1,2})(?:er|st|nd|rd|th)?\s+(?P<month>" + MONTH_PATTERN + r")\s+(?P<year>[12]\d{3})(?!\d)", re.I), "day"),
    (re.compile(r"\b(?P<month>" + MONTH_PATTERN + r")\s+(?P<day>\d{1,2})(?:st|nd|rd|th)?,?\s+(?P<year>[12]\d{3})(?!\d)", re.I), "day"),
    (re.compile(r"\b(?P<month>" + MONTH_PATTERN + r")\s+(?P<year>[12]\d{3})(?!\d)", re.I), "month"),
    (re.compile(r"\b(?:en|in)\s+(?P<year>[12]\d{3})(?![\d-])", re.I), "year"),
]
HEADER = re.compile(r"^\s*(?:>\s*)*(?:(?:date|envoy[ée]|sent)\s*:|on\s+.+wrote\s*:|le\s+.+[ée]crit\s*:)", re.I)
COMMUNICATION_TYPES = {"career-contact", "application", "work-correspondence"}


def expressions(text):
    # These substitutions preserve character offsets (unlike casefold or a
    # whole-string decomposition of arbitrary Unicode).
    plain = text.translate(ACCENTS)
    found, occupied = [], []
    for pattern, precision in PATTERNS:
        for match in pattern.finditer(plain):
            if any(match.start() < end and match.end() > start for start, end in occupied):
                continue
            if precision == "month" and re.search(r"\b\d+(?:er|st|nd|rd|th)?\s+$", plain[:match.start()], re.I):
                # An unsupported/invalid printed day must not disappear when
                # the lower-priority month expression is considered.
                continue
            occupied.append((match.start(), match.end()))
            values = match.groupdict()
            year = int(values["year"])
            month = int(values["number"]) if values.get("number") else MONTHS.get(folded(values.get("month") or ""), 1)
            day = int(values.get("day") or 1)
            try:
                normalized = date(year, month, day).isoformat()
            except ValueError:
                continue
            unit = precision or ("day" if values.get("day") else "month")
            normalized = normalized[:4] if unit == "year" else normalized[:7] if unit == "month" else normalized
            found.append({"start": match.start(), "end": match.end(), "text": text[match.start():match.end()],
                          "value": normalized, "precision": unit})
    return sorted(found, key=lambda row: row["start"])


def catalog(spans, context=None):
    entries = []
    message_date = context.get("mailDate") if isinstance(context, dict) else None
    if isinstance(message_date, str):
        try:
            parsed = datetime.fromisoformat(message_date.replace("Z", "+00:00"))
            entries.append({"id": "m0", "kind": "communication", "citationId": None,
                            "text": message_date, "value": parsed.date().isoformat(), "precision": "day",
                            "source": "retained-message-metadata"})
        except ValueError:
            pass
    for span in spans:
        for row in expressions(span["text"]):
            # A free-standing date gives no event association. It is not an
            # invitation to borrow the date for an adjacent event.
            if span["text"].strip() == row["text"].strip():
                continue
            entries.append({"id": "d" + str(len(entries) + 1),
                            "kind": "communication" if HEADER.search(span["text"]) else "event-expression",
                            "citationId": span["id"], "source": "exact-passage",
                            **row, "start": span["start"] + row["start"], "end": span["start"] + row["end"]})
    return entries


def resolve(moment, entries, observed_ids):
    proof, words, quotes = [], [], []
    for side in ("start", "end"):
        reference = moment.pop(side + "DateRef")
        if reference is None:
            moment[side + "Date"], moment[side + "Precision"] = None, "unknown"
            continue
        if not isinstance(reference, str) or reference not in entries:
            raise ValueError("A date must select an actual supplied date reference")
        entry = entries[reference]
        if entry["kind"] == "communication":
            if moment["factType"] not in COMMUNICATION_TYPES or side != "start":
                raise ValueError("A communication date cannot date an underlying life event")
        elif entry["citationId"] not in observed_ids:
            raise ValueError("An event date must be cited in that event's own observations")
        moment[side + "Date"], moment[side + "Precision"] = entry["value"], entry["precision"]
        words.append(entry["text"])
        proof.append({"side": side, **entry})
        if entry["citationId"]:
            quotes.append(entry["citationId"])
    moment["originalDate"] = " ; ".join(dict.fromkeys(words))
    return proof, quotes
