"""Bound date, proposed fact type and uncertainty choices to source evidence."""
import copy
import re

import objective_date_evidence as dates
import objective_fact_policy as legacy_facts
import objective_source_language as language

FACT_LABELS = {
    "life-event": "événement de vie",
    "career-contact": "prise de contact professionnelle ; aucun entretien, offre ou recrutement n'en est déduit",
    "application": "candidature ; ni acceptation ni recrutement ne sont établis par cet envoi",
    "interview": "entretien ; aucune offre ou prise de poste n'en est déduite",
    "job-offer": "offre professionnelle ; acceptation et prise de poste restent à vérifier",
    "employment-change": "transition professionnelle ; nature et réalisation restent à vérifier dans les citations",
    "work-activity": "activité ou suivi de travail ; aucun changement d'emploi n'en est déduit",
    "work-correspondence": "échange ou livraison de travail ; aucun changement d'emploi n'en est déduit",
}
TYPE_MARKERS = {
    "career-contact": re.compile(r"\b(?:CV|curriculum|contact|référ[ée]|referr|discuter|discuss)\b", re.I),
    "application": re.compile(r"\b(?:candidature|postul\w*|application\s+for|appl(?:y|ied)\s+for)\b", re.I),
    "interview": re.compile(r"\b(?:entretien\s+(?:d['’]embauche|de\s+recrutement)|interview)\b", re.I),
    "job-offer": re.compile(r"\b(?:offre\s+(?:d['’]emploi|de\s+poste)|proposition\s+d['’]embauche|job\s+offer)\b", re.I),
    "employment-change": re.compile(r"\b(?:embauch\w*|démission\w*|nouvel\s+emploi(?!\s+du\s+temps)|quitt\w*\s+(?:mon|son|le)\s+(?:poste|emploi)|fin\s+(?:de\s+mon|du)\s+contrat\s+(?:de\s+travail|d['’]emploi)|contrat\s+(?:de\s+travail|d['’]emploi)\s+(?:est\s+)?terminé|start(?:ed)?\s+(?:a\s+new\s+job|my\s+new\s+job))\b", re.I),
    "work-activity": re.compile(r"\b(?:travail|contrat|code|planificateur|projet|correction|modification|work|project|timesheet)\w*\b", re.I),
    "work-correspondence": re.compile(r"\b(?:envoi\w*|envoie\w*|transme\w*|voici|reç[ou]\w*|send|sent|deliver\w*)\b", re.I),
}


def fact_catalog(spans):
    result = []
    for kind, pattern in TYPE_MARKERS.items():
        ids = [s["id"] for s in spans if pattern.search(s["text"]) and
               (kind != "work-correspondence" or any(TYPE_MARKERS[k].search(s["text"])
                for k in ("work-activity", "career-contact")))]
        if ids:
            result.append({"factType": kind, "citationIds": ids, "qualification": "lexical-cue-only"})
    return result


def uncertainty_catalog(spans):
    result = []
    for span in spans:
        for basis in language.uncertainty_bases(span["text"]):
            result.append({"id": "u" + str(len(result) + 1), "basis": basis,
                           "citationIds": [span["id"]], "text": span["text"]})
    return result


def context_for(value):
    if not isinstance(value, dict):
        return value
    if isinstance(value.get("nativeRef"), dict):
        return {**value["nativeRef"], "mailDate": value.get("mailDate")}
    if isinstance(value.get("source"), dict):
        return {**{k: value.get(k) for k in ("offset", "end", "totalChars")},
                "mailDate": value["source"].get("mailDate")}
    return value


def convert(value, spans, context, content):
    result = copy.deepcopy(value)
    context = context_for(context)
    date_entries = {r["id"]: r for r in dates.catalog(list(spans.values()), context)}
    uncertainty_entries = {r["id"]: r for r in uncertainty_catalog(list(spans.values()))}
    kinds = {r["factType"]: r["citationIds"] for r in fact_catalog(list(spans.values()))}
    details, date_quotes = [], []
    for index, moment in enumerate(result["moments"]):
        if not isinstance(moment, dict) or any(k in moment for k in
                ("startDate", "endDate", "startPrecision", "endPrecision", "originalDate", "uncertainty")):
            raise ValueError("Dates and uncertainty must be resolved locally from supplied evidence")
        kind = moment.get("factType")
        if not isinstance(kind, str) or kind not in FACT_LABELS:
            raise ValueError("Unsupported proposed fact type")
        observed = set()
        if not isinstance(moment.get("observations"), list):
            raise ValueError("Proposed facts require cited observations")
        for claim in moment["observations"]:
            if not isinstance(claim, dict):
                raise ValueError("Proposed facts require cited observations")
            observed.update(s["id"] for s in language.select(claim.get("citationIds"), spans, minimum=1, maximum=20))
        type_ids = moment.pop("factTypeCitationIds", None)
        selected = language.select(type_ids, spans, maximum=20)
        if kind == "life-event":
            if selected:
                raise ValueError("A neutral life-event has no proposed career-type evidence")
        elif not selected or any(s["id"] not in observed or s["id"] not in kinds.get(kind, []) for s in selected):
            raise ValueError("A proposed fact type must select matching evidence in its own observations")
        if kind != "life-event" and moment.get("category") != "work":
            raise ValueError("A proposed work type must remain a work fact")
        hypotheses = moment.get("hypotheses")
        if not isinstance(hypotheses, list) or len(hypotheses) > 4 \
                or any(not isinstance(k, str) or k not in uncertainty_entries for k in hypotheses) \
                or len(hypotheses) != len(set(hypotheses)):
            raise ValueError("An uncertainty must select a known distinct categorized reference")
        moment["hypotheses"] = [{"basis": uncertainty_entries[k]["basis"],
                                  "citationIds": uncertainty_entries[k]["citationIds"][:]} for k in hypotheses]
        if "startDateRef" not in moment or "endDateRef" not in moment:
            raise ValueError("Both date reference selections must be explicit, including null")
        date_proof, quotes = dates.resolve(moment, date_entries, observed)
        date_quotes.append(quotes)
        # Reuse the frozen v4 separation/omission projection without trusting a
        # model's type as a locally certified fact.
        moment["factType"] = kind if kind in legacy_facts.FACT_TYPES else "life-event"
        details.append({"path": f"moments/{index}", "proposedFactType": kind,
                        "typeCitationIds": type_ids, "dates": date_proof,
                        "uncertaintyRefs": hypotheses[:]})
    converted, proof = legacy_facts.convert(result, spans, context, content)
    for moment, detail in zip(converted["moments"], details):
        scope = proof["scope"]
        neutral = dict(moment, factType="life-event")
        notes = legacy_facts.uncertainty(neutral, "life-event", scope)
        # Drop only the legacy type sentence, preserve its concrete limits.
        notes = notes.removeprefix(legacy_facts.FACT_TYPES["life-event"] + " ")
        notes = notes.replace("Source citée uniquement : aucune corroboration indépendante ni confirmation personnelle.",
                              "Cette lecture n'établit ni corroboration indépendante ni confirmation personnelle.")
        moment["uncertainty"] = "Nature proposée à relire : " + FACT_LABELS[detail["proposedFactType"]] + ". " + notes
        if any(d["kind"] == "communication" for d in detail["dates"]):
            moment["uncertainty"] += " La date sélectionnée date une communication, pas l'activité sous-jacente."
        detail["uncertainty"] = moment["uncertainty"]
    proof["facts"] = details
    return converted, proof, date_quotes
