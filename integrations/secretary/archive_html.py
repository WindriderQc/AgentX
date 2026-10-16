"""Bounded inert HTML evidence that a visible-text conversion would omit."""
from __future__ import annotations

import hashlib
from html.parser import HTMLParser

MAX_ITEMS = 100
MAX_VALUE = 1000
REFERENCES = {"href", "src", "srcset", "action", "data", "poster", "background"}
DESCRIPTIONS = {"alt", "title", "aria-label", "value", "placeholder"}


class Supplement(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.items, self.omitted, self.clipped = [], 0, False
        self.script, self.script_text = None, []

    def add(self, kind, tag, attribute, value):
        if not value:
            return
        if len(self.items) >= MAX_ITEMS:
            self.omitted += 1
            return
        truncated = len(value) > MAX_VALUE
        self.clipped |= truncated
        self.items.append({"kind": kind, "tag": tag, "attribute": attribute,
                           "value": value[:MAX_VALUE], "totalChars": len(value),
                           "sha256": hashlib.sha256(value.encode()).hexdigest(), "truncated": truncated})

    def handle_starttag(self, tag, attrs):
        for name, value in attrs:
            if name in REFERENCES:
                self.add("reference", tag, name, value)
            elif name in DESCRIPTIONS:
                self.add("description", tag, name, value)
        if tag == "script":
            self.script = dict(attrs).get("type", "unspecified")
            self.script_text = []

    def handle_data(self, data):
        if self.script is not None:
            self.script_text.append(data)

    def handle_endtag(self, tag):
        if tag == "script" and self.script is not None:
            self.add("script_data_requires_review", "script", self.script, "".join(self.script_text))
            self.script, self.script_text = None, []

    def result(self):
        # A malformed unclosed script still contains source data to inspect.
        if self.script is not None:
            # HTMLParser retains unclosed CDATA in rawdata rather than
            # delivering it to handle_data, even after close().
            if self.rawdata:
                self.script_text.append(self.rawdata)
                self.rawdata = ""
            self.handle_endtag("script")
        return {"schema": "secretary.html-supplement/v1", "items": self.items,
                "omittedItems": self.omitted, "truncated": self.clipped or bool(self.omitted),
                "contentFetched": False, "scriptsExecuted": False,
                "scope": "Printed HTML attributes and script data; linked resources are not collected or analysed"}


def supplement(html):
    parser = Supplement()
    parser.feed(html)
    parser.close()
    return parser.result()
