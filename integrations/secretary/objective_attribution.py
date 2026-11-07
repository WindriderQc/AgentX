"""Frozen quote context for new objective versions; old manifests stay v1."""
from pathlib import Path

from evidence_store import load
from review_attempts import durable, hashed
import source_quote_context as quotes

CONTRACT = quotes.OBJECTIVE_CONTRACT


def contract_for(manifest):
    contract = manifest.get("attributionContract")
    if contract not in (None, CONTRACT):
        raise ValueError("Unsupported objective attribution contract")
    return contract


def system(base, contract):
    return base if contract is None else base + "\n\n" + quotes.POLICY


def source_context(own, page, messages):
    kind = "body" if page["representation"]["representation"] == "mime-text" else "attachment"
    return quotes.context(own, page["offset"], len(page["content"]), messages, kind=kind)


def source_time(source):
    # Gmail's preserved provider chronology orders messages; a quoted/RFC Date
    # is source wording and must not turn a later reply into an earlier original.
    if source["system"] == "gmail":
        try:
            return max(0, int(source.get("sourceDate") or 0))
        except (TypeError, ValueError, OverflowError):
            return 0
    return quotes.milliseconds(source.get("mailDate"))


def bind_pages(root, objective, manifest, source, units, plan, *, create=True):
    """Verify only frozen same-thread originals, without downloading new mail.

    Outlook exports lack a canonical thread identity: unrelated exports are
    never guessed to be replies. Missing originals keep attribution unresolved.
    """
    if not contract_for(manifest):
        return
    from objective_sources import materialize

    peers, gaps = [], []
    for ref in manifest["sources"]:
        if ref["system"] != source["system"] or ref["threadId"] != source["threadId"] or ref["id"] == source["id"]:
            continue
        try:
            current, representations, _ = materialize(root, ref)
            bodies = [u["content"] for u in representations if u["representation"] == "mime-text"]
            # Conflicting MIME alternatives cannot verify another passage's
            # author. An exact alternative copy does not add testimony.
            if len(set(bodies)) != 1:
                gaps.append({"sourceId": ref["id"], "reason": "ambiguous-inline-representations"})
                continue
            peers.append(quotes.message(current["id"], bodies[0], current["headers"],
                source_time(current), sourceSha256=current["sha256"], direction=current["direction"]))
        except (OSError, ValueError, KeyError):
            gaps.append({"sourceId": ref["id"], "reason": "frozen-thread-source-unavailable"})
    for unit in units:
        key = hashed([manifest["objectiveSha256"], source["system"], source["id"], source["sha256"],
                      {k: v for k, v in unit.items() if k != "content"}])
        index = Path(objective) / "attribution-index" / (key + ".json")
        if index.exists():
            digest = load(index)["evidenceSha256"]
            if not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
                raise ValueError("Invalid frozen attribution digest")
            evidence = load(Path(objective) / "attribution-evidence" / (digest + ".json"))
            if hashed(evidence) != digest or evidence.get("objectiveSha256") != manifest["objectiveSha256"]:
                raise ValueError("Frozen attribution evidence changed")
            own = evidence["own"]
            if own["body"] != unit["content"] or own["id"] != source["id"] or own["sourceSha256"] != source["sha256"]:
                raise ValueError("Frozen attribution representation changed")
        else:
            if not create:
                raise ValueError("Missing frozen attribution index")
            own = quotes.message(source["id"], unit["content"], source["headers"],
                source_time(source), sourceSha256=source["sha256"], direction=source["direction"])
            evidence = {"schema": CONTRACT, "objectiveSha256": manifest["objectiveSha256"],
                        "own": own, "messages": [own, *peers], "gaps": gaps}
            digest = hashed(evidence)
            file = Path(objective) / "attribution-evidence" / (digest + ".json")
            if not file.exists():
                durable(file, evidence, exclusive=True)
            durable(index, {"evidenceSha256": digest}, exclusive=True)
        for page in plan:
            if page["representation"] != {k: v for k, v in unit.items() if k != "content"}:
                continue
            page["sourceContext"] = source_context(own, page, evidence["messages"])
            page["attributionEvidenceSha256"] = digest


def record_context(page, native):
    if "attributionEvidenceSha256" in page:
        native.update(attributionContract=CONTRACT,
                      attributionEvidenceSha256=page["attributionEvidenceSha256"],
                      sourceContext=page["sourceContext"])


def project(objective, record, result, *, expected_objective=None):
    native = record["nativeRef"]
    digest = native.get("attributionEvidenceSha256", "")
    if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
        raise ValueError("Missing frozen attribution evidence")
    evidence = load(Path(objective) / "attribution-evidence" / (digest + ".json"), {})
    if hashed(evidence) != digest or evidence.get("schema") != CONTRACT \
            or expected_objective is not None and evidence.get("objectiveSha256") != expected_objective:
        raise ValueError("Frozen attribution evidence failed integrity validation")
    own, messages = evidence["own"], evidence["messages"]
    if own["id"] != native["messageId"] or own["sourceSha256"] != native["sourceSha256"] \
            or own["body"][native["offset"]:native["end"]] != record["body"]:
        raise ValueError("Attribution evidence differs from the exact retained source")
    page = {"representation": native["representation"], "offset": native["offset"], "content": record["body"]}
    if native.get("sourceContext") != source_context(own, page, messages):
        raise ValueError("Attribution context differs from its frozen evidence")
    kind = "body" if native["representation"]["representation"] == "mime-text" else "attachment"
    return {"schema": CONTRACT, "evidenceSha256": digest, "gaps": evidence["gaps"],
        "moments": [[quotes.citation(own, quote, native["offset"], len(record["body"]), messages, kind=kind)
                     for quote in moment["quotes"]] for moment in result["moments"]]}


def validate_receipt(objective, row, manifest):
    if not contract_for(manifest):
        return
    record = row["sourceRecord"]
    if record["nativeRef"].get("attributionContract") != CONTRACT \
            or row.get("quoteAttribution") != project(objective, record, row["result"], expected_objective=manifest["objectiveSha256"]):
        raise ValueError("Objective quote attribution differs from its retained evidence")


def extraction_context(context, record, manifest):
    """A container date/owner cue cannot date or identify a quoted declaration."""
    if not contract_for(manifest):
        return context
    native = record.get("nativeRef", record)
    source = native.get("sourceContext", {})
    if not source or any(s["relation"] != "authored" for s in source.get("segments", [])):
        return {**(context or {}), "mailDate": None, "direction": "unknown"}
    return context
