"""Traceable equivalent text units reuse a read; copies never corroborate facts."""
from __future__ import annotations

import hashlib
import re

from evidence_store import load, now
from review_attempts import durable, hashed


def normalized(text):
    return " ".join(text.split())


def key(source, unit):
    # The date/author/RFC context prevents a generic repeated 'OK' or boilerplate
    # from borrowing another message's interpretation. No RFC means same source.
    headers = source["headers"]
    context = {name: normalized(headers.get(name, "")) for name in ("from", "to", "cc", "subject")}
    context.update(date=source.get("mailDate") or headers.get("date"),
                   rfc=source.get("rfc822MessageId") or [source["system"], source["id"]],
                   draft=source.get("direction") == "draft")
    attachment = unit.get("attachment") or {}
    return hashed({"text": normalized(unit["content"]), "context": context,
                   "representation": unit["representation"],
                   "attachment": {k: attachment.get(k) for k in ("sha256", "status", "mimeType")}})


def unit_ref(unit):
    return {k: v for k, v in unit.items() if k != "content"}


def find(objective, source, unit, validate_receipt, manifest):
    file = objective / "equivalence-index" / (key(source, unit) + ".json")
    record = load(file, {})
    if not record:
        return None
    if record.get("equivalenceKey") != key(source, unit) or record.get("objectiveSha256") != manifest["objectiveSha256"]:
        raise ValueError("Equivalent-unit index identity changed")
    receipts = [validate_receipt(objective / "page-reviews" / (pid + ".json"), manifest) for pid in record["canonicalPageIds"]]
    return {**record, "receipts": receipts}


def register(objective, source, unit, unit_pages, validate_receipt, manifest):
    if not unit_pages:
        return
    for page in unit_pages:
        file = objective / "page-reviews" / (page["pageId"] + ".json")
        if not file.is_file():
            return  # A one-page pilot never certifies an unfinished unit.
        validate_receipt(file, manifest)
    identity = key(source, unit)
    file = objective / "equivalence-index" / (identity + ".json")
    if not file.exists():
        durable(file, {"schema": "secretary.objective-equivalent-unit/v1", "at": now(),
            "objectiveSha256": manifest["objectiveSha256"], "equivalenceKey": identity,
            "canonicalPageIds": [p["pageId"] for p in unit_pages],
            "canonicalSource": {k: source.get(k) for k in ("system", "id", "sha256", "rfc822MessageId")},
            "normalizedTextSha256": hashlib.sha256(normalized(unit["content"]).encode()).hexdigest()}, exclusive=True)


def exact_alias_quote(quote, content):
    if quote in content:
        return quote
    pattern = r"\s+".join(re.escape(token) for token in quote.split())
    match = re.search(pattern, content) if pattern else None
    if not match:
        raise ValueError("A canonical quote is absent from the equivalent source")
    return match.group(0)


def alias(objective, source, unit, unit_pages, canonical, source_record):
    identity = hashed([source["system"], source["id"], source["sha256"], unit_ref(unit)])
    # Exact complete alias text is a CPU-verified equivalence scope, not a model
    # read of that file. Preserve that distinction in provenance and coverage.
    record = source_record({"pageId": identity, "source": source, "content": unit["content"],
        "representation": unit_ref(unit), "offset": 0, "end": len(unit["content"]), "totalChars": len(unit["content"])})
    record["bodyScope"] = "verified-equivalent-unit-not-read-by-model"
    record["nativeRef"]["equivalentCanonicalPageIds"] = canonical["canonicalPageIds"]
    mapped = []
    for receipt in canonical["receipts"]:
        for index, moment in enumerate(receipt["result"]["moments"]):
            mapped.append({"canonicalPageId": receipt["pageId"], "canonicalMomentIndex": index,
                "quotes": [exact_alias_quote(q, unit["content"]) for q in moment["quotes"]]})
    durable(objective / "equivalences" / (identity + ".json"), {
        "schema": "secretary.objective-equivalence-receipt/v1", "at": now(),
        "sourceRecord": record, "sourceSha256": source["sha256"], "sourceId": source["id"], "system": source["system"],
        "objectiveSha256": canonical["objectiveSha256"], "equivalenceKey": canonical["equivalenceKey"],
        "normalizedTextSha256": canonical["normalizedTextSha256"],
        "canonicalPageIds": canonical["canonicalPageIds"], "coveredPageIds": [p["pageId"] for p in unit_pages],
        "mappedClaims": mapped, "modelRead": False, "sourceIndependence": "same-declaration"})


def receipts(objective, manifest):
    for file in sorted((objective / "equivalences").glob("*.json")):
        value = load(file, {})
        record = value.get("sourceRecord", {})
        body = record.get("body", "")
        index = load(objective / "equivalence-index" / (str(value.get("equivalenceKey")) + ".json"), {})
        if value.get("schema") != "secretary.objective-equivalence-receipt/v1" \
                or value.get("objectiveSha256") != manifest["objectiveSha256"] \
                or index.get("objectiveSha256") != manifest["objectiveSha256"] \
                or index.get("canonicalPageIds") != value.get("canonicalPageIds") \
                or index.get("normalizedTextSha256") != value.get("normalizedTextSha256") \
                or record.get("bodySha256") != hashlib.sha256(body.encode()).hexdigest() \
                or value.get("normalizedTextSha256") != hashlib.sha256(normalized(body).encode()).hexdigest() \
                or any(q not in body for claim in value.get("mappedClaims", []) for q in claim.get("quotes", [])):
            raise ValueError("Equivalent-source receipt failed integrity validation")
        yield value


def coverage_index(aliases):
    result = {}
    for value in aliases:
        identity = (value["system"], value["sourceId"], value["sourceSha256"])
        result.setdefault(identity, set()).update(value["coveredPageIds"])
    return result
