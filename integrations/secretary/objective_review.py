#!/usr/bin/env python3
"""Versioned, resumable objective review beside existing Secretary page receipts."""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import sys
import time
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
from evidence_store import load, now
from mail_catchup import Busy, CoreClient
from mailbox_backfill import Lock
from objective_schema import INSTRUCTIONS, SCHEMA, normalize_representation, validate
from objective_sources import inventory, materialize, pages
import objective_equivalence as equivalent
import objective_dispositions as dispositions
from review_attempts import ReviewUncertain, durable, extract_once, hashed, unsettled, blocked_phase, blocked_counts, result_file
from review_response import ReviewInvalidOutput
from secretary_evidence import DEFAULT_ROOT

CONTRACT = "secretary.objective-review/v1"
KEY = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}")
UUID = re.compile(r"[a-f0-9-]{36}")


def config_at(file):
    value = load(file, {})
    if set(value) - {"id", "version", "kind", "ownerAliases", "instructions", "selection", "pageChars", "overlap", "thinking"}:
        raise ValueError("Unknown objective configuration field")
    if "thinking" in value and type(value["thinking"]) is not bool:
        raise ValueError("Objective thinking must be an explicit boolean")
    if value.get("kind") != "life-timeline" or any(not KEY.fullmatch(str(value.get(k, ""))) for k in ("id", "version")):
        raise ValueError("Objective needs a safe id/version and supported kind")
    aliases = value.get("ownerAliases", [])
    if not isinstance(aliases, list) or not aliases or any(not isinstance(a, str) or not a.strip() for a in aliases):
        raise ValueError("Private owner aliases must be explicit")
    if not isinstance(value.get("instructions", ""), str):
        raise ValueError("Instructions must be private text")
    selection = value.get("selection", {})
    if not isinstance(selection, dict) or set(selection) - {"gmailMessageIds", "outlookSha256", "order"}:
        raise ValueError("Invalid native source selection")
    for key, values in selection.items():
        if not isinstance(values, list) or any(not isinstance(s, str) for s in values) or len(values) != len(set(values)):
            raise ValueError("Source selections must be distinct strings")
        pattern = r"[a-zA-Z0-9_-]{8,256}" if key == "gmailMessageIds" else r"[a-f0-9]{64}" if key == "outlookSha256" else r"(?:gmail|outlook-export):[a-zA-Z0-9_-]{8,256}"
        if any(not re.fullmatch(pattern, s) for s in values):
            raise ValueError("Invalid selected source identity")
    value = {"instructions": "", "selection": {}, "pageChars": 6000, "overlap": 300, **value}
    if type(value["pageChars"]) is not int or not 1000 <= value["pageChars"] <= 12000 \
            or type(value["overlap"]) is not int or not 0 <= value["overlap"] < value["pageChars"] // 2:
        raise ValueError("Invalid bounded page size/overlap")
    return value


def prepare(root, config, *, create=True):
    root = Path(root)
    objective = root / "objective-reviews" / config["id"] / config["version"]
    system = INSTRUCTIONS + "\n\nPrivate owner instructions:\n" + config["instructions"]
    objective_sha = hashed({"contract": CONTRACT, "config": config, "system": system, "schema": SCHEMA})
    file = objective / "manifest.json"
    if file.exists():
        manifest = load(file, {})
        if manifest.get("objectiveSha256") != objective_sha:
            raise ValueError("This objective version already has another intent; use a new version")
        return objective, manifest
    if not create:
        raise ValueError("This objective has not been planned; status never creates a campaign")
    manifest = {"schema": CONTRACT, "createdAt": now(), "objectiveSha256": objective_sha,
                "config": config, "sources": inventory(root, config["selection"]),
                "systemSha256": hashed(system), "responseSchemaSha256": hashed(SCHEMA)}
    try:
        durable(file, manifest, exclusive=True)
    except FileExistsError:
        return prepare(root, config, create=create)
    return objective, manifest


def source_key(source):
    return hashed([source["system"], source["id"], source["sha256"]])


def read_receipt(file, manifest):
    row = load(file, {})
    record = row.get("sourceRecord", {})
    identity = row.get("identity", {})
    if row.get("schema") != CONTRACT or row.get("objectiveSha256") != manifest["objectiveSha256"] \
            or row.get("pageId") != file.stem or hashed(identity) != file.stem \
            or identity.get("objectiveSha256") != manifest["objectiveSha256"] \
            or not isinstance(record.get("body"), str) \
            or record.get("bodySha256") != hashlib.sha256(record["body"].encode()).hexdigest() \
            or record.get("bodySha256") != identity.get("contentSha256"):
        raise ValueError("Objective receipt integrity does not match its saved identity")
    validate(row["result"], record["body"])
    if "resultProcessing" in row:
        raw = load(result_file(file.parent.parent, file.stem), {}).get("value")
        normalized, changes = normalize_representation(raw, record["body"])
        expected = {"contract": "secretary.objective-representation/v1", "rawResultSha256": hashed(raw), "changes": changes}
        if not changes or row["resultProcessing"] != expected or normalized != row["result"]:
            raise ValueError("Objective representation receipt does not match the retained native result")
    return row


def coverage(objective, manifest):
    counts = Counter(targetSources=len(manifest["sources"]))
    by_system, sources = {}, []
    aliases = list(equivalent.receipts(objective, manifest))
    alias_index = equivalent.coverage_index(aliases)
    for alias in aliases:
        for pid in alias["canonicalPageIds"]:
            read_receipt(objective / "page-reviews" / (pid + ".json"), manifest)
    for source in manifest["sources"]:
        plan = load(objective / "sources" / (source_key(source) + ".json"), {})
        expected = plan.get("pageIds", [])
        read, rejected = [], []
        for pid in expected:
            rejected_row = dispositions.read(objective, manifest, pid)
            if rejected_row:
                rejected.append(pid)
                continue
            file = objective / "page-reviews" / (pid + ".json")
            if not file.is_file():
                continue
            try:
                row = read_receipt(file, manifest)
                counts["extractedMoments"] += len(row["result"]["moments"])
                counts["reviewGaps"] += len(row["result"]["gaps"])
                counts["classification:" + row["result"]["classification"]] += 1
                read.append(pid)
            except (OSError, ValueError, KeyError, TypeError):
                counts["invalidReviewReceipts"] += 1
        reused = alias_index.get((source["system"], source["id"], source["sha256"]), set()) & (set(expected) - set(read) - set(rejected))
        complete = bool(plan) and len(read) == len(expected) and bool(expected) and not plan.get("error")
        covered = bool(plan) and len(read) + len(reused) == len(expected) and bool(expected) and not plan.get("error")
        gaps = [*plan.get("gaps", []), *[{"code": "model-output-rejected", "pageId": pid,
                "receipt": "page-dispositions/" + pid + ".json"} for pid in rejected]]
        row = {"system": source["system"], "messageId": source["id"], "sourceSha256": source["sha256"],
               "materialized": bool(plan), "expectedPages": len(expected) if plan else None,
               "reviewedPages": len(read), "equivalentPages": len(reused),
               "pendingPages": len(expected) - len(read) - len(reused) - len(rejected) if plan else None,
               "rejectedPages": len(rejected),
               "textReviewComplete": complete, "textCovered": covered, "gaps": gaps, "error": plan.get("error")}
        sources.append(row)
        counts["materializedSources"] += bool(plan)
        counts["sourcesPendingMaterialization"] += not bool(plan)
        counts["sourcesTextReviewed"] += complete
        counts["sourcesTextCovered"] += covered
        counts["equivalentPages"] += len(reused)
        counts["sourcesWithGaps"] += bool(gaps)
        counts["sourcesWithRejectedPages"] += bool(rejected)
        counts["rejectedPages"] += len(rejected)
        counts["sourceErrors"] += bool(plan.get("error"))
        counts["expectedPagesKnown"] += len(expected)
        counts["reviewedPages"] += len(read)
        counts["pendingPagesKnown"] += len(expected) - len(read) - len(reused) - len(rejected)
        by_system[source["system"]] = by_system.get(source["system"], 0) + 1
    return {"schema": CONTRACT, "at": now(), "objectiveId": manifest["config"]["id"],
            "version": manifest["config"]["version"], "objectiveSha256": manifest["objectiveSha256"],
            "counts": dict(counts), "bySystem": by_system, "sources": sources,
            "allTargetTextReviewed": counts["sourcesTextReviewed"] == len(manifest["sources"]) and bool(sources),
            "allTargetTextCovered": counts["sourcesTextCovered"] == len(manifest["sources"]) and bool(sources),
            "semanticAcceptance": "not-established", "userConfirmed": False,
            "scope": "Frozen archived original bytes; all native inline text representations and available existing attachment text",
            "limits": ["Not a live-mailbox completeness proof; new sources require a new objective version.",
                       "Related and third-party events remain attributed; no user confirmation is inferred.",
                       "Visual/OCR quality, nested attachments, omitted HTML data and linked documents retain explicit gaps.",
                       "Repeated MIME parts, RFC Message-IDs and quoted chains are not independent testimony."]}


def _source_record(page):
    source = page["source"]
    sid = "objective-" + page["pageId"]
    native = {"system": source["system"], "messageId": source["id"], "threadId": source["threadId"],
              "sourceSha256": source["sha256"], "rfc822MessageId": source.get("rfc822MessageId"),
              "direction": source.get("direction", "unknown"),
              "readerContract": CONTRACT, "representation": page["representation"],
              "offset": page["offset"], "end": page["end"], "totalChars": page["totalChars"]}
    return {"id": sid, "kind": "mail", "body": page["content"],
            "bodySha256": hashlib.sha256(page["content"].encode()).hexdigest(), "subject": source["headers"].get("subject", ""),
            "mailDate": source.get("mailDate"), "nativeRef": native,
            "authority": "secretary-native-objective-review", "bodyScope": "exact-reviewed-passage"}


def export(objective, manifest):
    findings, records = [], {}
    aliases = list(equivalent.receipts(objective, manifest))
    aliases_by_page = {}
    for alias in aliases:
        for pid in alias["canonicalPageIds"]:
            aliases_by_page.setdefault(pid, []).append(alias)
    for file in sorted((objective / "page-reviews").glob("*.json")):
        row = read_receipt(file, manifest)
        record = row["sourceRecord"]
        if not row["result"]["moments"]:
            continue
        records[record["id"]] = record
        for index, moment in enumerate(row["result"]["moments"]):
            identity = hashed([manifest["objectiveSha256"], row["pageId"], moment])
            finding = {"id": "objective-" + identity, **moment, "reviewState": "candidate", "userConfirmed": False,
                "objectiveId": manifest["config"]["id"], "objectiveVersion": manifest["config"]["version"],
                "sourceIds": [record["id"]], "nativeSourceRefs": [record["nativeRef"]],
                "claimsWithExactQuotes": [{"sourceId": record["id"], "quote": q} for q in moment["quotes"]]}
            for alias in aliases_by_page.get(row["pageId"], []):
                claims = [c for c in alias["mappedClaims"] if c["canonicalPageId"] == row["pageId"] and c["canonicalMomentIndex"] == index]
                if not claims:
                    continue
                other = alias["sourceRecord"]
                records[other["id"]] = other
                if other["id"] not in finding["sourceIds"]:
                    finding["sourceIds"].append(other["id"])
                    finding["nativeSourceRefs"].append(other["nativeRef"])
                finding["claimsWithExactQuotes"].extend({"sourceId": other["id"], "quote": q} for c in claims for q in c["quotes"])
                finding["sourceIndependence"] = "same-declaration"
            findings.append(finding)
    report = coverage(objective, manifest)
    durable(objective / "findings.json", findings)
    durable(objective / "sources.json", list(records.values()))
    durable(objective / "coverage.json", report)
    return report


def run(root, objective, manifest, client, *, max_pages, queue_id, dispatch_id, per_source_pages=None,
        max_seconds=1800, priority=(), retain_rejected_pages=False, sleep=time.sleep, clock=time.monotonic, stop=lambda: False):
    if not UUID.fullmatch(queue_id or "") or not UUID.fullmatch(dispatch_id or ""):
        raise ValueError("Native run requires its explicit Core operator queue/dispatch identities")
    if type(max_pages) is not int or max_pages <= 0:
        raise ValueError("Every run needs a positive bounded page budget")
    if per_source_pages is not None and (type(per_source_pages) is not int or per_source_pages <= 0):
        raise ValueError("Invalid per-source page budget")
    if type(max_seconds) is not int or max_seconds <= 0:
        raise ValueError("Every run needs a positive time budget")
    if getattr(client, "thinking", False) is not manifest["config"].get("thinking", False):
        raise ValueError("The native client thinking mode differs from the frozen objective")
    fence = SimpleNamespace(root=objective)
    held = unsettled(objective)
    cached_invalid_pages = set()
    if retain_rejected_pages:
        for row in held:
            if row.get("outcome") == "completed-invalid-output":
                dispositions.terminal(objective, row["pageId"], row["requestId"])
                cached_invalid_pages.add(row["pageId"])
        held = [row for row in held if row.get("outcome") != "completed-invalid-output"]
    if held:
        status = {"schema": CONTRACT, "startedAt": now(), "at": now(), "queueRequestId": queue_id,
                  "dispatchId": dispatch_id, "phase": blocked_phase(held), "attempts": held,
                  "newlyReviewedPages": 0, "inferenceCalls": 0, "elapsedSeconds": 0, **blocked_counts(held)}
        durable(objective / "status.json", status)
        return {**status, "coverage": coverage(objective, manifest)}
    system = INSTRUCTIONS + "\n\nPrivate owner instructions:\n" + manifest["config"]["instructions"]
    started, made, rejected, inferences = clock(), 0, 0, 0
    requested_stop = stop
    stop = lambda: requested_stop() or clock() - started >= max_seconds
    status = {"schema": CONTRACT, "startedAt": now(), "queueRequestId": queue_id, "dispatchId": dispatch_id}
    known_aliases = list(equivalent.receipts(objective, manifest))
    alias_index = equivalent.coverage_index(known_aliases)
    for alias in known_aliases:
        for pid in alias["canonicalPageIds"]:
            read_receipt(objective / "page-reviews" / (pid + ".json"), manifest)

    def finish(phase, **extra):
        status.update(phase=phase, at=now(), newlyReviewedPages=made, inferenceCalls=inferences,
                      elapsedSeconds=round(clock() - started, 3), **extra)
        if retain_rejected_pages:
            status.update(newlyRejectedPages=rejected, processedPages=made + rejected)
        durable(objective / "status.json", status)
        return {**status, "coverage": export(objective, manifest)}

    order = {value: index for index, value in enumerate(priority)}
    ordered = sorted(manifest["sources"], key=lambda source: order.get(source["system"] + ":" + source["id"], len(order)))
    for source in ordered:
        if made + rejected >= max_pages or stop():
            return finish("partial" if not stop() else "stopped")
        plan_file = objective / "sources" / (source_key(source) + ".json")
        previous = load(plan_file, {})
        alias_pages = alias_index.get((source["system"], source["id"], source["sha256"]), set())
        if previous.get("pageIds") and set(previous["pageIds"]) <= alias_pages:
            continue
        if previous.get("pageIds") and all((objective / "page-reviews" / (pid + ".json")).is_file() for pid in previous["pageIds"]):
            for pid in previous["pageIds"]:
                read_receipt(objective / "page-reviews" / (pid + ".json"), manifest)
            continue
        # A queue placement is planning; assert the *current* operator dispatch
        # before source work and every live call. Core still owns model admission.
        client._call("POST", "/api/cluster/schedule/work-queue/" + queue_id + "/assert-dispatch", {"dispatchId": dispatch_id})
        try:
            current, units, gaps = materialize(root, source)
            plan = list(pages(current, units, manifest["objectiveSha256"], manifest["config"]["pageChars"], manifest["config"]["overlap"]))
            durable(plan_file, {"source": current, "pageIds": [p["pageId"] for p in plan], "gaps": gaps,
                                "representations": [{k: v for k, v in u.items() if k != "content"} for u in units]})
            reused = set()
            for unit in units:
                unit_pages = [p for p in plan if p["representation"] == equivalent.unit_ref(unit)]
                equivalent.register(objective, current, unit, unit_pages, read_receipt, manifest)
                if all((objective / "page-reviews" / (p["pageId"] + ".json")).is_file() for p in unit_pages):
                    continue
                canonical = equivalent.find(objective, current, unit, read_receipt, manifest)
                if canonical:
                    equivalent.alias(objective, current, unit, unit_pages, canonical, _source_record)
                    reused.update(p["pageId"] for p in unit_pages)
        except (OSError, ValueError, RuntimeError, KeyError) as error:
            durable(plan_file, {"source": source, "error": type(error).__name__, "gaps": [{"code": "source-unavailable-or-integrity-failed"}]})
            return finish("source-error", sourceId=source["id"], errorType=type(error).__name__)
        used = 0
        for page in plan:
            if page["pageId"] in reused:
                continue
            if retain_rejected_pages and dispositions.read(objective, manifest, page["pageId"], expected_identity=page["identity"]):
                continue
            if (objective / "page-reviews" / (page["pageId"] + ".json")).is_file():
                read_receipt(objective / "page-reviews" / (page["pageId"] + ".json"), manifest)
                continue
            unit = next(u for u in units if equivalent.unit_ref(u) == page["representation"])
            unit_pages = [p for p in plan if p["representation"] == page["representation"]]
            canonical = equivalent.find(objective, current, unit, read_receipt, manifest)
            if canonical:
                equivalent.alias(objective, current, unit, unit_pages, canonical, _source_record)
                reused.update(p["pageId"] for p in unit_pages)
                continue
            if made + rejected >= max_pages or stop():
                return finish("partial" if not stop() else "stopped")
            if per_source_pages is not None and used >= per_source_pages:
                break
            while True:
                try:
                    if stop():
                        return finish("stopped")
                    client._call("POST", "/api/cluster/schedule/work-queue/" + queue_id + "/assert-dispatch", {"dispatchId": dispatch_id})
                    reason = client.busy()
                    if reason:
                        raise Busy(reason)
                    prompt = json.dumps({"objectiveContext": {"asOf": manifest["createdAt"], "ownerAliases": manifest["config"]["ownerAliases"]},
                        "source": page["source"], "representation": page["representation"],
                        "offset": page["offset"], "totalChars": page["totalChars"],
                        "moreOfThisRepresentation": page["moreOfThisRepresentation"], "sourceContext": page["sourceContext"],
                        "untrustedContent": page["content"]}, ensure_ascii=False)
                    saved = result_file(objective, page["pageId"]).is_file() or page["pageId"] in cached_invalid_pages
                    raw = extract_once(fence, client, system, prompt, page)
                    inferences += not saved
                    normalized, changes = normalize_representation(raw, page["content"])
                    validate(normalized, page["content"])
                    record = _source_record(page)
                    receipt = {
                        "schema": CONTRACT, "objectiveSha256": manifest["objectiveSha256"], "pageId": page["pageId"], "identity": page["identity"],
                        "at": now(), "sourceRecord": record, "result": normalized, "queueRequestId": queue_id, "dispatchId": dispatch_id}
                    if changes:
                        receipt["resultProcessing"] = {"contract": "secretary.objective-representation/v1",
                            "rawResultSha256": hashed(raw), "changes": changes}
                    durable(objective / "page-reviews" / (page["pageId"] + ".json"), receipt)
                    break
                except Busy as error:
                    status.update(phase="paused", at=now(), reason=error.reason, newlyReviewedPages=made)
                    durable(objective / "status.json", status)
                    sleep(min(error.retry_after, 60))
                except ReviewUncertain:
                    return finish("uncertain", pageId=page["pageId"])
                except ReviewInvalidOutput as error:
                    inferences += not saved
                    if retain_rejected_pages:
                        dispositions.retain(objective, manifest, page, error)
                        rejected += 1
                        break
                    return finish("validation-error", pageId=page["pageId"], errorType=type(error).__name__,
                                  validationReason=error.reason, outputLimits=error.limits)
                except (ValueError, RuntimeError) as error:
                    if retain_rejected_pages and isinstance(error, ValueError):
                        dispositions.retain(objective, manifest, page, error)
                        rejected += 1
                        break
                    return finish("validation-error", pageId=page["pageId"], errorType=type(error).__name__)
            used += 1
            if retain_rejected_pages and dispositions.read(objective, manifest, page["pageId"], expected_identity=page["identity"]):
                status.update(phase="reviewing", at=now(), newlyReviewedPages=made, newlyRejectedPages=rejected,
                              lastRejectedPageId=page["pageId"])
                durable(objective / "status.json", status)
                continue
            made += 1
            status.update(phase="reviewing", at=now(), newlyReviewedPages=made, lastPageId=page["pageId"])
            durable(objective / "status.json", status)
            equivalent.register(objective, current, unit, unit_pages, read_receipt, manifest)
        for unit in units:
            unit_pages = [p for p in plan if p["representation"] == equivalent.unit_ref(unit)]
            equivalent.register(objective, current, unit, unit_pages, read_receipt, manifest)
    return finish("done" if coverage(objective, manifest)["allTargetTextCovered"] else "partial")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("plan", "status", "run", "export"))
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--objective", type=Path, required=True, help="Private versioned configuration outside Git")
    parser.add_argument("--core", default=os.environ.get("AGENTX_CORE_URL", "http://127.0.0.1:3180"))
    parser.add_argument("--task-type", default="mail_review")
    parser.add_argument("--max-pages", type=int)
    parser.add_argument("--max-pages-per-source", type=int)
    parser.add_argument("--max-seconds", type=int, default=1800)
    parser.add_argument("--max-output-tokens", type=int, help="Explicit Core output budget; never changes the host pin or context")
    parser.add_argument("--retain-rejected-pages", action="store_true", help="Review-only: preserve certain rejected outputs as gaps without retry or accepted coverage")
    parser.add_argument("--queue-request-id")
    parser.add_argument("--queue-dispatch-id")
    parser.add_argument("--priority-file", type=Path, help="Private native IDs; scheduling order only, never model instructions")
    args = parser.parse_args(argv)
    objective, manifest = prepare(args.root, config_at(args.objective), create=args.command in ("plan", "run"))
    if args.command in ("plan", "status"):
        result = coverage(objective, manifest)
    elif args.command == "export":
        result = export(objective, manifest)
    else:
        priority = load(args.priority_file, []) if args.priority_file else []
        if not isinstance(priority, list) or any(not isinstance(value, str) or not re.fullmatch(r"(?:gmail|outlook-export):[a-zA-Z0-9_-]{8,256}", value) for value in priority):
            raise ValueError("Priority must contain explicit native source keys")
        stopping = []
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, lambda *_: stopping.append(True))
        lock = Lock(objective, "worker.lock")
        if not lock.acquire():
            raise RuntimeError("This objective already has a native worker")
        try:
            result = run(args.root, objective, manifest, CoreClient(args.core, task_type=args.task_type, schema=SCHEMA,
                         caller="secretary-objective-review", max_output_tokens=args.max_output_tokens,
                         thinking=manifest["config"].get("thinking", False)), max_pages=args.max_pages, queue_id=args.queue_request_id,
                         dispatch_id=args.queue_dispatch_id, per_source_pages=args.max_pages_per_source,
                         max_seconds=args.max_seconds, priority=priority, retain_rejected_pages=args.retain_rejected_pages,
                         stop=lambda: bool(stopping))
        finally:
            lock.release()
    if args.command == "plan":
        durable(objective / "coverage.json", result)
    print(json.dumps({k: v for k, v in result.items() if k not in ("sources", "coverage")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
