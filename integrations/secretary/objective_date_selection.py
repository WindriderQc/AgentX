"""V16 date choices carry their explicitly selected observation into the fact.

Legacy catalogues and projections keep their default behavior for replay. No
output is repaired: validate the native selection before translating its fields.
"""
import copy
import re

import objective_date_evidence as dates
import objective_omission_policy as policy
import objective_selection_schema as wire
import objective_selection_projection as projection
import objective_source_observations as observations
import objective_source_selection as selection

CONTRACT = 'secretary.objective-grounding/v16'
HEADER = re.compile(r"^\s*(?:>\s*)*(?:date\s+d['’]envoi|envoy[ée](?:\s+le)?|sent(?:\s+on)?)\s*:", re.I)
POLICY = selection.POLICY.replace(selection.CONTRACT, CONTRACT).replace(
    'startDateRef, endDateRef,', 'startDateSelection, endDateSelection,').replace(
    'Date references select dateCatalog.',
    'Each startDateSelection/endDateSelection is null or {reference, observation}. '
    'Select reference from dateCatalog. An event date requires its own exact '
    '{citationId, qualificationIds} observation in that selection, even when it '
    'is a supporting excerpt distinct from the primary anchor. This explicitly '
    'selected excerpt becomes an observation of THIS fact. Keep its local '
    'qualifications consistent with other selections of the same excerpt. '
    'A date elsewhere in the page is not evidence of this event by proximity. '
    'A communication date has observation:null and is allowed only as the start '
    'of career-contact, application or work-correspondence; never as a life-event '
    'date or an end date. Date d’envoi, Date, Sent and Envoyé headers date '
    'communications, including quoted headers. When unknown, select null.')


def catalog(spans, context=None):
    by_id = {s['id']: s for s in spans}
    result = dates.catalog(spans, context)
    for row in result:
        if row['citationId'] and HEADER.match(by_id[row['citationId']]['text']):
            row['kind'] = 'communication'
    return result + [r for r in selection.partial_dates(spans)
                     if not HEADER.match(by_id[r['citationId']]['text'])]


def _choices(fields, rows, side, spans):
    if rows is None:
        return {'anyOf': [{'type': 'null'}, policy._object({
            'reference': {'type': 'string', 'minLength': 1},
            'observation': {'anyOf': [{'type': 'null'}, observations._observation()]}})]}
    options = [{'type': 'null'}]
    allowed_refs = fields[side + 'DateRef'].get('enum', [])
    contexts = fields['contextObservations']
    available = contexts['items'].get('anyOf', []) if contexts.get('maxItems') != 0 else []
    anchor_ids = fields['anchorCitationId'].get('enum', [])
    qualifications = observations.qualification_catalog(spans)
    for row in rows:
        if row['id'] not in allowed_refs:
            continue
        if row['kind'] == 'communication':
            if side != 'start' or not set(fields['factType']['enum']) <= dates.COMMUNICATION_TYPES:
                continue
            obs = {'type': 'null'}
        else:
            key = row['citationId']
            if key in anchor_ids:
                refs = [q['id'] for q in qualifications if q['citationIds'] == [key]]
                obs = observations._observation([key], refs)
            else:
                candidate = next((o for o in available if key in o['properties']['citationId'].get('enum', [])), None)
                if candidate is None:
                    continue
                obs = copy.deepcopy(candidate)
                obs['properties']['citationId']['enum'] = [key]
        options.append(policy._object({'reference': {'type': 'string', 'enum': [row['id']]},
                                       'observation': obs}))
    return options[0] if len(options) == 1 else {'anyOf': options}


def schema(template, spans=None, context=None):
    result = copy.deepcopy(template)
    rows = None if spans is None else catalog(spans, context)
    for branch in wire.fact_options(result):
        fields = branch['properties']
        if 'startDateSelection' in fields:
            continue  # The retained root alternatives share their item schema.
        for side in ('start', 'end'):
            fields[side + 'DateSelection'] = _choices(fields, rows, side, spans)
            del fields[side + 'DateRef']
        branch['required'] = list(fields)
    return result


def uses_wire(value):
    return isinstance(value, dict) and any('startDateSelection' in m
        for m in value.get('retainedMoments', []) if isinstance(m, dict))


def project(value, content, spans, context, legacy_schema, source_template, *, selection_model=selection, contract=CONTRACT):
    span_list = list(spans.values())
    template = schema(wire.schema(legacy_schema, span_list, context, selection_model=selection_model), span_list, context)
    if not wire.matches(value, template):
        raise ValueError('Native date-selection result violates its frozen page schema')
    converted = copy.deepcopy(value)
    bindings = []
    for index, moment in enumerate(converted['retainedMoments']):
        seen = {moment['anchorCitationId']: moment['qualificationIds']}
        for obs in moment['contextObservations']:
            if obs['citationId'] in seen:
                raise ValueError('Context observations must be distinct')
            seen[obs['citationId']] = obs['qualificationIds']
        for side in ('start', 'end'):
            chosen = moment.pop(side + 'DateSelection')
            moment[side + 'DateRef'] = None if chosen is None else chosen['reference']
            if chosen is None:
                continue
            bindings.append({'momentIndex': index, 'side': side, **copy.deepcopy(chosen)})
            obs = chosen['observation']
            if obs is not None:
                key = obs['citationId']
                if key in seen and seen[key] != obs['qualificationIds']:
                    raise ValueError('Date observations require consistent excerpt qualifications')
                if key not in seen:
                    moment['contextObservations'].append(obs)
                    seen[key] = obs['qualificationIds']
    rows = catalog(span_list, context)
    result, changes = projection.project(converted, content, spans, context, legacy_schema,
        source_template, date_rows=[r for r in rows if r['kind'] != 'partial-event-expression'], contract=contract, selection_model=selection_model)
    changes[0]['dateSelection'] = {'contract': contract, 'nativeSelections': bindings,
                                  'dateCatalog': rows, 'locallyInventedObservations': 0}
    return result, changes
