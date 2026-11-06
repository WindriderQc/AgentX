"""Literal observations and excerpt-local reservations preserve source temporality.

Selection is not entailment, occurrence confirmation or owner approval. A
reservation on one excerpt never makes the other selected statements uncertain.
"""
import copy
import re

from objective_schema import field
import objective_claim_proofs as proofs
import objective_source_language as language
import objective_uncertainty_context as contextual

MAX_OBSERVATIONS = 10
SCOPE = 'cited-excerpt-only'
HISTORICAL_LIMIT = ("Présent et futur des extraits restent ceux de leurs locuteurs dans la source ; "
                    "ils n'établissent aucune continuité actuelle. Les dates relatives ne sont pas converties.")
SHORT_TYPES = {'career-contact': 'Contact professionnel', 'application': 'Candidature',
               'interview': 'Entretien', 'job-offer': 'Offre professionnelle',
               'employment-change': 'Transition professionnelle', 'work-activity': 'Activité de travail',
               'work-correspondence': 'Échange de travail'}
CATEGORIES = {'home': 'Logement', 'people': 'Personnes', 'work': 'Travail',
              'travel': 'Voyage', 'health': 'Santé', 'daily': 'Vie quotidienne'}


def qualification_catalog(spans):
    result = contextual.catalog(spans)
    by_id = {s['id']: s for s in spans}
    for row in result:
        span = by_id[row['citationIds'][0]]
        focus = {'start': span['start'], 'end': span['end'], 'text': span['text']}
        # A standalone parenthetical alternative is already a bounded source
        # reservation. Retain the entire parentheses, never cut a clause or
        # infer which past/future action it qualifies. Otherwise keep the line.
        if row['basis'] == 'condition':
            matches = [m for m in re.finditer(r'\([^()\r\n]*\)', span['text'])
                       if re.match(r'\(\s*(?:ou\s+)?si\b', m.group(), re.I) and contextual.has_condition(m.group())]
            markers = list(language.MARKERS['condition'].finditer(span['text']))
            if len(matches) == 1 and all(matches[0].start() <= m.start() < matches[0].end() for m in markers):
                match = matches[0]
                focus = {'start': span['start'] + match.start(), 'end': span['start'] + match.end(), 'text': match.group()}
        row['reservationSpan'] = focus
        row['scope'] = SCOPE
    return result


def _observation(ids=None, qualifications=None):
    row = {'type': 'object', 'additionalProperties': False,
           'properties': {'citationId': field(minLength=1, maxLength=20),
                          'qualificationIds': {'type': 'array', 'maxItems': 1,
                                               'items': field(minLength=1, maxLength=20)}},
           'required': ['citationId', 'qualificationIds']}
    if ids:
        row['properties']['citationId']['enum'] = ids
    if qualifications is not None:
        if qualifications:
            row['properties']['qualificationIds']['items']['enum'] = qualifications
        else:
            row['properties']['qualificationIds']['maxItems'] = 0
    return row


def schema(template, spans=None):
    result = copy.deepcopy(template)
    ids = None if spans is None else [s['id'] for s in spans]
    rows = None if spans is None else qualification_catalog(spans)
    alternatives = []
    if spans:
        qualified = {s['id']: [r['id'] for r in rows if r['citationIds'] == [s['id']]] for s in spans}
        plain = [key for key, refs in qualified.items() if not refs]
        if plain:
            alternatives.append(_observation(plain, []))
        alternatives.extend(_observation([key], refs) for key, refs in qualified.items() if refs)
    for branch in result['properties']['moments']['items']['anyOf']:
        props = branch['properties']
        for key in ('title', 'ongoing', 'hypotheses'):
            del props[key]
        props['titleCitationId'] = field(minLength=1, maxLength=20)
        if ids:
            props['titleCitationId']['enum'] = ids
        props['observations'] = {'type': 'array', 'minItems': 1, 'maxItems': MAX_OBSERVATIONS,
                                 'items': {'anyOf': copy.deepcopy(alternatives)} if alternatives
                                 else _observation(ids, [] if spans is not None else None)}
        branch['required'] = list(props)
    return result


def _title(kind, category, span):
    label = SHORT_TYPES.get(kind, CATEGORIES.get(category, 'Proposition'))
    text = label + ' à relire : « ' + span['text'] + ' »'
    # Never shorten away a condition, negation or temporal qualifier.
    return text if len(text) <= 500 else label + ' à relire — voir les extraits complets'


def project(value, content, spans, context, template, contract):
    if not isinstance(value, dict) or set(value) != set(template['required']) \
            or value.get('emptyAssessment') not in ('no-life-event', 'uncertain') \
            or not isinstance(value.get('moments'), list):
        raise ValueError('Invalid source-selected objective result shape')
    required = set(template['properties']['moments']['items']['anyOf'][0]['required'])
    catalog = {r['id']: r for r in qualification_catalog(list(spans.values()))}
    converted = copy.deepcopy(value)
    selections, bindings, claims, titles = [], [], [], []
    for index, moment in enumerate(converted['moments']):
        if not isinstance(moment, dict) or set(moment) != required:
            raise ValueError('Source-selected moments cannot contain generated wording or global hypotheses')
        if not isinstance(moment['factType'], str) or moment['factType'] not in proofs.FACT_LABELS \
                or not isinstance(moment['category'], str) or moment['category'] not in CATEGORIES:
            raise ValueError('Unsupported proposed fact type or category')
        observations = moment['observations']
        if not isinstance(observations, list) or not 1 <= len(observations) <= MAX_OBSERVATIONS:
            raise ValueError('Observations require bounded exact excerpt selections')
        ids, local_bindings = [], []
        for number, observation in enumerate(observations):
            if not isinstance(observation, dict) or set(observation) != {'citationId', 'qualificationIds'}:
                raise ValueError('An observation selects an excerpt, never a temporal paraphrase')
            key = observation['citationId']
            selected = language.select([key], spans, minimum=1, maximum=1)[0]
            refs = observation['qualificationIds']
            if not isinstance(refs, list) or len(refs) > 1 \
                    or any(not isinstance(ref, str) or ref not in catalog for ref in refs):
                raise ValueError('An excerpt qualification requires a known reference')
            for ref in refs:
                row = catalog[ref]
                if row['citationIds'] != [key]:
                    raise ValueError('A qualification belongs only to its own cited excerpt')
                local_bindings.append({'path': f'moments/{index}/observations/{number}',
                                       'referenceId': ref, 'citationId': key, 'basis': row['basis'],
                                       'scope': SCOPE, 'sourceSpan': {k: selected[k] for k in ('start', 'end')},
                                       'reservationSpan': row['reservationSpan']})
            ids.append(key)
            claims.append({'path': f'moments/{index}/observations/{number}', 'text': selected['text'],
                           'sourceSpans': [{k: selected[k] for k in ('id', 'start', 'end')}]})
        selected = language.select(ids, spans, minimum=1, maximum=MAX_OBSERVATIONS)
        title_id = moment.pop('titleCitationId')
        if not isinstance(title_id, str) or title_id not in ids:
            raise ValueError('A title must select one of its own observation excerpts')
        titles.append({'citationId': title_id, 'sourceSpan': {k: spans[title_id][k] for k in ('start', 'end')}})
        moment['title'] = _title(moment['factType'], moment['category'], spans[title_id])
        moment['ongoing'] = False
        moment['observations'] = [{'text': s['text'], 'citationIds': [s['id']]} for s in selected]
        # Reservations are projected below at their exact excerpt, never fed to
        # the frozen event-wide uncertainty projection.
        moment['hypotheses'] = []
        selections.append(selected)
        bindings.append(local_bindings)
    converted, fact_proof, date_quotes = proofs.convert(converted, spans, context, content, uncertainty_rows=[])
    summary, summary_proof = language.summary(converted['summaryCitationIds'], spans,
                                               len(converted['moments']), converted['emptyAssessment'])
    moments = []
    for index, (moment, selected, local, date_ids) in enumerate(zip(converted['moments'], selections, bindings, date_quotes)):
        if moment.get('subject') not in ('owner', 'thirdparty', 'unknown'):
            raise ValueError('Personal proximity requires human review; use thirdparty or unknown')
        result = {k: copy.deepcopy(v) for k, v in moment.items() if k not in ('observations', 'hypotheses')}
        description = '\n'.join('[' + s['id'] + '] « ' + s['text'] + ' »' for s in selected)
        hints = ['Réserve de l’extrait ' + b['citationId'] + ' uniquement (contexte source) : ' +
                 language.LABELS[b['basis']] + ' : « ' + b['reservationSpan']['text'] + ' »' for b in local]
        rationale = 'Extraits sélectionnés dans leur contexte source :\n' + description + \
                    '\nRéserves de portée locale :\n' + ('\n'.join(hints) if hints else 'Aucune sélectionnée.')
        display = 'complete-excerpts'
        if len(rationale) > 8000:
            rationale = 'Observations : voir la description et les citations complètes.\nRéserves locales :\n' + \
                        ('\n'.join(hints) if hints else 'Aucune sélectionnée.')
            display = 'description-reference'
        quotes = list(dict.fromkeys([s['text'] for s in selected] + [spans[key]['text'] for key in date_ids]))
        result.update(description=description, quotes=quotes, rationale=rationale, relationHints=hints,
                      uncertainty=result['uncertainty'] + ' ' + HISTORICAL_LIMIT)
        if local:
            result['uncertainty'] += ' Chaque réserve concerne son seul extrait ; aucune incertitude globale sur les autres observations n’en est déduite.'
        detail = fact_proof['facts'][index]
        detail.update(uncertainty=result['uncertainty'], sourceQualifications=local,
                      titleSelection=titles[index], rationaleDisplay=display,
                      ongoingPolicy='no-current-continuation-inferred')
        moments.append(result)
    result = {'summary': summary, 'classification': 'life-events' if moments else converted['emptyAssessment'],
              'moments': moments, 'gaps': converted['gaps']}
    change = {'path': '', 'contract': contract,
              'reason': 'Exact source-selected observation/title wording; temporal expressions unaltered; reservations scoped to their own excerpts, never global event uncertainty; no current continuation inferred. Human review required.',
              'claims': claims, 'summary': summary_proof, 'factPolicy': fact_proof,
              'emptyAssessmentUsed': not bool(moments)}
    return result, [change]
