"""V17 native primary observations and context-only selected-source copies."""
import copy
from types import SimpleNamespace

import objective_date_selection as dates
import objective_selection_schema as wire
import objective_source_observations as observations
import objective_source_repetition as repetitions
import objective_source_selection as base

CONTRACT = 'secretary.objective-grounding/v17'
POLICY = dates.POLICY.replace(dates.CONTRACT, CONTRACT).replace(
    'anchorCitationId, factType', 'primaryObservation, factType').replace(
    'qualificationIds and contextObservations.', 'contextObservations.') + (
    '\nEvery retained fact selects primaryObservation:{citationId,qualificationIds}; '
    'there are no top-level anchorCitationId or qualificationIds fields. A primary '
    'qualification must belong to that exact primary excerpt, never another line. '
    'Use readingContract:secretary.objective-grounding/v17. '
    'quotedSourceRepeatCatalog identifies literal quoted text already available in '
    'an earlier selected authored source. These excerpts remain usable as context '
    'but cannot anchor another primary fact or require another cue decision here. '
    'Other quoted events remain selectable with their own supported actors. '
    'Neither text overlap nor source chronology verifies identity or event truth.')


def catalog(spans, context=None):
    copies = {r['citationId'] for r in repetitions.catalog(spans, context)}
    return [r for r in base.catalog(spans, context) if r['id'] not in copies]


def omission_catalog(spans, context=None):
    copies = {r['citationId'] for r in repetitions.catalog(spans, context)}
    rows = [r for r in base.omission_catalog(spans, context)
            if r.get('scope') != 'cue' or r.get('citationId') not in copies]
    if copies and not ({s['id'] for s in spans} - base.excluded(spans, context) - copies):
        rows.append({'id': 'copy-context', 'scope': 'passage', 'reasonCode': 'selected-copy-context',
                     'sourceSpans': [copy.deepcopy(s) for s in spans if s['id'] in copies]})
    return rows


SELECTOR = SimpleNamespace(catalog=catalog, omission_catalog=omission_catalog,
    excluded=base.excluded, partial_dates=base.partial_dates, documents=base.documents,
    primary_excluded=lambda spans, ctx: {r['citationId'] for r in repetitions.catalog(spans, ctx)},
    selection=SimpleNamespace(UNCERTAIN=base.selection.UNCERTAIN, REASONS={**base.selection.REASONS,
        'selected-copy-context': 'citation déjà présente dans une autre source sélectionnée ; contexte uniquement'}))


def _primary(fields, spans):
    ids = fields['anchorCitationId'].get('enum')
    if spans is None:
        return observations._observation()
    refs = observations.qualification_catalog(spans)
    groups = {}
    for key in ids or []:
        own = tuple(r['id'] for r in refs if r['citationIds'] == [key])
        groups.setdefault(own, []).append(key)
    options = [observations._observation(keys, list(own)) for own, keys in groups.items()]
    return {'anyOf': options} if options else False


def schema(template, spans=None, context=None):
    result = copy.deepcopy(template)
    seen = set()
    for fact in list(wire.fact_options(result)):
        if id(fact) in seen:
            continue
        seen.add(id(fact));fields = fact['properties']
        fields['primaryObservation'] = _primary(fields, spans)
        del fields['anchorCitationId'];del fields['qualificationIds']
        fact['required'] = list(fields)
    for branch in result['anyOf']:
        branch['properties'] = {'readingContract': {'type': 'string', 'enum': [CONTRACT]}, **branch['properties']}
        branch['required'] = list(branch['properties'])
    return result


def project(value, content, spans, context, legacy_schema, source_template):
    rows = list(spans.values())
    template = schema(dates.schema(wire.schema(legacy_schema, rows, context, selection_model=SELECTOR),
                                  rows, context), rows, context)
    if not wire.matches(value, template):
        raise ValueError('Native primary-reading result violates its frozen page schema')
    converted = copy.deepcopy(value);converted.pop('readingContract')
    primary = []
    for i, fact in enumerate(converted['retainedMoments']):
        observation = fact.pop('primaryObservation')
        primary.append({'momentIndex': i, **copy.deepcopy(observation)})
        fact.update(anchorCitationId=observation['citationId'], qualificationIds=observation['qualificationIds'])
    result, changes = dates.project(converted, content, spans, context, legacy_schema, source_template,
                                     selection_model=SELECTOR, contract=CONTRACT)
    changes[0]['primaryReading'] = {'contract': CONTRACT, 'nativePrimaryObservations': primary,
        'quotedSourceRepeatCatalog': repetitions.catalog(rows, context), 'locallyInventedMoments': 0,
        'ownerConfirmation': False, 'semanticAcceptance': 'not-established'}
    return result, changes
