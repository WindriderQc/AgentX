"""Useful-source reminders and cited reasons for omissions and abstentions.

Lexical cues are reading aids, never facts, actor identification or mandatory
events. Model-proposed reasons remain visible for source and owner review.
"""
import copy
import re

from objective_schema import field
import objective_fact_policy as legacy_facts
import objective_source_language as language
import objective_source_observations as observations

PERSONAL = re.compile(r"\b(?:je|mon|ma|mes|nous|notre|nos|I|my|we|our)\b|\bj['’](?=\w)|"
                      r"\bon\s+(?:va|a|est|fera|pr[eé]voit)\b", re.I)
TOPICS = {
    'home': r'\b(?:d[eé]m[eé]nag\w*|emm[eé]nag\w*|logement|nouvel\s+appartement|new\s+home|moved?\s+house)\b',
    'travel': r'\b(?:voyag\w*|s[eé]jour\w*|vacanc\w*|randonn\w*|trec?k\w*|hiking|hike|travel\w*|trip|plage|beach|snork\w*)\b',
    'leisure': r'\b(?:boxe|boxing|parachut\w*|sauts|escalade|climbing|marathon|concert|comp[eé]tition|tournament)\b',
    'study': r'\b(?:[eé]tud\w*|formation|dipl[oô]m\w*|universit\w*|graduat\w*)\b',
    'people': r'\b(?:mariag\w*|mari[eé]\w*|naissanc\w*|divorc\w*|d[eé]c[eè]s|married|wedding|newborn)\b',
    'health': r'\b(?:diagnosti\w*|op[eé]ration|chirurg\w*|hospitali\w*|surgery|diagnos\w*)\b',
    'plan': r'\b(?:je\s+(?:pr[eé]vois|projette|envisage)|nous\s+(?:pr[eé]voyons|projetons|envisageons)|'
            r'on\s+(?:pr[eé]voit|envisage)|I\s+(?:plan|intend)|we\s+(?:plan|intend))\b',
}
TOPICS = {kind: re.compile(pattern, re.I) for kind, pattern in TOPICS.items()}
REASONS = {
    'administrative-context': 'échange administratif sans événement personnel retenu',
    'other-person-context': 'contexte d’un autre acteur non retenu pour cet objectif personnel',
    'non-biographical-context': 'mention de contexte sans fait biographique retenu',
    'ambiguous-actor': 'acteur insuffisamment établi dans ce passage',
    'insufficient-event-context': 'éléments insuffisants pour caractériser un événement utile',
    'no-readable-source': 'aucun texte source lisible dans cette portée',
}
UNCERTAIN = {'ambiguous-actor', 'insufficient-event-context', 'no-readable-source'}


def cues(spans):
    career = {s['id'] for s in legacy_facts.career_cues(spans)}
    result = []
    for span in spans:
        kinds = ['career'] if span['id'] in career else []
        if PERSONAL.search(span['text']):
            kinds += [kind for kind, pattern in TOPICS.items() if pattern.search(span['text'])]
        if kinds:
            result.append({**span, 'kinds': kinds, 'qualification': 'reading-cue-only-not-an-event'})
    return result


def _ids(known=None, minimum=1, maximum=3):
    result = {'type': 'array', 'minItems': minimum, 'maxItems': maximum,
              'items': field(minLength=1, maxLength=20)}
    if known:
        result['items']['enum'] = known
    return result


def schema(template, spans=None):
    base = copy.deepcopy(template)
    props = base['properties']
    del props['omittedCueIds']
    cue_ids = None if spans is None else [s['id'] for s in cues(spans)]
    span_ids = None if spans is None else [s['id'] for s in spans]
    omission = {'type': 'object', 'additionalProperties': False,
                'properties': {'citationId': field(minLength=1, maxLength=20),
                               'reasonCode': field(enum=[k for k in REASONS if k != 'no-readable-source']),
                               'contextCitationIds': _ids(span_ids)},
                'required': ['citationId', 'reasonCode', 'contextCitationIds']}
    if cue_ids:
        omission['properties']['citationId']['enum'] = cue_ids
    props['omittedCues'] = {'type': 'array', 'maxItems': 1000 if cue_ids is None else len(cue_ids), 'items': omission}
    branches = []
    if spans is None or spans:
        positive = copy.deepcopy(base)
        positive['properties']['moments']['minItems'] = 1
        positive['properties']['abstention'] = {'type': 'null'}
        positive['required'] = list(positive['properties'])
        branches.append(positive)
    for uncertain in (False, True):
        reasons = [k for k in REASONS if (k in UNCERTAIN) == uncertain and
                   (spans is None or (bool(spans) and k != 'no-readable-source') or (not spans and k == 'no-readable-source'))]
        if not reasons:
            continue
        negative = copy.deepcopy(base)
        negative['properties']['moments']['maxItems'] = 0
        negative['properties']['emptyAssessment']['enum'] = ['uncertain' if uncertain else 'no-life-event']
        empty = spans is not None and not spans
        negative['properties']['abstention'] = {
            'type': 'object', 'additionalProperties': False,
            'properties': {'reasonCode': field(enum=reasons),
                           'citationIds': _ids(span_ids, minimum=0 if empty else 1, maximum=0 if empty else 3)},
            'required': ['reasonCode', 'citationIds']}
        negative['required'] = list(negative['properties'])
        branches.append(negative)
    return {'anyOf': branches}


def _evidence(reason, ids, spans, *, allow_empty=False):
    if not isinstance(reason, str) or reason not in REASONS:
        raise ValueError('An abstention or omission needs an allowed reason, never an unknown-date excuse')
    if reason == 'no-readable-source':
        if not allow_empty or spans or ids != []:
            raise ValueError('Readable source text cannot be justified as absent')
        selected = []
    else:
        selected = language.select(ids, spans, minimum=1, maximum=3)
    return {'reasonCode': reason, 'label': REASONS[reason],
            'sourceSpans': [{k: s[k] for k in ('id', 'start', 'end', 'text')} for s in selected],
            'qualification': 'model-proposed-reason-for-human-review'}


def _wording(decision):
    return decision['label'] + ('. Extrait(s) justificatif(s) : ' +
           '\n'.join('« ' + s['text'] + ' »' for s in decision['sourceSpans']) if decision['sourceSpans'] else '.')


def project(value, content, spans, context, base_schema, contract):
    required = (set(base_schema['required']) - {'omittedCueIds'}) | {'omittedCues', 'abstention'}
    if not isinstance(value, dict) or set(value) != required or not isinstance(value.get('moments'), list):
        raise ValueError('Invalid useful-selection objective result shape')
    addressed = set()
    for moment in value['moments']:
        if not isinstance(moment, dict) or not isinstance(moment.get('observations'), list):
            raise ValueError('Useful facts need exact observation selections')
        for observation in moment['observations']:
            if not isinstance(observation, dict) or not isinstance(observation.get('citationId'), str) \
                    or observation['citationId'] not in spans:
                raise ValueError('A useful observation must select a known source excerpt')
            addressed.add(observation['citationId'])
    cue_rows = cues(list(spans.values()))
    cue_ids = {s['id'] for s in cue_rows}
    omissions = value['omittedCues']
    if not isinstance(omissions, list) or len(omissions) > len(cue_ids):
        raise ValueError('Omissions must give bounded evidence-backed cue decisions')
    omitted, decisions = set(), []
    for row in omissions:
        if not isinstance(row, dict) or set(row) != {'citationId', 'reasonCode', 'contextCitationIds'} \
                or not isinstance(row['citationId'], str) or row['citationId'] not in cue_ids \
                or row['citationId'] in omitted:
            raise ValueError('Every omission must name one known distinct useful-source cue')
        key = row['citationId']
        decision = _evidence(row['reasonCode'], row['contextCitationIds'], spans)
        if key not in row['contextCitationIds']:
            raise ValueError('Omission evidence must include the cue being omitted')
        omitted.add(key)
        decisions.append({'citationId': key, **decision})
    if addressed & omitted:
        raise ValueError('A useful cue cannot be both cited and omitted')
    if cue_ids - addressed - omitted:
        raise ValueError('A potentially useful source cue must be cited or have an evidence-backed omission')
    abstention = value['abstention']
    decision = None
    if value['moments']:
        if abstention is not None:
            raise ValueError('A nonempty extraction cannot also declare abstention')
    else:
        if not isinstance(abstention, dict) or set(abstention) != {'reasonCode', 'citationIds'}:
            raise ValueError('Every abstention requires a cited reason')
        decision = _evidence(abstention['reasonCode'], abstention['citationIds'], spans, allow_empty=True)
        expected = 'uncertain' if decision['reasonCode'] in UNCERTAIN else 'no-life-event'
        if value['emptyAssessment'] != expected:
            raise ValueError('An ambiguous abstention must remain uncertain')
    converted = copy.deepcopy(value)
    converted.pop('abstention'); converted.pop('omittedCues')
    career_ids = {s['id'] for s in legacy_facts.career_cues(list(spans.values()))}
    converted['omittedCueIds'] = [row['citationId'] for row in decisions if row['citationId'] in career_ids]
    result, changes = observations.project(converted, content, spans, context, base_schema, contract)
    for row in decisions:
        result['gaps'].append('Indice utile non retenu, motif proposé à relire : ' + _wording(row))
    abstention_rendered = None
    if decision is not None:
        explanation = 'Motif d’abstention proposé à relire : ' + _wording(decision)
        result['gaps'].append(explanation)
        summary = result['summary'] + '\n' + explanation
        abstention_rendered = len(summary) <= 2000
        result['summary'] = summary if abstention_rendered else (
            ('Aucun événement proposé dans ce passage. Interprétation incertaine.'
             if result['classification'] == 'uncertain' else 'Aucun événement proposé dans ce passage.') +
            ' Motif proposé à relire : ' + decision['label'] + '. Consulter les extraits justificatifs dans les lacunes.')
    changes[0]['selectionReview'] = {
        'cues': [{k: row[k] for k in ('id', 'start', 'end', 'kinds', 'qualification')} |
                 {'disposition': 'cited-observation' if row['id'] in addressed else 'reasoned-omission'} for row in cue_rows],
        'omissions': decisions, 'abstention': decision, 'abstentionExcerptsRenderedInSummary': abstention_rendered}
    changes[0]['reason'] += ' Useful nonprofessional and career cues cited or omitted with source-backed proposed reasons; every abstention justified by exact source excerpts.'
    return result, changes
