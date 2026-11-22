"""Frozen quote context for new objective versions; old manifests stay v1."""
from pathlib import Path

from evidence_store import load
from review_attempts import durable, hashed
import source_quote_context as quotes
import objective_input_scope as input_scope

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


def _message(source, unit, scoped):
    extra = input_scope.message_context(source, unit) if scoped else {}
    return quotes.message(source['id'], unit['content'], source['headers'], source_time(source),
                          sourceSha256=source['sha256'], direction=source['direction'], **extra)


def bind_pages(root, objective, manifest, source, units, plan, *, create=True):
    """Verify only frozen same-thread originals, without downloading new mail.

    Outlook exports lack a canonical thread identity: unrelated exports are
    never guessed to be replies. Missing originals keep attribution unresolved.
    """
    if not contract_for(manifest):
        return
    from objective_sources import materialize

    scope = input_scope.contract_for(manifest)
    group = input_scope.group_for(scope, source) if scope is not None else None
    peers, gaps = [], []
    for ref in manifest["sources"]:
        if group is not None and input_scope.key(ref) not in group:
            continue
        if ref["system"] != source["system"] or ref["threadId"] != source["threadId"] or ref["id"] == source["id"]:
            continue
        try:
            current, representations, _ = (materialize(root, ref, input_scope_config=scope) if scope is not None
                                            else materialize(root, ref))
            bodies = [u["content"] for u in representations if u["representation"] == "mime-text"]
            # Conflicting MIME alternatives cannot verify another passage's
            # author. An exact alternative copy does not add testimony.
            if len(set(bodies)) != 1:
                if scope is not None:
                    raise ValueError('Selected input peer has no unique inline representation')
                gaps.append({"sourceId": ref["id"], "reason": "ambiguous-inline-representations"})
                continue
            peers.append(_message(current, next(u for u in representations if u['representation'] == 'mime-text'), True)
                         if scope is not None else quotes.message(current["id"], bodies[0], current["headers"],
                         source_time(current), sourceSha256=current["sha256"], direction=current["direction"]))
        except (OSError, ValueError, KeyError):
            if scope is not None:
                raise
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
            own = _message(source, unit, scope is not None)
            evidence = {"schema": CONTRACT, "objectiveSha256": manifest["objectiveSha256"],
                        "own": own, "messages": [own, *peers], "gaps": gaps}
            if scope is not None:
                input_scope.packet(scope, source, evidence)  # Fail closed before persistence or inference.
            digest = hashed(evidence)
            file = Path(objective) / "attribution-evidence" / (digest + ".json")
            if not file.exists():
                durable(file, evidence, exclusive=True)
            durable(index, {"evidenceSha256": digest}, exclusive=True)
        if scope is not None and input_scope.packet(scope, source, evidence) != input_scope.packet(
                scope, source, {'messages': [_message(source, unit, True), *peers]}):
            raise ValueError('Selected input context differs from the current frozen sources')
        for page in plan:
            if page["representation"] != {k: v for k, v in unit.items() if k != "content"}:
                continue
            page["sourceContext"] = source_context(own, page, evidence["messages"])
            page["attributionEvidenceSha256"] = digest
            if scope is not None:
                page['inputContext'] = input_scope.packet(scope, source, evidence)
                page['inputContextSha256'] = hashed(page['inputContext'])


def record_context(page, native):
    if "attributionEvidenceSha256" in page:
        native.update(attributionContract=CONTRACT,
                      attributionEvidenceSha256=page["attributionEvidenceSha256"],
                      sourceContext=page["sourceContext"])
    if 'inputContext' in page:
        native.update(inputReadingContract=input_scope.CONTRACT, inputContextSha256=hashed(page['inputContext']))


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
    if 'primarySource' in native:
        expected = {'identity': {k: native[k] for k in ('system', 'messageId', 'threadId', 'sourceSha256')},
                    'headers': own['headers'], 'attachmentMetadata': own.get('attachmentMetadata', [])
                    if native['representation']['representation'] == 'mime-text' else []}
        if native['primarySource'] != expected:
            raise ValueError('Primary metadata differs from its frozen source evidence')
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
    scope = input_scope.contract_for(manifest)
    native = record['nativeRef']
    from objective_grounding import contract_for as grounding_contract, SOURCE_SELECTION_CONTRACTS
    if grounding_contract(manifest) in SOURCE_SELECTION_CONTRACTS and 'primarySource' not in native:
        raise ValueError('Source-selection receipt requires frozen primary metadata')
    if scope is not None:
        evidence = load(Path(objective) / 'attribution-evidence' / (native.get('attributionEvidenceSha256', '') + '.json'), {})
        source = {'system': native['system'], 'id': native['messageId'], 'sha256': native['sourceSha256']}
        if native.get('inputReadingContract') != input_scope.CONTRACT or native.get('inputContextSha256') != hashed(input_scope.packet(scope, source, evidence)):
            raise ValueError('Selected input receipt differs from its frozen context')
    elif native.get('inputReadingContract') is not None or native.get('inputContextSha256') is not None:
        raise ValueError('Unversioned selected input receipt')
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
