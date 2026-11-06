"""Conservative clause checks for new uncertainty references, not source truth.

Frozen v2-v5 wording gates are deliberately unchanged. This newer gate only
removes ambiguous condition matches; it never manufactures an interpretation.
"""
import re

import objective_source_language as legacy

WORD = r"[^\W\d_]+(?:['’][^\W\d_]+)?"
SUBJECT = re.compile(r"^(?:(?:je|tu|il|elle|on|nous|vous|ils|elles|ce|cela|ça|"
                     r"I|you|he|she|it|we|they|there)\b\s+|j['’])" + WORD, re.I)
FINITE = (r"est|sont|sera|seront|était|étaient|a|ont|avait|avaient|"
          r"peut|peuvent|pourra|pourront|doit|doivent|devait|devront|"
          r"reste|restent|arrive|arrivent|vient|viennent|permet|permettent|"
          r"fonctionne|fonctionnent|coûte|coûtent|passe|passent|"
          r"is|are|was|were|will|would|can|could|has|have|does|do|"
          r"arrives|works|remains|permits|allows")
NOMINAL_CLAUSE = re.compile(r"^(?:" + WORD + r"\s+){1,6}(?:" + FINITE + r")\b", re.I)
INDIRECT_QUESTION = re.compile(r"(?:\b(?:demande|demandais|demandons|sais|sait|savons|"
                               r"savoir|ignore|ignorons|wonder|wondering|know|knows)\b)"
                               r"[^,;.!?:]{0,40}$", re.I)


def has_condition(text):
    for marker in legacy.MARKERS['condition'].finditer(text):
        prefix = text[max(0, marker.start() - 80):marker.start()]
        if INDIRECT_QUESTION.search(prefix):
            continue
        # A list item or proper-name token alone cannot supply a conditional
        # clause. Stop before the next clause/list boundary, without editing it.
        tail = re.split(r"[,;:.!?()\n\r]", text[marker.end():], maxsplit=1)[0].strip()
        if not tail:
            continue
        if marker.group().lower() not in ('si', 'if', 'unless'):
            # The longer explicit phrases already name a condition/reservation.
            return True
        if SUBJECT.match(tail) or NOMINAL_CLAUSE.match(tail):
            return True
    return False


def bases(text):
    return [basis for basis in legacy.uncertainty_bases(text)
            if basis != 'condition' or has_condition(text)]


def catalog(spans):
    result = []
    for span in spans:
        for basis in bases(span['text']):
            result.append({'id': 'u' + str(len(result) + 1), 'basis': basis,
                           'citationIds': [span['id']], 'text': span['text']})
    return result
