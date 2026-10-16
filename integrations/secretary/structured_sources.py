#!/usr/bin/env python3
"""Read preserved calendar/contact properties without creating life events.

This bounded structural reader retains original properties, parameters and
component hierarchy. It does not expand recurrence, resolve local time zones,
infer attendance, merge people, contact servers or write Core/provider data.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re

from evidence_store import load, now, save
from secretary_evidence import Archive, DEFAULT_ROOT

CONTRACT = "agentx.secretary-structured-source/v1"
MAX_BYTES = 1024 * 1024
MAX_LINES = 20000
MAX_PROPERTY_BYTES = 65536
DATE_FIELDS = {"DTSTART", "DTEND", "DTSTAMP", "CREATED", "LAST-MODIFIED", "RECURRENCE-ID", "DUE", "COMPLETED", "REV", "BDAY", "ANNIVERSARY"}
TEXT_FIELDS = {"SUMMARY", "DESCRIPTION", "LOCATION", "COMMENT", "FN", "N", "NICKNAME", "ORG", "TITLE", "ROLE", "NOTE", "ADR", "CATEGORIES"}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def split_quoted(value, separator, limit=None):
    result, start, quoted = [], 0, False
    for index, char in enumerate(value):
        if char == '"':
            quoted = not quoted
        if char == separator and not quoted:
            result.append(value[start:index]); start = index + 1
            if limit and len(result) == limit:
                return result + [value[start:]]
    if quoted:
        raise ValueError("unclosed_parameter_quote")
    result.append(value[start:])
    return result


def text_value(value):
    return re.sub(r"\\([nN,;\\])", lambda match: "\n" if match[1].lower() == "n" else match[1], value)


def date_value(value, parameters):
    result = {"asWritten": value, "kind": "unparsed", "timezoneAsWritten": parameters.get("TZID", [])}
    declared = [item.strip('"').upper() for item in parameters.get("VALUE", [])]
    if "TEXT" in declared:
        result["kind"] = "text"
        return result
    # A local/floating time stays local; custom VTIMEZONE definitions, DST folds
    # and date-only contact birthdays must not acquire an invented UTC instant.
    patterns = ((r"\d{8}", "%Y%m%d", "day"), (r"\d{4}-\d{2}-\d{2}", "%Y-%m-%d", "day"),
                (r"\d{8}T\d{6}Z", "%Y%m%dT%H%M%SZ", "instant"),
                (r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", "%Y-%m-%dT%H:%M:%SZ", "instant"),
                (r"\d{8}T\d{6}", "%Y%m%dT%H%M%S", "local"))
    for pattern, fmt, kind in patterns:
        if not re.fullmatch(pattern, value):
            continue
        try:
            parsed = datetime.strptime(value, fmt)
        except ValueError:
            return result
        if declared and ("DATE" in declared and kind != "day" or "DATE-TIME" in declared and kind == "day"):
            result["conflict"] = "declared_date_type_mismatch"
            return result
        result.update(kind=kind)
        if kind == "day":
            result["value"] = parsed.date().isoformat()
        elif kind == "instant" and not parameters.get("TZID"):
            result["value"] = parsed.isoformat() + "Z"
        elif kind == "instant":
            result.update(kind="unparsed", conflict="utc_value_with_tzid")
        else:
            result["localValue"] = parsed.isoformat()
        return result
    return result


def property_line(line, ordinal):
    fragments = split_quoted(line, ":", limit=1)
    if len(fragments) < 2:
        raise ValueError("property_without_value_separator")
    head, raw = fragments[0], ":".join(fragments[1:])
    fields = split_quoted(head, ";")
    name = fields[0].upper()
    if not re.fullmatch(r"[A-Z0-9-]+(?:\.[A-Z0-9-]+)?", name):
        raise ValueError("invalid_property_name")
    group, name = name.rsplit(".", 1) if "." in name else ("", name)
    parameters = {}
    for field in fields[1:]:
        key, separator, value = field.partition("=")
        parameters.setdefault(key.upper() if separator else "LEGACY-TYPE", []).append(value if separator else key)
    row = {"ordinal": ordinal, "name": name, "group": group, "parameters": parameters, "rawValue": raw}
    # Legacy encodings stay explicitly opaque instead of silently mojibaking a
    # quoted-printable name or treating encoded binary photos as ordinary text.
    if "ENCODING" in parameters or "CHARSET" in parameters:
        row["interpretation"] = "legacy_encoding_requires_review"
    elif name in DATE_FIELDS:
        row["date"] = date_value(raw, parameters)
    elif name in TEXT_FIELDS:
        row["text"] = text_value(raw)
    return row


def parse(data):
    result = {"schema": CONTRACT, "sourceSha256": digest(data), "bytes": len(data),
              "structureStatus": "needs_review", "analysisComplete": False, "components": [], "issues": [],
              "interpretation": "source assertions only; no attendance, identity merge or recurrence expansion"}
    if len(data) > MAX_BYTES:
        result["issues"].append({"code": "source_exceeds_bounded_reader"}); return result
    # RFC content-line unfolding precedes UTF-8 decoding, including folds that
    # split a multibyte sequence. Preserve physical line numbers for provenance.
    lines = []
    for ordinal, line in enumerate(data.replace(b"\r\n", b"\n").split(b"\n"), 1):
        if line.startswith((b" ", b"\t")) and lines:
            lines[-1][1] += line[1:]
        elif line:
            lines.append([ordinal, line])
    if len(lines) > MAX_LINES or any(len(line) > MAX_PROPERTY_BYTES for _, line in lines):
        result["issues"].append({"code": "content_line_limit"}); return result
    try:
        lines = [(ordinal, line.decode("utf-8-sig")) for ordinal, line in lines]
    except UnicodeDecodeError:
        result["issues"].append({"code": "source_encoding_not_utf8"}); return result
    stack = []
    for ordinal, line in lines:
        try:
            prop = property_line(line, ordinal)
        except ValueError as error:
            result["issues"].append({"line": ordinal, "code": str(error)}); continue
        if prop["name"] == "BEGIN":
            if len(stack) >= 32:
                result["issues"].append({"line": ordinal, "code": "component_depth_limit"}); return result
            component = {"type": prop["rawValue"].upper(), "line": ordinal, "properties": [], "children": []}
            (stack[-1]["children"] if stack else result["components"]).append(component)
            stack.append(component)
        elif prop["name"] == "END":
            if not stack or stack[-1]["type"] != prop["rawValue"].upper():
                result["issues"].append({"line": ordinal, "code": "component_end_mismatch"})
            else:
                stack.pop()
        elif not stack:
            result["issues"].append({"line": ordinal, "code": "property_outside_component"})
        else:
            stack[-1]["properties"].append(prop)
            if prop.get("interpretation"):
                result["issues"].append({"line": ordinal, "code": prop["interpretation"]})
    if stack:
        result["issues"].append({"code": "unclosed_component"})
    if not result["components"]:
        result["issues"].append({"code": "no_components"})
    result["structureStatus"] = "parsed" if not result["issues"] else "needs_review"
    return result


def objects(parsed):
    """Derive bounded candidates while keeping the complete property tree."""
    def walk(component, parent=None):
        props = component["properties"]
        values = lambda name: [p for p in props if p["name"] == name]
        if component["type"] in ("VEVENT", "VTODO", "VJOURNAL", "VCARD"):
            kind = "contact" if component["type"] == "VCARD" else "calendar"
            yield {"kind": kind, "componentType": component["type"], "line": component["line"],
                "uidAsWritten": [p["rawValue"] for p in values("UID")],
                "sourceDateCandidates": [p for p in props if p["name"] in ("DTSTAMP", "CREATED", "REV")],
                "eventDates": [p for p in props if p["name"] in ("DTSTART", "DTEND", "DUE", "COMPLETED", "BDAY", "ANNIVERSARY")],
                "assertionState": "unknown", "participation": "unknown", "identityResolution": "unreviewed",
                "calendarMethodAsWritten": [p["rawValue"] for p in (parent or {}).get("properties", []) if p["name"] == "METHOD"],
                "properties": props, "nestedComponents": component["children"],
                "needsReconciliation": any(values(name) for name in ("RRULE", "RDATE", "EXDATE", "RECURRENCE-ID", "SEQUENCE", "STATUS"))}
        for child in component["children"]:
            yield from walk(child, component)
    return [item for component in parsed["components"] for item in walk(component)]


def preserved_sources(root, outlook_export=None):
    """Use only recorded Gmail attachments and one explicitly selected export."""
    sources = {}
    archive = Archive(root, run=lambda _: (_ for _ in ()).throw(RuntimeError("Provider access disabled")))
    for manifest in archive.manifests():
        for message in manifest["messages"]:
            for attachment in message.get("attachments", []):
                suffix = Path(attachment.get("filename") or attachment.get("path") or "").suffix.lower()
                if suffix not in (".ics", ".vcf") and attachment.get("mimeType") not in ("text/calendar", "text/vcard", "text/x-vcard"):
                    continue
                source = {"system": "gmail", "messageId": message["id"], "threadId": manifest["threadId"],
                          "internalDate": message.get("internalDate"), "attachment": attachment}
                sources.setdefault(attachment.get("path", ""), {"receipt": attachment, "occurrences": []})["occurrences"].append(source)
    if outlook_export:
        exports = load(root / "outlook/exports.json", {})
        if outlook_export not in exports:
            raise ValueError("Select an existing recorded Outlook export")
        for item in load(root / "outlook/inventory.json", {"items": {}})["items"].values():
            if item.get("kind") not in ("calendar", "contact") or outlook_export not in item.get("exports", []):
                continue
            sources.setdefault(item.get("path", ""), {"receipt": item, "occurrences": []})["occurrences"].append({
                "system": "outlook-export", "exportSha256": outlook_export, "path": item.get("path"),
                "sourceTimestamp": None, "representation": "readpst-conversion; original PST retained"})
    return sources


def prepare(root, outlook_export=None, maximum=1000):
    root = Path(root).resolve()
    sources = preserved_sources(root, outlook_export)
    rows, counts = [], Counter()
    for relative, source in sorted(sources.items())[:maximum]:
        receipt = source["receipt"]
        file = (root / relative).resolve()
        row = {"path": relative, "sourceSha256": receipt.get("sha256"), "occurrences": source["occurrences"]}
        if not relative or not file.is_relative_to(root) or not file.is_file():
            row.update(structureStatus="unavailable", issues=[{"code": "source_missing_or_unsafe"}], objects=[])
        elif file.stat().st_size > MAX_BYTES:
            row.update(structureStatus="needs_review", issues=[{"code": "source_exceeds_bounded_reader"}], objects=[])
        else:
            data = file.read_bytes()
            if digest(data) != receipt.get("sha256") or len(data) != receipt.get("bytes"):
                row.update(structureStatus="unavailable", issues=[{"code": "preservation_receipt_mismatch"}], objects=[])
            else:
                parsed = parse(data)
                row.update(structure=parsed, structureStatus=parsed["structureStatus"], issues=parsed["issues"], objects=objects(parsed))
        for item in row["objects"]:
            item["sourceAssertionId"] = digest(f"{CONTRACT}\n{receipt['sha256']}\n{item['componentType']}\n{item['line']}".encode())
            counts[item["kind"]] += 1
        counts[row["structureStatus"]] += 1
        rows.append(row)
    return {"schema": "agentx.secretary-structured-review/v1", "at": now(), "outlookExport": outlook_export,
            "analysisComplete": False, "providerEffects": 0, "coreEffects": 0,
            "counts": {**counts, "sources": len(sources), "selected": len(rows), "remaining": max(0, len(sources) - len(rows))},
            "sources": rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--outlook-export", help="SHA-256 of the one existing Outlook export to include")
    parser.add_argument("--maximum", type=int, default=1000)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists() or args.output.resolve().is_relative_to(args.root.resolve()):
        parser.error("Use a new private output outside the evidence archive")
    if not 1 <= args.maximum <= 5000:
        parser.error("maximum must be 1-5000")
    result = prepare(args.root, args.outlook_export, args.maximum)
    save(args.output, result)
    print(json.dumps({key: value for key, value in result.items() if key != "sources"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
