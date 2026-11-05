"""Bounded source wording for summaries and explicitly expressed uncertainty.

Literal selection prevents a generated paraphrase from strengthening these
fields. It does not establish truth, authorship or event-level entailment.
"""
import re

SUMMARY_LIMIT = 2000
UNCERTAINTY_LIMIT = 450
LABELS = {
    "question": "Question citée, sans en déduire de réponse",
    "condition": "Condition citée, sans en déduire la réalisation",
    "possibility": "Possibilité citée, sans en déduire la réalisation",
}
MARKERS = {
    "question": re.compile(r"\?(?=$|[\s»”\"')\]])"),
    "condition": re.compile(r"\b(?:si|à condition|sous réserve|if|unless|provided that)\b", re.I),
    "possibility": re.compile(r"\b(?:peut[- ]être|pourrai[st]|pourrions|pourraient|possible|possiblement|"
                              r"éventuelle?s?|maybe|might|perhaps|possibly|could)\b", re.I),
}


def uncertainty_bases(text):
    """A conservative lexical gate, never an inference about the source topic."""
    if len(text) > UNCERTAINTY_LIMIT:
        return []
    return [basis for basis, pattern in MARKERS.items() if pattern.search(text)]


def select(ids, spans, *, minimum=0, maximum=3):
    if not isinstance(ids, list) or not minimum <= len(ids) <= maximum \
            or any(not isinstance(key, str) or key not in spans for key in ids) or len(ids) != len(set(ids)):
        raise ValueError("Every wording selection must use known distinct source spans")
    return sorted((spans[key] for key in ids), key=lambda row: row["start"])


def summary(ids, spans, count, assessment):
    selected = select(ids, spans)
    if count:
        prefix = f"{count} proposition(s) à relire dans ce passage."
    else:
        prefix = "Aucun événement proposé dans ce passage."
        if assessment == "uncertain":
            prefix += " Interprétation incertaine."
    # Keep whole spans, including negations and conditions. If they cannot fit,
    # report only the extraction state; never silently shorten a source clause.
    text = prefix + (" Extrait(s) du passage :\n" + "\n".join("« " + row["text"] + " »" for row in selected) if selected else "")
    shown = bool(selected) and len(text) <= SUMMARY_LIMIT
    if len(text) > SUMMARY_LIMIT:
        text = prefix + " Consulter les observations et les citations complètes."
    return text, {"sourceSpans": [{"id": s["id"], "start": s["start"], "end": s["end"]} for s in selected],
                  "rendered": shown, "reason": "whole-source-spans" if shown else "size-limit" if selected else "no-excerpt-selected"}


def hypothesis(value, spans):
    if not isinstance(value, dict) or set(value) != {"basis", "citationIds"} \
            or not isinstance(value["basis"], str) or value["basis"] not in LABELS:
        raise ValueError("A source uncertainty cannot contain a generated interpretation")
    span = select(value["citationIds"], spans, minimum=1, maximum=1)[0]
    basis = value["basis"]
    if basis not in uncertainty_bases(span["text"]):
        raise ValueError("The selected source does not explicitly express this uncertainty")
    return {"text": LABELS[basis] + " : « " + span["text"] + " »", "citationIds": value["citationIds"][:]}
