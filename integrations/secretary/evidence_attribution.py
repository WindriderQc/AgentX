"""Describe quoted boundaries without rewriting evidence or guessing its author.

Headers identify the containing message only. Quoted headers are untrusted text,
not verified identities or dates. Offsets always refer to the original body.
"""
from __future__ import annotations

import re


POLICY = (
    "Container headers describe the enclosing message, never all text on this page. "
    "Quoted/forwarded text retains its own author and original date; a recent reply "
    "does not renew it. Unknown attribution stays unknown. Check later replies and "
    "existing findings before proposing an action. These boundaries are conservative "
    "reading aids, not verified actors, current obligations or deadlines."
)

# Gmail wraps even 'a écrit :' onto several lines. Inspect a bounded header, not
# arbitrary body text containing 'wrote'. Prefixes belong to nested quotations.
GMAIL = re.compile(
    r"(?im)^[ \t>]*(?:Le|On)\s+[^\n]{1,300}"
    r"(?:\n[ \t>]*[^\n]{0,300}){0,4}?"
    r"(?:a\s+écrit|wrote)\s*:\s*(?:\r?\n|$)"
)
FORWARDED = re.compile(
    r"(?im)^[ \t>]*(?:-{2,}\s*(?:Original Message|Forwarded message|Message d.origine|"
    r"Message transféré)[^\n]*|(?:From|De)\s*:[^\n]+)\r?$"
)
QUOTED = re.compile(r"(?m)^[ \t]*>[^\n]*(?:\n|$)")
PARTIAL_REPLY = re.compile(
    r"(?im)^[ \t>]*(?:Le|On)\s+(?:[a-zÀ-ÿ.]+[ ,]+)?"
    r"(?:\d{1,2}\s+[a-zÀ-ÿ.]+|[a-zÀ-ÿ.]+\s+\d{1,2})[^\n]{0,250}\b\d{4}\b[^\n]*$"
)


def body_segments(text, headers):
    """Continuous, lossless spans. Never recover a quoted author from the container.

    After an unprefixed quotation separator the remainder is conservatively
    quoted. Inline replies cannot safely be reassigned without original evidence.
    """
    boundaries = {}
    gmail_headers = list(GMAIL.finditer(text))
    for match in gmail_headers:
        boundaries[match.start()] = {
            "relation": "quoted", "attribution": "unverified-quoted-header",
            "quotedHeader": match.group(0).strip(), "author": None, "date": None,
        }
    for match in FORWARDED.finditer(text):
        # Gmail's header already encompasses this line where nested formats mix.
        if not any(m.start() <= match.start() < m.end() for m in gmail_headers):
            boundaries.setdefault(match.start(), {
                "relation": "quoted", "attribution": "unverified-quoted-header",
                "quotedHeader": match.group(0).strip(), "author": None, "date": None,
            })
    for match in PARTIAL_REPLY.finditer(text):
        if not any(m.start() <= match.start() < m.end() for m in gmail_headers):
            boundaries.setdefault(match.start(), {
                "relation": "quoted", "attribution": "unknown",
                "quotedHeader": match.group(0).strip(), "author": None, "date": None,
            })
    first_quote = QUOTED.search(text)
    if first_quote and (not boundaries or first_quote.start() < min(boundaries)):
        boundaries[first_quote.start()] = {
            "relation": "quoted", "attribution": "unknown", "author": None, "date": None,
        }
    current = {"relation": "authored", "attribution": "container-header" if headers.get("from") else "unknown",
               "author": headers.get("from"), "date": headers.get("date")}
    start, spans = 0, []
    for boundary, context in sorted(boundaries.items()):
        if boundary > start:
            spans.append({"start": start, "end": boundary, **current})
        start, current = boundary, context
    spans.append({"start": start, "end": len(text), **current})
    return spans


def page_context(spans, offset, length, *, kind, newer_messages):
    end = offset + length
    if kind != "body":
        spans = [{"start": offset, "end": end, "relation": "attachment",
                  "attribution": "unknown", "author": None, "date": None}]
    intersecting = [{**span, "start": max(offset, span["start"]), "end": min(end, span["end"])}
                    for span in spans if span["start"] < end and span["end"] > offset]
    return {"schema": "secretary.source-context/v1", "offsetUnit": "unicode-code-point",
            "containerHasNewerMessages": newer_messages > 0, "newerMessageCount": newer_messages,
            "segments": intersecting, "policy": POLICY}


def review_pages(archive, manifest, *, load, message_text, sha, json, page_chars):
    """Stable raw pages plus attribution computed before pagination.

    Metadata is deliberately outside the page identity. Installing this reader
    neither invalidates reading receipts nor changes a byte of source content.
    """
    payload = load(archive.root / "threads" / manifest["threadId"] / "original.json")
    originals = {m["id"]: m for m in payload.get("thread", payload)["messages"]}
    messages = sorted(manifest["messages"], key=lambda m: int(m.get("internalDate") or 0), reverse=True)
    for message in messages:
        h = {k.lower(): v for k, v in message["headers"].items()
             if k.lower() in ("from", "to", "cc", "bcc", "date", "subject")}
        body = message_text(originals[message["id"]])
        spans = body_segments(body, h)
        newer = sum(int(m.get("internalDate") or 0) > int(message.get("internalDate") or 0) for m in messages)
        units = [("body", body, None)]
        for attachment in message["attachments"]:
            text = (archive.root / attachment["textPath"]).read_text(encoding="utf-8", errors="replace") if attachment.get("textPath") else ""
            units.append(("attachment", json.dumps(attachment, ensure_ascii=False) + "\n" + text, attachment))
        for kind, text, attachment in units:
            for offset in range(0, max(1, len(text)), page_chars):
                content = text[offset:offset + page_chars]
                key = sha(json.dumps([manifest["threadId"], message["id"], kind,
                                      attachment.get("sha256") if attachment else None, offset, content]).encode())
                yield {"pageId": key, "threadId": manifest["threadId"], "messageId": message["id"],
                       "evidenceHash": manifest["evidenceHash"], "gmailUrl": manifest["gmailUrl"],
                       "headers": h, "kind": kind, "offset": offset, "totalChars": len(text),
                       "moreOfThisSource": offset + page_chars < len(text), "attachment": attachment,
                       "externalUntrustedContent": content,
                       "sourceContext": page_context(spans, offset, len(content), kind=kind, newer_messages=newer)}
