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

LEGACY_CONTRACT = "secretary.objective-grounding/v1"
CONTRACT = "secretary.objective-grounding/v2"
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


def contract_for(manifest):
    digest = manifest.get("responseSchemaSha256")
    if digest == hashed(SCHEMA):
        return CONTRACT
    return LEGACY_CONTRACT if digest == hashed(SCHEMA_V1) else None


def catalog(content):
    """Each ID denotes one exact nonempty line, with Python character offsets."""
    result = []
    for match in re.finditer(r"[^\r\n]+", content):
        if match.group().strip():
            result.append({"id": "q" + str(len(result) + 1), "start": match.start(),
                           "end": match.end(), "text": match.group()})
    return result


def schema_for(content, contract=CONTRACT):
    schema = copy.deepcopy(SCHEMA_V1 if contract == LEGACY_CONTRACT else SCHEMA)
    # An empty passage has no selectable evidence. A fabricated moment still
    # fails local resolution even if a backend ignores the response schema.
    ids = [row["id"] for row in catalog(content)] or ["no-source-span"]
    for kind in ("observations", "hypotheses"):
        claim = schema["properties"]["moments"]["items"]["properties"][kind]["items"]
        eligible = [row["id"] for row in catalog(content) if language.uncertainty_bases(row["text"])]
        claim["properties"]["citationIds"]["items"]["enum"] = (eligible or ["no-explicit-uncertainty"]) if kind == "hypotheses" and contract != LEGACY_CONTRACT else ids
    if contract != LEGACY_CONTRACT:
        schema["properties"]["summaryCitationIds"]["items"]["enum"] = ids
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


def project(value, content, contract=None):
    if contract == LEGACY_CONTRACT or not contract and isinstance(value, dict) and "summary" in value:
        return _project_v1(value, content)
    if not isinstance(content, str):
        raise ValueError("Grounded extraction requires the exact supplied passage")
    if not isinstance(value, dict) or set(value) != set(SCHEMA["required"]) or not isinstance(value["moments"], list):
        raise ValueError("Invalid grounded objective result shape")
    spans = {row["id"]: row for row in catalog(content)}
    converted = copy.deepcopy(value)
    converted["summary"], summary_proof = language.summary(converted.pop("summaryCitationIds"), spans,
                                                         len(converted["moments"]), converted["emptyAssessment"])
    for moment in converted["moments"]:
        if not isinstance(moment, dict) or not isinstance(moment.get("hypotheses"), list):
            raise ValueError("Invalid grounded moment shape")
        moment["hypotheses"] = [language.hypothesis(item, spans) for item in moment["hypotheses"]]
    result, changes = _project_v1(converted, content)
    changes[0].update(contract=CONTRACT, summary=summary_proof,
                      reason="Whole source excerpts in summary; only explicitly expressed source uncertainty, without generated hypotheses.")
    return result, changes
