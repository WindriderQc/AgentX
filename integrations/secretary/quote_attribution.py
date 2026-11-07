"""Attribute quoted mail passages and reconcile repeated readings (AgentX#754).

The containing message, a quoted passage and the author/date that passage
claims stay separate. Quoted headers are untrusted text: they yield *claims*
only when the header splits without guessing, otherwise the claim stays
unknown. A quoted passage gains a verified author/date only by matching the
original message in the same archived thread.

Version 2 of the mail page context. New objective/dossier contracts reuse this
engine through source_quote_context; historical contracts retain v1 boundaries.
Nothing here changes an original message, a page identity, page text, a source
hash or an existing receipt.
"""
from __future__ import annotations

from bisect import bisect_left
import hashlib
import json
import re

from evidence_attribution import FORWARD_FIELD, FORWARDED, PARTIAL_REPLY, POLICY as V1_POLICY

SCHEMA = "secretary.source-context/v2"
FINDING_SCHEMA = "secretary.finding-attribution/v1"
BOUNDARY_CHARS = 240
MIN_EXCERPT = 8
MAX_OCCURRENCES = 50
POLICY = V1_POLICY + (
    " claimedAuthor/claimedDate repeat what a quoted header says; they are not verified."
    " Text resuming an outer level after a nested quotation is unresolved. Cite every"
    " finding with a verbatim excerpt: Secretary attributes it to the segment holding it."
)

# v1's GMAIL takes its first line greedily, so a header followed within four
# lines by a nested '> On ... wrote:' swallows it. Stop at the earliest
# 'wrote:' line instead; the bounded per-line budget is unchanged.
GMAIL_HEADER = re.compile(
    r"(?im)^[ \t>]*(?:Le|On)\s+[^\n]{1,300}?"
    r"(?:\n[^\n]{0,300}?){0,4}?"
    r"(?:a\s+écrit|wrote)\s*:\s*(?:\r?\n|$)"
)
LEAD = re.compile(r"[ \t]*(?:>[ \t]*)*")
EMAIL = re.compile(r"<[^<>\s@]+@[^<>\s]+>")
DATE_END = re.compile(r"(?i)\b\d{1,2}\s*(?::|h)\s*\d{2}(?:\s*[ap]\.?\s?m\b\.?)?|\b\d{4}\b|\b\d{1,2}/\d{1,2}/\d{2,4}\b")
GMAIL_PARTS = re.compile(r"(?is)^(?:le|on)\s+(?P<rest>.+?)\s*(?:a\s+écrit|wrote)\s*:\s*$")
FIELD = re.compile(r"^[ \t>]*(From|De|Sent|Envoyé|Date)\s*:\s*(.*?)\s*$", re.I)
LETTER = re.compile(r"[^\W\d_]")


def depth(line):
    return LEAD.match(line).group(0).count(">")


def _lines(text):
    start = 0
    while start < len(text):
        newline = text.find("\n", start)
        end = len(text) if newline < 0 else newline + 1
        yield start, end
        start = end


def _forward_end(text, match):
    """Same bounded field scan as evidence_attribution.forward_header, as an offset."""
    end = match.end()
    for line in text[match.end():].splitlines(keepends=True)[:8]:
        if not line.strip():
            if end == match.end():
                end += len(line)
                continue
            break
        if not FORWARD_FIELD.match(line) or len(line) > 400:
            break
        end += len(line)
    return end


def _events(text):
    gmail = list(GMAIL_HEADER.finditer(text))
    inside = lambda position: any(m.start() <= position < m.end() for m in gmail)  # noqa: E731
    # (start, priority, end, kind): a Gmail header wins over a line it contains.
    events = [(m.start(), 0, m.end(), "gmail") for m in gmail]
    events += [(m.start(), 1, _forward_end(text, m), "forward") for m in FORWARDED.finditer(text) if not inside(m.start())]
    events += [(m.start(), 2, m.end(), "partial") for m in PARTIAL_REPLY.finditer(text) if not inside(m.start())]
    return sorted(events)


def _flatten(header):
    return " ".join(" ".join(LEAD.sub("", line, count=1) for line in header.splitlines()).split())


def gmail_claim(header):
    """(author, date) as written, or (None, None) when the split needs a guess."""
    match = GMAIL_PARTS.match(_flatten(header))
    if not match:
        return None, None
    rest = match.group("rest")
    # Digits inside an address are never a date or time.
    masked = EMAIL.sub(lambda m: "\0" * len(m.group(0)), rest)
    ends = list(DATE_END.finditer(masked))
    if not ends:
        return None, None
    date, author = rest[:ends[-1].end()].strip(" ,"), rest[ends[-1].end():].strip(" ,")
    if not author or len(author) > 200 or author.casefold().startswith(("at ", "à ")) \
            or not (LETTER.search(EMAIL.sub("", author)) or EMAIL.search(author)):
        return None, None
    return author, date


def forward_claim(header):
    """From/Sent fields of an Outlook block; conflicting repeats stay unknown."""
    seen = {}
    for line in header.splitlines():
        match = FIELD.match(line)
        if not match or not match.group(2):
            continue
        key = "author" if match.group(1).casefold() in ("from", "de") else "date"
        if seen.get(key, match.group(2)) != match.group(2):
            return None, None
        seen[key] = match.group(2)
    return seen.get("author"), seen.get("date")


def _header_context(kind, header, content_depth):
    author, date = (gmail_claim(header) if kind == "gmail" else forward_claim(header) if kind == "forward"
                    else (None, None))
    return {"relation": "quoted", "attribution": "unknown" if kind == "partial" else "unverified-quoted-header",
            "author": None, "date": None, "quotedHeader": header.strip(), "claimedAuthor": author,
            "claimedDate": date, "quoteDepth": content_depth}


def _nearest_header(stack):
    for context, _, _ in reversed(stack):
        header = context.get("quotedHeader") or context.get("enclosingQuotedHeader")
        if header:
            return header
    return None


def _next_depth(text, position):
    if position > 0 and text[position - 1] != "\n":
        newline = text.find("\n", position)
        if newline < 0:
            return None
        position = newline + 1
    for start, end in _lines(text[position:]):
        line = text[position + start:position + end]
        if line.strip():
            return depth(line)
    return None


def segments(text, headers):
    """Continuous, lossless spans that follow quotation depth.

    A header opens a quoted level. With '>' prefixes the level ends when the
    prefix depth drops; text then resuming an outer level is unresolved (the
    enclosing header stays visible as context), never the inner author's. An
    unprefixed separator at the top level conservatively quotes the remainder,
    as in v1. A deeper '>' block without its own header is quoted, unknown.
    """
    container = {"relation": "authored", "attribution": "container-header" if headers.get("from") else "unknown",
                 "author": headers.get("from"), "date": headers.get("date"), "quoteDepth": 0}
    events, index = _events(text), 0
    stack = [(container, 0, True)]  # (context, content depth, sticky)
    spans, state = [], {"context": container, "start": 0}

    def switch(at, context):
        if context is state["context"]:
            return
        if at > state["start"]:
            spans.append({"start": state["start"], "end": at, **state["context"]})
        state.update(context=context, start=at)

    header_end = -1
    for start, end in _lines(text):
        if start < header_end:
            continue
        while index < len(events) and events[index][0] < start:
            index += 1  # inside an earlier header block
        line = text[start:end]
        if index < len(events) and events[index][0] == start:
            _, _, stop, kind = events[index]
            index += 1
            level = depth(line)
            while not stack[-1][2] and stack[-1][1] > level:
                stack.pop()
            following = _next_depth(text, stop)
            content = following if following is not None and following > level else level
            context = _header_context(kind, text[start:stop], content)
            stack.append((context, content, content == 0))
            switch(start, context)
            header_end = stop
            continue
        if not line.strip():
            continue
        level, popped = depth(line), False
        while len(stack) > 1 and not stack[-1][2] and stack[-1][1] > level:
            stack.pop()
            popped = True
        if level > stack[-1][1]:
            context = {"relation": "quoted", "attribution": "unknown", "author": None, "date": None,
                       "quoteDepth": level, "enclosingQuotedHeader": _nearest_header(stack)}
            stack.append((context, level, False))
            switch(start, context)
        elif popped:
            context = {"relation": "unresolved", "attribution": "unknown", "author": None, "date": None,
                       "quoteDepth": level, "reason": "text-after-nested-quotation",
                       "enclosingQuotedHeader": _nearest_header(stack)}
            stack[-1] = (context, stack[-1][1], stack[-1][2])
            switch(start, context)
    spans.append({"start": state["start"], "end": len(text), **state["context"]})
    for number, span in enumerate(spans):
        span["segmentIndex"] = number
    return spans


def page_context(spans, offset, length, *, kind, newer_messages, text):
    """Segments intersecting a page, their full extent and bounded boundary text."""
    end = offset + length
    if kind != "body":
        spans = [{"start": offset, "end": end, "relation": "attachment", "attribution": "unknown",
                  "author": None, "date": None, "segmentIndex": 0}]
    rows = [{**span, "start": max(offset, span["start"]), "end": min(end, span["end"]),
             "segmentStart": span["start"], "segmentEnd": span["end"],
             "startsBeforePage": span["start"] < offset, "continuesAfterPage": span["end"] > end}
            for span in spans if span["start"] < end and span["end"] > offset or span["start"] == span["end"] == offset]
    context = {"schema": SCHEMA, "offsetUnit": "unicode-code-point",
               "containerHasNewerMessages": newer_messages > 0, "newerMessageCount": newer_messages,
               "segments": rows, "policy": POLICY}
    if kind == "body":
        context["boundary"] = {"untrustedTextBefore": text[max(0, offset - BOUNDARY_CHARS):offset],
                               "untrustedTextAfter": text[end:end + BOUNDARY_CHARS]}
    return context


def normalized(text):
    """Casefolded text without quote prefixes or whitespace runs, with original offsets."""
    out, index, position, line_start, space = [], [], 0, True, False
    while position < len(text):
        if line_start:
            position, line_start = LEAD.match(text, position).end(), False
            continue
        char = text[position]
        if char == "\n" or char.isspace():
            line_start, space = line_start or char == "\n", True
            position += 1
            continue
        if space and out:
            out.append(" ")
            index.append(position)
        space = False
        for folded in char.casefold():
            out.append(folded)
            index.append(position)
        position += 1
    return "".join(out), index


def _occurrences(view, needle, low=0, high=None):
    """Original offsets of the needle, starting from an original offset window."""
    text, index = view
    found, position = [], text.find(needle, bisect_left(index, max(0, low - len(needle) * 4)))
    while position >= 0 and len(found) < MAX_OCCURRENCES and (high is None or index[position] < high):
        found.append((index[position], index[position + len(needle) - 1] + 1))
        position = text.find(needle, position + 1)
    return found


def _covering(spans, start, end):
    return [span for span in spans if span["start"] < end and span["end"] > start]


def _identity(span):
    return tuple(span.get(k) for k in ("relation", "attribution", "quotedHeader", "claimedAuthor",
                                       "claimedDate", "enclosingQuotedHeader"))


def _email(value):
    match = EMAIL.search(value or "") or re.search(r"[^\s<>@]+@[^\s<>]+", value or "")
    return match.group(0).strip("<>").casefold() if match else None


def _digest(*parts):
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False).encode()).hexdigest()[:32]


def thread_messages(archive, manifest, *, load, message_text):
    payload = load(archive.root / "threads" / manifest["threadId"] / "original.json")
    originals = {m["id"]: m for m in payload.get("thread", payload)["messages"]}
    rows = []
    for message in manifest["messages"]:
        headers = {k.lower(): v for k, v in message["headers"].items() if k.lower() in ("from", "date")}
        body = message_text(originals[message["id"]])
        rows.append({"id": message["id"], "internalDate": int(message.get("internalDate") or 0), "headers": headers,
                     "body": body, "spans": segments(body, headers), "view": normalized(body)})
    return rows


def attribute(page, excerpt, messages):
    """Locate a finding's verbatim excerpt on its page, then reconcile the thread.

    States: container (the containing message authored it), quoted (a quoted
    header claims it, or nobody), unresolved, matched-original (the passage is
    the authored text of exactly one earlier message), attachment, unlocated.
    """
    result = {"schema": FINDING_SCHEMA, "containerMessageId": page["messageId"]}
    if page.get("kind") != "body":
        return {**result, "state": "attachment", "reason": "attachment-authorship-unknown"}
    needle = normalized(excerpt or "")[0].strip()
    if len(needle) < MIN_EXCERPT:
        return {**result, "state": "unlocated", "reason": "no-verbatim-excerpt"}
    result["excerptSha256"] = hashlib.sha256(needle.encode()).hexdigest()
    own = next((m for m in messages if m["id"] == page["messageId"]), None)
    if own is None:
        return {**result, "state": "unlocated", "reason": "container-not-in-thread"}
    low = page["offset"] - BOUNDARY_CHARS
    high = page["offset"] + len(page.get("externalUntrustedContent") or "") + BOUNDARY_CHARS
    hits = [(s, e) for s, e in _occurrences(own["view"], needle, low, high) if s < high and e > low]
    if not hits:
        return {**result, "state": "unlocated", "reason": "excerpt-not-on-page"}
    covered = [_covering(own["spans"], s, e) for s, e in hits]
    identities = {_identity(span) for spans in covered for span in spans}
    if len(identities) != 1:
        return {**result, "state": "unlocated", "reason": "excerpt-spans-differently-attributed-segments"}
    span, (start, end) = covered[0][0], hits[0]
    result.update(segmentIndex=span["segmentIndex"], relation=span["relation"], attribution=span["attribution"],
                  anchor={"messageId": own["id"], "start": start, "end": end})
    for key in ("quotedHeader", "claimedAuthor", "claimedDate", "enclosingQuotedHeader"):
        if span.get(key):
            result[key] = span[key]
    if span["relation"] == "authored":
        result.update(state="container" if span["attribution"] == "container-header" else "unresolved",
                      author=span["author"], date=span["date"])
    else:
        result.update(state=span["relation"], author=None, date=None)

    earlier, later, quoting = [], [], []
    for message in messages:
        if message["id"] == own["id"]:
            continue
        for s, e in _occurrences(message["view"], needle):
            relations = {span["relation"] for span in _covering(message["spans"], s, e)}
            if message["internalDate"] > own["internalDate"]:
                later.append(message["id"])
            elif relations == {"authored"} and message["internalDate"] < own["internalDate"]:
                earlier.append((message, s, e))
            if relations - {"authored"}:
                quoting.append(message["id"])
    later, quoting = sorted(set(later)), sorted(set(quoting))
    originals = {m["id"]: (m, s, e) for m, s, e in earlier}
    if later:
        result["laterMessageIds"] = later
    if quoting:
        result["otherQuotingMessageIds"] = quoting
    if originals:
        result["earlierAuthoredMessageIds"] = sorted(originals)
    if result["state"] in ("quoted", "unresolved"):
        claimed = _email(result.get("claimedAuthor"))
        if len(originals) == 1:
            message, s, e = next(iter(originals.values()))
            actual = _email(message["headers"].get("from"))
            if claimed and actual and claimed != actual:
                result["reason"] = "quoted-claim-contradicts-original-sender"
            elif message["headers"].get("from"):
                result.update(state="matched-original", attribution="matched-original-message",
                              author=message["headers"].get("from"), date=message["headers"].get("date"),
                              originalMessageId=message["id"], originalInternalDate=message["internalDate"],
                              anchor={"messageId": message["id"], "start": s, "end": e})
        elif len(originals) > 1:
            result["reason"] = "several-earlier-originals"
        if result["state"] != "matched-original":
            result["quoteKey"] = _digest(_flatten(result.get("quotedHeader") or "").casefold(), needle)
    return result


def attribute_review(page, value, messages, sections=("actions", "memories", "deliverables")):
    """A copy of the review whose findings carry recomputed attribution.

    A caller-supplied attribution is discarded: only the archived evidence decides.
    """
    value = dict(value)
    for section in sections:
        items = value.get(section)
        if not isinstance(items, list):
            continue
        value[section] = [{**{k: v for k, v in item.items() if k != "attribution"},
                           "attribution": attribute(page, item.get("excerpt"), messages)}
                          if isinstance(item, dict) else item for item in items]
    return value


def needs_reconciliation(attribution):
    """True when a finding must not become a new action from this reading."""
    return bool(attribution.get("laterMessageIds") or attribution.get("earlierAuthoredMessageIds")) \
        or attribution.get("state") not in ("container", "attachment", "unlocated")


def _overlap(first, second):
    return bool(first and second) and first["messageId"] == second["messageId"] \
        and first["start"] < second["end"] and second["start"] < first["end"]


def reconcile_proposals(existing, new, at):
    """Mark readings of an already proposed passage instead of sending them again.

    Same thread, another page, same kind family, and either an overlapping
    anchor in one message or the same quoted header and excerpt. Earlier
    proposals and their receipts are never changed.
    """
    for proposal in new:
        mine = proposal.get("attribution") or {}
        if not mine.get("anchor") and not mine.get("quoteKey"):
            continue
        family = proposal["kind"] == "memory"
        for other in existing:
            theirs = other.get("attribution") or {}
            if other.get("threadId") != proposal["threadId"] or other.get("pageId") == proposal["pageId"] \
                    or (other.get("kind") == "memory") != family:
                continue
            if _overlap(mine.get("anchor"), theirs.get("anchor")) \
                    or mine.get("quoteKey") and mine["quoteKey"] == theirs.get("quoteKey"):
                proposal.update(state="reconciled", reconciledWith=other["key"], reconciledAt=at)
                break
    return new
