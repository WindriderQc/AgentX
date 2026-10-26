"""Defer exact copies of wholly rejected units without borrowing a model read.

These immutable reports transfer no result, fact or coverage. A canonical unit
must be complete and every page must have certain, intact rejection evidence.
Mixed/unfinished units remain on the ordinary native review/recovery path.
"""
from __future__ import annotations

import hashlib
from pathlib import Path
import re

from evidence_store import load, now
import objective_dispositions as rejected
import objective_equivalence as equivalent
from objective_sources import pages
from review_receipts import durable, hashed

CONTRACT = "secretary.objective-rejected-copy-report/v1"
INDEX = "secretary.objective-rejected-unit/v1"
DIGEST = re.compile(r"[a-f0-9]{64}")


class RejectedCopyIntegrityError(ValueError):
    """Never absorb an altered report or canonical proof as a source error."""


def _sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def _file_sha(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def _scope(unit):
    # MIME part numbers may differ between physical copies; every other scope
    # descriptor, including attachment/extraction/decoding identity, stays exact.
    return {k: v for k, v in unit.items() if k not in ("content", "partIndex")}


def _key(source, unit, manifest):
    if not isinstance(source, dict) or not isinstance(unit, dict) \
            or not isinstance(source.get("headers"), dict) or not isinstance(unit.get("content"), str):
        raise ValueError("Rejected-copy source or unit is malformed")
    rfc = source.get("rfc822MessageId")
    if not isinstance(rfc, str) or not rfc.strip() or not unit["content"]:
        return None
    if unit.get("textSha256") != _sha(unit["content"]):
        raise ValueError("Rejected-copy full text digest differs")
    return hashed([manifest["objectiveSha256"], equivalent.key(source, unit), _scope(unit)])


def _source(source, manifest):
    if not isinstance(source, dict) or not any(all(row.get(k) == source.get(k) for k in ("system", "id", "sha256", "path", "bytes", "threadId"))
               for row in manifest["sources"]):
        raise ValueError("Rejected-copy source is outside the frozen objective")


def _plan(source, unit, manifest):
    return list(pages(source, [unit], manifest["objectiveSha256"],
                      manifest["config"]["pageChars"], manifest["config"]["overlap"]))


def _index_file(objective, key):
    if not isinstance(key, str) or not DIGEST.fullmatch(key):
        raise ValueError("Invalid rejected-copy index identity")
    return Path(objective) / "rejected-copy-index" / (key + ".json")


def _canonical(objective, manifest, key):
    file = _index_file(objective, key)
    if not file.exists():
        return None
    index = load(file, {})
    if not isinstance(index, dict) or not index:
        raise ValueError("Rejected-copy canonical index is empty or malformed")
    source, ref = index.get("source", {}), index.get("unit", {})
    _source(source, manifest)
    if index.get("schema") != INDEX or index.get("objectiveSha256") != manifest["objectiveSha256"] \
            or index.get("key") != key or not index.get("pageIds") \
            or len(index["pageIds"]) != len(set(index["pageIds"])):
        raise ValueError("Rejected-copy canonical index identity differs")
    rows, content = [], ""
    for pid in index["pageIds"]:
        if not isinstance(pid, str) or not DIGEST.fullmatch(pid):
            raise ValueError("Rejected-copy canonical page identity differs")
        row = rejected.read(objective, manifest, pid)
        if not row or row["source"] != source or row["representation"] != ref \
                or row["offset"] > len(content) or row["end"] <= len(content) \
                or row["body"][:len(content) - row["offset"]] != content[row["offset"]:] \
                or _file_sha(Path(objective) / "page-dispositions" / (pid + ".json")) != index.get("rejectionSha256", {}).get(pid):
            raise ValueError("Rejected-copy canonical rejection or range differs")
        content += row["body"][len(content) - row["offset"]:]
        rows.append(row)
    unit = {**ref, "content": content}
    plan = _plan(source, unit, manifest)
    if _key(source, unit, manifest) != key or [page["pageId"] for page in plan] != index["pageIds"] \
            or any(row["identity"] != page["identity"] or row["totalChars"] != len(content)
                   for row, page in zip(rows, plan)):
        raise ValueError("Rejected-copy canonical unit is partial or changed")
    return {"index": index, "fileSha256": _file_sha(file), "unit": unit, "pages": plan, "rejections": rows}


def register(objective, manifest, source, unit, unit_pages):
    """Index only an exact complete unit whose every page is already rejected."""
    try:
        key = _key(source, unit, manifest)
        if key is None:
            return
        _source(source, manifest)
        plan = _plan(source, unit, manifest)
        if not plan or unit_pages != plan:
            raise ValueError("Rejected-copy registration needs the full exact unit plan")
        rows = [rejected.read(objective, manifest, page["pageId"], expected_identity=page["identity"])
                for page in plan]
        if not all(rows):
            return
        if _canonical(objective, manifest, key):
            return
        row = {"schema": INDEX, "at": now(), "objectiveSha256": manifest["objectiveSha256"],
               "key": key, "source": source, "unit": equivalent.unit_ref(unit),
               "pageIds": [page["pageId"] for page in plan],
               "rejectionSha256": {page["pageId"]: _file_sha(Path(objective) / "page-dispositions" / (page["pageId"] + ".json"))
                                    for page in plan}}
        durable(_index_file(objective, key), row, exclusive=True)
        _canonical(objective, manifest, key)
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise RejectedCopyIntegrityError(str(error)) from error


def _own_attempt(objective, page_id):
    # Even an unsettled/invalid cache or a refused native attempt retains its
    # own recovery path. A copy report can never step around that identity.
    # Check the original fence, not only selection()'s current child directory:
    # an authorized linked retry may exist before its child has been created.
    return (Path(objective) / "review-attempts" / hashed(page_id)).exists()


def _conflict(objective, page_id):
    return _own_attempt(objective, page_id) or any(
        (Path(objective) / directory / (page_id + ".json")).exists()
        for directory in ("page-reviews", "page-dispositions"))


def matches(objective, manifest, source, unit, unit_pages):
    """A known rejected unit takes precedence over creating a new accepted alias."""
    try:
        key = _key(source, unit, manifest)
        canonical = _canonical(objective, manifest, key) if key else None
        if not canonical:
            return False
        if unit_pages != _plan(source, unit, manifest):
            raise ValueError("Rejected-copy match needs the complete current unit plan")
        return len(unit_pages) == len(canonical["pages"]) and all(
            all(page[k] == original[k] for k in ("content", "offset", "end", "totalChars", "sourceContext"))
            for page, original in zip(unit_pages, canonical["pages"]))
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise RejectedCopyIntegrityError(str(error)) from error


def read(objective, manifest, page_id, *, expected_identity=None):
    try:
        if not isinstance(page_id, str) or not DIGEST.fullmatch(page_id):
            raise ValueError("Invalid rejected-copy target page")
        file = Path(objective) / "rejected-copy-reports" / (page_id + ".json")
        if not file.exists():
            return None
        row = load(file, {})
        if not isinstance(row, dict):
            raise ValueError("Rejected-copy report is malformed")
        source, ref = row.get("source", {}), row.get("unit", {})
        _source(source, manifest)
        if row.get("schema") != CONTRACT or row.get("objectiveSha256") != manifest["objectiveSha256"] \
                or row.get("pageId") != page_id or _conflict(objective, page_id) \
                or row.get("modelRead") is not False or row.get("textCovered") is not False \
                or row.get("rejectedOutput") is not False or row.get("userConfirmed") is not False \
                or row.get("semanticAcceptance") != "not-established":
            raise ValueError("Rejected-copy report identity, policy or native conflict")
        canonical = _canonical(objective, manifest, row.get("canonicalUnitKey"))
        if not canonical or canonical["fileSha256"] != row.get("canonicalIndexSha256"):
            raise ValueError("Rejected-copy canonical proof changed")
        unit = {**ref, "content": canonical["unit"]["content"]}
        target_plan = _plan(source, unit, manifest)
        page = next((page for page in target_plan if page["pageId"] == page_id), None)
        plan = load(Path(objective) / "sources" / (hashed([source["system"], source["id"], source["sha256"]]) + ".json"), {})
        original = next((page for page in canonical["pages"] if page["pageId"] == row.get("canonicalPageId")), None)
        if _key(source, unit, manifest) != row["canonicalUnitKey"] or not page or not original \
                or row.get("identity") != page["identity"] \
                or expected_identity is not None and row["identity"] != expected_identity \
                or row.get("sourceContext") != page["sourceContext"] \
                or page["sourceContext"] != original["sourceContext"] \
                or any(page[k] != original[k] for k in ("content", "offset", "end", "totalChars")) \
                or plan.get("source") != source or plan.get("error") \
                or ref not in plan.get("representations", []) \
                or not {p["pageId"] for p in target_plan} <= set(plan.get("pageIds", [])):
            raise ValueError("Rejected-copy target scope or source plan differs")
        return row
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise RejectedCopyIntegrityError(str(error)) from error


def defer(objective, manifest, source, unit, unit_pages, page):
    """A new immutable target report carries only proof references, no result."""
    try:
        prior = read(objective, manifest, page["pageId"], expected_identity=page["identity"])
        if prior:
            return prior
        if _conflict(objective, page["pageId"]):
            return None
        key = _key(source, unit, manifest)
        if key is None:
            return None
        canonical = _canonical(objective, manifest, key)
        if not canonical:
            return None
        if unit_pages != _plan(source, unit, manifest) or page not in unit_pages:
            raise ValueError("Rejected-copy target requires a complete current plan")
        original = next((p for p in canonical["pages"] if all(p[k] == page[k]
                        for k in ("content", "offset", "end", "totalChars", "sourceContext"))), None)
        if not original:
            return None
        row = {"schema": CONTRACT, "at": now(), "objectiveSha256": manifest["objectiveSha256"],
               "pageId": page["pageId"], "identity": page["identity"], "source": source,
               "unit": equivalent.unit_ref(unit), "sourceContext": page["sourceContext"],
               "canonicalUnitKey": key, "canonicalIndexSha256": canonical["fileSha256"],
               "canonicalPageId": original["pageId"], "modelRead": False, "textCovered": False,
               "rejectedOutput": False, "semanticAcceptance": "not-established", "userConfirmed": False}
        durable(Path(objective) / "rejected-copy-reports" / (page["pageId"] + ".json"), row, exclusive=True)
        return read(objective, manifest, page["pageId"], expected_identity=page["identity"])
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise RejectedCopyIntegrityError(str(error)) from error


def receipts(objective, manifest):
    for file in sorted((Path(objective) / "rejected-copy-reports").glob("*.json")):
        yield read(objective, manifest, file.stem)
