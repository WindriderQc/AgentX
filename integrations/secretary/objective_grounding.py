"""Select source spans and separate observations from proposed interpretations.

This is an extraction contract, not an entailment checker or owner approval.
The historical canonical result stays readable independently of this model wire
format. Native responses and the complete projection remain in their receipts.
"""
from __future__ import annotations

import copy
import re

from objective_schema import MOMENT, field
from review_receipts import hashed
import objective_source_language as language
import objective_fact_policy as facts
import objective_claim_proofs as proofs
import objective_date_evidence as dates
import objective_conditional_schema as conditional
import objective_uncertainty_context as contextual
import objective_source_observations as source_observations
import objective_useful_selection as useful_selection

LEGACY_CONTRACT = "secretary.objective-grounding/v1"
WORDING_CONTRACT = "secretary.objective-grounding/v2"
PROXIMITY_CONTRACT = "secretary.objective-grounding/v3"
FACT_CONTRACT = "secretary.objective-grounding/v4"
PROOF_CONTRACT = "secretary.objective-grounding/v5"
CONDITIONAL_CONTRACT = "secretary.objective-grounding/v6"
SOURCE_CONTRACT = "secretary.objective-grounding/v7"
CONTRACT = "secretary.objective-grounding/v8"
CLAIM = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "text": field(minLength=1, maxLength=600),
        "citationIds": {"type": "array", "minItems": 1, "maxItems": 20,
                        "items": field(minLength=1, maxLength=20)},
    },
    "required": ["text", "citationIds"],
}
MODEL_MOMENT = copy.deepcopy(MOMENT)
for key in ("description", "rationale", "quotes", "relationHints"):
    del MODEL_MOMENT["properties"][key]
MODEL_MOMENT["properties"].update(
    observations={"type": "array", "minItems": 1, "maxItems": 6, "items": CLAIM},
    hypotheses={"type": "array", "maxItems": 4, "items": CLAIM})
MODEL_MOMENT["required"] = list(MODEL_MOMENT["properties"])
SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "summary": field(minLength=1, maxLength=2000),
        "emptyAssessment": field(enum=["no-life-event", "uncertain"]),
        "moments": {"type": "array", "items": MODEL_MOMENT},
        "gaps": {"type": "array", "items": field()},
    },
    "required": ["summary", "emptyAssessment", "moments", "gaps"],
}
SCHEMA_V1 = SCHEMA
SCHEMA = copy.deepcopy(SCHEMA_V1)
del SCHEMA["properties"]["summary"]
SCHEMA["properties"]["summaryCitationIds"] = {"type": "array", "maxItems": 3, "items": field(minLength=1, maxLength=20)}
SCHEMA["required"] = list(SCHEMA["properties"])
SCHEMA["properties"]["moments"]["items"]["properties"]["hypotheses"]["items"] = {
    "type": "object", "additionalProperties": False,
    "properties": {"basis": field(enum=list(language.LABELS)),
                   "citationIds": {"type": "array", "minItems": 1, "maxItems": 1, "items": field(minLength=1, maxLength=20)}},
    "required": ["basis", "citationIds"],
}
SCHEMA_V2 = SCHEMA
SCHEMA = copy.deepcopy(SCHEMA_V2)
# Close-person attribution is a human review decision, never a model inference
# from an exchange, shared address, document title or familiar salutation.
SCHEMA["properties"]["moments"]["items"]["properties"]["subject"]["enum"] = ["owner", "thirdparty", "unknown"]
SCHEMA_V3 = SCHEMA
SCHEMA = copy.deepcopy(SCHEMA_V3)
SCHEMA["properties"]["omittedCueIds"] = {"type": "array", "maxItems": 1000, "items": field(minLength=1, maxLength=20)}
SCHEMA["required"] = list(SCHEMA["properties"])
_moment = SCHEMA["properties"]["moments"]["items"]
del _moment["properties"]["uncertainty"]
_moment["properties"]["factType"] = field(enum=list(facts.FACT_TYPES))
_moment["required"] = list(_moment["properties"])
SCHEMA_V4 = SCHEMA
SCHEMA = copy.deepcopy(SCHEMA_V4)
_moment = SCHEMA["properties"]["moments"]["items"]
for _key in ("startDate", "endDate", "startPrecision", "endPrecision", "originalDate"):
    del _moment["properties"][_key]
for _side in ("start", "end"):
    _moment["properties"][_side + "DateRef"] = field(["string", "null"])
_moment["properties"]["factType"] = field(enum=list(proofs.FACT_LABELS))
_moment["properties"]["factTypeCitationIds"] = {"type": "array", "maxItems": 20, "items": field()}
_moment["properties"]["hypotheses"]["items"] = field(minLength=1, maxLength=20)
_moment["required"] = list(_moment["properties"])

SCHEMA_V5 = SCHEMA
SCHEMA = conditional.schema(SCHEMA_V5)
SCHEMA_V6 = SCHEMA
SCHEMA = source_observations.schema(SCHEMA_V6)
SCHEMA_V7 = SCHEMA
SCHEMA = useful_selection.schema(SCHEMA_V7)


def contract_for(manifest):
    digest = manifest.get("responseSchemaSha256")
    for contract, schema in ((CONTRACT, SCHEMA), (SOURCE_CONTRACT, SCHEMA_V7), (CONDITIONAL_CONTRACT, SCHEMA_V6), (PROOF_CONTRACT, SCHEMA_V5), (FACT_CONTRACT, SCHEMA_V4), (PROXIMITY_CONTRACT, SCHEMA_V3),
                             (WORDING_CONTRACT, SCHEMA_V2), (LEGACY_CONTRACT, SCHEMA_V1)):
        if digest == hashed(schema):
            return contract
    return None


def catalog(content):
    """Each ID denotes one exact nonempty line, with Python character offsets."""
    result = []
    for match in re.finditer(r"[^\r\n]+", content):
        if match.group().strip():
            result.append({"id": "q" + str(len(result) + 1), "start": match.start(),
                           "end": match.end(), "text": match.group()})
    return result


def schema_for(content, contract=CONTRACT, source_context=None):
    if contract == CONTRACT:
        return useful_selection.schema(schema_for(content, SOURCE_CONTRACT, source_context), catalog(content))
    if contract == SOURCE_CONTRACT:
        return source_observations.schema(schema_for(content, CONDITIONAL_CONTRACT, source_context), catalog(content))
    if contract == CONDITIONAL_CONTRACT:
        return conditional.schema(schema_for(content, PROOF_CONTRACT, source_context), catalog(content), source_context)
    schema = copy.deepcopy({LEGACY_CONTRACT: SCHEMA_V1, WORDING_CONTRACT: SCHEMA_V2,
                            PROXIMITY_CONTRACT: SCHEMA_V3, FACT_CONTRACT: SCHEMA_V4, PROOF_CONTRACT: SCHEMA_V5}[contract])
    # An empty passage has no selectable evidence. A fabricated moment still
    # fails local resolution even if a backend ignores the response schema.
    spans = catalog(content)
    ids = [row["id"] for row in spans]
    moments = schema["properties"]["moments"]
    guarded = contract in (PROXIMITY_CONTRACT, FACT_CONTRACT, PROOF_CONTRACT)
    if guarded and not ids:
        moments["maxItems"] = 0
        schema["properties"]["summaryCitationIds"]["maxItems"] = 0
    for kind in ("observations", "hypotheses"):
        claims = moments["items"]["properties"][kind]
        if kind == "hypotheses" and contract == PROOF_CONTRACT:
            ids_for_uncertainty = [row["id"] for row in proofs.uncertainty_catalog(spans)]
            if ids_for_uncertainty:
                claims["items"]["enum"] = ids_for_uncertainty
            else:
                claims["maxItems"] = 0
            continue
        eligible = [row["id"] for row in spans if language.uncertainty_bases(row["text"])]
        selected = eligible if kind == "hypotheses" and contract != LEGACY_CONTRACT else ids
        if guarded:
            if selected:
                claims["items"]["properties"]["citationIds"]["items"]["enum"] = selected
            elif kind == "hypotheses":
                claims["maxItems"] = 0
        else:
            claims["items"]["properties"]["citationIds"]["items"]["enum"] = selected or ["no-explicit-uncertainty" if kind == "hypotheses" and contract != LEGACY_CONTRACT else "no-source-span"]
    if contract != LEGACY_CONTRACT:
        if ids or not guarded:
            schema["properties"]["summaryCitationIds"]["items"]["enum"] = ids or ["no-source-span"]
    if contract in (FACT_CONTRACT, PROOF_CONTRACT):
        cues = [row["id"] for row in facts.career_cues(spans)]
        schema["properties"]["omittedCueIds"]["maxItems"] = len(cues)
        if cues:
            schema["properties"]["omittedCueIds"]["items"]["enum"] = cues
    if contract == PROOF_CONTRACT:
        props = moments["items"]["properties"]
        date_ids = [row["id"] for row in dates.catalog(spans, source_context)]
        for side in ("start", "end"):
            props[side + "DateRef"]["enum"] = [None] + date_ids
        props["factType"]["enum"] = ["life-event"] + [row["factType"] for row in proofs.fact_catalog(spans)]
        if ids:
            props["factTypeCitationIds"]["items"]["enum"] = ids
    return schema


def _project_v1(value, content):
    """Resolve IDs locally; never repair or retry a contradictory legacy output."""
    if not isinstance(content, str):
        raise ValueError("Grounded extraction requires the exact supplied passage")
    if not isinstance(value, dict) or set(value) != set(SCHEMA_V1["required"]):
        raise ValueError("Invalid grounded objective result shape")
    if value["emptyAssessment"] not in ("no-life-event", "uncertain"):
        raise ValueError("Invalid empty passage assessment")
    if not isinstance(value["moments"], list):
        raise ValueError("Moments must be an array")
    spans = {row["id"]: row for row in catalog(content)}
    moments, mappings = [], []
    for index, raw in enumerate(value["moments"]):
        if not isinstance(raw, dict) or set(raw) != set(MODEL_MOMENT["required"]):
            raise ValueError("Invalid grounded moment shape")
        quotes, observations, hypotheses = [], [], []
        for kind, maximum, texts in (("observations", 6, observations), ("hypotheses", 4, hypotheses)):
            claims = raw[kind]
            if not isinstance(claims, list) or len(claims) > maximum or kind == "observations" and not claims:
                raise ValueError("Invalid grounded " + kind)
            for number, claim in enumerate(claims):
                if not isinstance(claim, dict) or set(claim) != {"text", "citationIds"} \
                        or not isinstance(claim["text"], str) or not claim["text"].strip() or len(claim["text"]) > 600:
                    raise ValueError("Invalid grounded claim")
                ids = claim["citationIds"]
                if not isinstance(ids, list) or not 1 <= len(ids) <= 20 \
                        or any(not isinstance(key, str) or key not in spans for key in ids) or len(ids) != len(set(ids)):
                    raise ValueError("Every grounded claim must select known distinct source spans")
                texts.append(claim["text"])
                selected = []
                for key in ids:
                    span = spans[key]
                    exact = content[span["start"]:span["end"]]
                    if exact not in quotes:
                        quotes.append(exact)
                    selected.append({"id": key, "start": span["start"], "end": span["end"]})
                mappings.append({"path": f"moments/{index}/{kind}/{number}", "text": claim["text"],
                                 "sourceSpans": selected})
        moment = {k: copy.deepcopy(v) for k, v in raw.items() if k not in ("observations", "hypotheses")}
        # The rationale is assembled rather than freely generated: an inference
        # is never folded into the observations or presented as corroboration.
        moment.update(description="\n".join(observations), quotes=quotes,
                      rationale="Observations citées :\n" + "\n".join(observations) +
                      "\nHypothèses à vérifier :\n" + ("\n".join(hypotheses) if hypotheses else "Aucune proposée."),
                      relationHints=["Hypothèse à vérifier : " + text for text in hypotheses])
        moments.append(moment)
    result = {"summary": value["summary"], "classification": "life-events" if moments else value["emptyAssessment"],
              "moments": moments, "gaps": copy.deepcopy(value["gaps"])}
    change = {"path": "", "contract": LEGACY_CONTRACT, "reason": "Source-span selection; classification derived from the event list; observations and hypotheses kept separate.",
              "claims": mappings, "emptyAssessmentUsed": not bool(moments)}
    return result, [change]


def project(value, content, contract=None, source_context=None):
    items = value.get('moments') if isinstance(value, dict) else None
    if contract == CONTRACT or not contract and isinstance(value, dict) and 'abstention' in value:
        if not isinstance(content, str):
            raise ValueError('Grounded extraction requires the exact supplied passage')
        return useful_selection.project(value, content, {r['id']: r for r in catalog(content)}, source_context, SCHEMA_V7, CONTRACT)
    if contract == SOURCE_CONTRACT or not contract and isinstance(items, list) and any(
            isinstance(m, dict) and 'titleCitationId' in m for m in items):
        if not isinstance(content, str):
            raise ValueError('Grounded extraction requires the exact supplied passage')
        return source_observations.project(value, content, {r['id']: r for r in catalog(content)}, source_context, SCHEMA_V7, SOURCE_CONTRACT)
    if contract == LEGACY_CONTRACT or not contract and isinstance(value, dict) and "summary" in value:
        return _project_v1(value, content)
    if not isinstance(content, str):
        raise ValueError("Grounded extraction requires the exact supplied passage")
    if not contract:
        items = value.get("moments", []) if isinstance(value, dict) else []
        contract = CONDITIONAL_CONTRACT if isinstance(items, list) and any(isinstance(m, dict) and "startDateRef" in m for m in items) \
            else FACT_CONTRACT if isinstance(value, dict) and "omittedCueIds" in value else PROXIMITY_CONTRACT
    schema = SCHEMA_V6 if contract == CONDITIONAL_CONTRACT else SCHEMA_V5 if contract == PROOF_CONTRACT else SCHEMA_V4 if contract == FACT_CONTRACT else SCHEMA_V3
    if not isinstance(value, dict) or set(value) != set(schema["required"]) or not isinstance(value["moments"], list):
        raise ValueError("Invalid grounded objective result shape")
    spans = {row["id"]: row for row in catalog(content)}
    if contract in (PROOF_CONTRACT, CONDITIONAL_CONTRACT):
        rows = contextual.catalog(list(spans.values())) if contract == CONDITIONAL_CONTRACT else None
        converted, proof, date_quotes = proofs.convert(value, spans, source_context, content, uncertainty_rows=rows)
        result, changes = project(converted, content, PROXIMITY_CONTRACT)
        for moment, ids in zip(result["moments"], date_quotes):
            for key in ids:
                if spans[key]["text"] not in moment["quotes"]:
                    moment["quotes"].append(spans[key]["text"])
        changes[0].update(contract=contract, factPolicy=proof,
                          reason="Dates selected from literal evidence with separate communication/event scope; proposed fact types require cited cues; uncertainty references carry their admissible categories. Source wording and human review preserved.")
        if contract == CONDITIONAL_CONTRACT:
            changes[0]['reason'] += " Fact-type-specific generation choices; conditions require an explicit clause, not an isolated name token."
        return result, changes
    if contract == FACT_CONTRACT:
        converted, proof = facts.convert(value, spans, source_context, content)
        result, changes = project(converted, content, PROXIMITY_CONTRACT)
        changes[0].update(contract=FACT_CONTRACT, factPolicy=proof,
                          reason="Useful career cues cited or retained for review; concrete uncertainty assembled from fact type, occurrence, source scope and dates. Literal summary and source hypotheses; personal proximity requires human review.")
        return result, changes
    converted = copy.deepcopy(value)
    converted["summary"], summary_proof = language.summary(converted.pop("summaryCitationIds"), spans,
                                                         len(converted["moments"]), converted["emptyAssessment"])
    for moment in converted["moments"]:
        if not isinstance(moment, dict) or not isinstance(moment.get("hypotheses"), list):
            raise ValueError("Invalid grounded moment shape")
        if contract != WORDING_CONTRACT and moment.get("subject") not in ("owner", "thirdparty", "unknown"):
            raise ValueError("Personal proximity requires human review; use thirdparty or unknown")
        moment["hypotheses"] = [language.hypothesis(item, spans) for item in moment["hypotheses"]]
    result, changes = _project_v1(converted, content)
    changes[0].update(contract=contract, summary=summary_proof,
                      reason="Whole source excerpts in summary; only explicitly expressed source uncertainty, without generated hypotheses.")
    if contract != WORDING_CONTRACT:
        changes[0]["reason"] += " Personal proximity is reserved for human review."
    return result, changes
