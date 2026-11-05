"""Useful career steps and concrete source limits, never inferred achievements."""
import copy
import re

import objective_source_language as language

FACT_TYPES = {
    "life-event": "Portée limitée à l'événement décrit dans le passage cité.",
    "career-contact": "Prise de contact professionnelle ; ni entretien, offre ou embauche établis par cette démarche.",
    "application": "Candidature ou dépôt de CV ; acceptation et recrutement ne sont pas établis par cet envoi.",
    "interview": "Entretien ; aucune offre ou prise de poste n'en est déduite.",
    "job-offer": "Offre professionnelle ; acceptation et prise de poste ne sont pas déduites de l'offre.",
    "employment-change": "Changement professionnel explicitement mentionné ; sa réalisation reste celle indiquée par la source.",
}
CAREER = re.compile(r"\b(?:CV|curriculum\s+vit[aeæ]+|candidature|postul\w*|entretien\s+(?:d['’]embauche|de\s+recrutement)|interview|job\s+offer|offre\s+d['’]emploi)\b", re.I)
PERSONAL = re.compile(r"\b(?:je|j[’']|mon|ma|mes|nous|notre|I|my|we|our)\b", re.I)


def career_cues(catalog):
    """Reading cues only: lexical matches establish neither actor nor occurrence."""
    return [row for row in catalog if CAREER.search(row["text"]) and PERSONAL.search(row["text"])]


def source_scope(context, content):
    if context is None:
        return {"known": False}
    if not isinstance(context, dict):
        raise ValueError("Source scope must be a retained character range")
    scope = {key: context.get(key) for key in ("offset", "end", "totalChars")}
    if any(type(n) is not int for n in scope.values()) \
            or not 0 <= scope["offset"] <= scope["end"] <= scope["totalChars"] \
            or scope["end"] - scope["offset"] != len(content):
        raise ValueError("Source scope differs from the exact retained passage")
    return {"known": True, **scope,
            "partial": scope["offset"] > 0 or scope["end"] < scope["totalChars"]}


def uncertainty(moment, fact_type, scope):
    notes = [FACT_TYPES[fact_type],
             "Source citée uniquement : aucune corroboration indépendante ni confirmation personnelle."]
    if moment.get("startDate") is None:
        notes.append("Date de l'événement ou de la démarche non précisée.")
    if moment.get("endDate") is None and moment.get("ongoing"):
        notes.append("Date de fin inconnue ; la continuité actuelle n'est pas confirmée.")
    status = moment.get("occurrenceStatus")
    if status == "planned":
        notes.append("Projet, invitation ou demande : réalisation non confirmée.")
    elif status == "unknown":
        notes.append("Réalisation non établie par ce passage.")
    elif status == "cancelled":
        notes.append("Annulation rapportée ; aucune réalisation n'en est déduite.")
    elif status == "documented":
        notes.append("L'existence d'un document ne confirme pas l'activité qu'il évoque.")
    if moment.get("subject") == "unknown":
        notes.append("Identité de l'acteur non établie.")
    elif moment.get("subject") == "thirdparty":
        notes.append("Acteur tiers ; aucune proximité personnelle n'est établie par ce classement.")
    if moment.get("hypotheses"):
        notes.append("Questions, conditions ou possibilités citées à vérifier ; aucune réponse ou réalisation n'en est déduite.")
    if moment.get("claimType") == "hypothesis":
        notes.append("Interprétation proposée à vérifier, pas un fait confirmé.")
    if not scope["known"]:
        notes.append("Étendue complète de la représentation non établie.")
    elif scope["partial"]:
        notes.append(f"Passage partiel : caractères {scope['offset']} à {scope['end']} sur {scope['totalChars']} ; suite hors de cette lecture.")
    notes.append("Autres documents, pièces et représentations hors de ce passage non qualifiés par cette lecture.")
    return " ".join(notes)


def convert(value, spans, context, content):
    """Convert v4 to the frozen v3 representation; retain every selection decision."""
    converted = copy.deepcopy(value)
    omitted = converted.pop("omittedCueIds")
    cues = {row["id"]: row for row in career_cues(list(spans.values()))}
    selected_omissions = language.select(omitted, cues, maximum=len(cues))
    if not isinstance(converted.get("gaps"), list) or any(not isinstance(s, str) for s in converted["gaps"]):
        raise ValueError("Gaps must be source review notes")
    scope = source_scope(context, content)
    addressed, facts = set(), []
    for index, moment in enumerate(converted["moments"]):
        if not isinstance(moment, dict) or "uncertainty" in moment or "factType" not in moment:
            raise ValueError("Concrete uncertainty is assembled locally, never supplied as a confidence label")
        fact_type = moment.pop("factType")
        if not isinstance(fact_type, str) or fact_type not in FACT_TYPES:
            raise ValueError("Unsupported fact type")
        if fact_type != "life-event" and moment.get("category") != "work":
            raise ValueError("A career step must remain a work fact")
        observations = moment.get("observations")
        if not isinstance(observations, list):
            raise ValueError("Useful facts require cited observations")
        for claim in observations:
            if not isinstance(claim, dict) or not isinstance(claim.get("citationIds"), list):
                raise ValueError("Useful facts require cited observations")
            for key in claim["citationIds"]:
                if not isinstance(key, str) or key not in spans:
                    raise ValueError("Every grounded claim must select known distinct source spans")
                if key in cues:
                    addressed.add(key)
        moment["uncertainty"] = uncertainty(moment, fact_type, scope)
        facts.append({"path": f"moments/{index}", "factType": fact_type,
                      "uncertainty": moment["uncertainty"]})
    if set(omitted) & addressed:
        raise ValueError("A career cue cannot be both retained and omitted")
    if set(cues) - addressed - set(omitted):
        raise ValueError("A potentially useful career cue must be cited or explicitly retained for source review")
    for row in selected_omissions:
        converted["gaps"].append("Sélection professionnelle à relire, passage non retenu comme fait : « " + row["text"] + " »")
    proof = {"scope": scope, "facts": facts,
             "careerCues": [{"id": row["id"], "start": row["start"], "end": row["end"],
                             "disposition": "cited-observation" if row["id"] in addressed else "source-review-gap"}
                            for row in cues.values()]}
    return converted, proof
