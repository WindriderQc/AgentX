"""Consumer adapters for the existing conservative mail attribution engine.

Offsets always refer to the unchanged full text representation. These reading
signals establish neither the addressee's commitment nor a request's currency.
"""
from datetime import datetime
import hashlib

from quote_attribution import attribute, normalized, page_context, segments

DOSSIER_CONTRACT = "secretary.dossier-sources/v2"
OBJECTIVE_CONTRACT = "secretary.objective-attribution/v1"
POLICY = (
    "Quoted requests are historical source assertions, not current requests or"
    " obligations of the containing sender. Attribution does not identify the"
    " addressee or establish resolution. Reconcile later replies and repeated"
    " anchors; ambiguous attribution remains unresolved."
)


def message(mid, body, headers, timestamp=0, *, view_limit=None, **provenance):
    return {"id": mid, "body": body, "headers": headers, "internalDate": timestamp,
            "spans": segments(body, headers), "view": normalized(body[:view_limit]), **provenance}


def milliseconds(value):
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
    except (AttributeError, ValueError, OverflowError):
        return 0


def context(own, offset, length, messages, *, kind="body"):
    newer = [m["id"] for m in messages if m.get("direction") != "draft" and m["internalDate"] > own["internalDate"]]
    return {**page_context(own["spans"], offset, length, kind=kind,
                          newer_messages=len(newer), text=own["body"]),
            "laterMessageIds": sorted(newer), "reconciliationPolicy": POLICY}


def citation(own, excerpt, offset, length, messages, *, kind="body"):
    page = {"messageId": own["id"], "kind": kind, "offset": offset,
            "externalUntrustedContent": own["body"][offset:offset + length]}
    result = attribute(page, excerpt, [m for m in messages if m["id"] == own["id"] or m.get("direction") != "draft"])
    # Only literal occurrences inside this consumer's retained range qualify.
    positions, start = [], offset
    while excerpt and start < offset + length:
        start = own["body"].find(excerpt, start, offset + length)
        if start < 0:
            break
        positions.append({"start": start, "end": start + len(excerpt)})
        start += 1
    result["sourceSpans"] = positions
    if not positions and kind == "body":
        result.update(state="unlocated", reason="excerpt-not-in-retained-range", author=None, date=None)
        result.pop("anchor", None)
    # All later replies matter, even when their answer does not repeat a quote.
    later = sorted(m["id"] for m in messages if m.get("direction") != "draft" and m["internalDate"] > own["internalDate"])
    if later:
        result["laterMessageIds"] = later
    result["requiresReconciliation"] = bool(later or result.get("earlierAuthoredMessageIds")) \
        or result["state"] != "container"
    anchor = result.get("anchor")
    if result.get("quoteKey"):
        result["assertionKey"] = result["quoteKey"]
    elif anchor:
        # Repeated MIME representations and quote occurrences are one assertion,
        # never independent testimony. No proposed fact/task is merged here.
        origin = next(m for m in messages if m["id"] == anchor["messageId"])
        result["assertionKey"] = hashlib.sha256((origin["id"] + "\0" + normalized(excerpt)[0]).encode()).hexdigest()
    return result
