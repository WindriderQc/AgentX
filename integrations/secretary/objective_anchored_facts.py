"""Native facts own their primary excerpt, metadata and local qualifications.

Required cues retain their own model-proposed facts instead of borrowing an
unrelated moment's type or communication date. Proposed types are conditioned
on their primary source anchor; no independent evidence selector is generated.
Lexical support remains a reading aid, never semantic or owner confirmation.
"""
import copy
import re

from objective_schema import field
import objective_claim_proofs as proofs
import objective_cue_decisions as decisions
import objective_explicit_selection as explicit
import objective_omission_policy as policy
import objective_source_observations as observations
import objective_useful_selection as selection


def completed_home_ids(spans, context=None):
    declarations = {r['citationId'] for r in decisions.declarations(spans, context)
                    if r['ownerReadingContext']}
    result = set()
    for cue in selection.cues(spans):
        if cue['id'] not in declarations:
            continue
        for match in explicit.FINISHED.finditer(cue['text']):
            subject = re.sub(r'^(?:mon|ma|mes|notre|nos)\s+', '', match.group(), flags=re.I)
            if selection.TOPICS['home'].match(subject):
                result.add(cue['id'])
    return result


def _moments(templates, spans=None, context=None, cue=None):
    cue_ids = set() if spans is None else {s['id'] for s in selection.cues(spans)}
    eligible = None if spans is None else {r['factType']: set(r['citationIds']) for r in proofs.fact_catalog(spans)}
    ids = None if spans is None else [s['id'] for s in spans if s['id'] not in cue_ids] if cue is None else [cue]
    rows = None if spans is None else observations.qualification_catalog(spans)
    homes = set() if spans is None else completed_home_ids(spans, context)
    plans = set() if spans is None else {r['citationId'] for r in decisions.declarations(spans, context) if 'planSpan' in r}
    result = []
    for original in templates:
        moment = copy.deepcopy(original)
        props = moment['properties']
        kind = props['factType']['enum'][0]
        if cue in homes and kind != 'life-event':
            continue
        anchors = ids if eligible is None or kind == 'life-event' else [key for key in ids if key in eligible.get(kind, set())]
        if anchors == []:
            continue
        props.pop('factTypeCitationIds');props.pop('titleCitationId')
        props['anchorCitationId'] = policy._choice(anchors)
        refs = None if rows is None else [r['id'] for r in rows if cue is None or r['citationIds'] == [cue]]
        props['qualificationIds'] = observations._observation(qualifications=refs)['properties']['qualificationIds']
        if cue in homes:
            props['category']['enum'] = ['home']
            props['occurrenceStatus']['enum'] = ['reported']
        if cue in plans:
            props['occurrenceStatus']['enum'] = ['planned']
        props['contextObservations']['maxItems'] = min(props['contextObservations']['maxItems'], observations.MAX_OBSERVATIONS - 1)
        moment['properties'] = {'factType': props.pop('factType'), 'anchorCitationId': props.pop('anchorCitationId'), **props}
        moment['required'] = list(moment['properties'])
        result.append(moment)
    return {'anyOf': result} if result else policy._object({})


def schema(template, spans=None, context=None):
    cues = None if spans is None else selection.cues(spans)
    rows = None if spans is None else decisions.catalog(spans, context)
    result = []
    for original in template['anyOf']:
        branch = copy.deepcopy(original);props = branch['properties']
        previous = props.pop('moments');negative = previous.get('maxItems') == 0
        templates = previous['items']['anyOf']
        props['additionalMoments'] = {'type': 'array', 'maxItems': 0 if negative else decisions.MAX_MOMENTS,
                                      'items': _moments(templates, spans, context)}
        if not negative and cues == []:
            props['additionalMoments']['minItems'] = 1
        if spans is not None and all(s['id'] in {c['id'] for c in cues} for s in spans):
            props['additionalMoments']['maxItems'] = 0
        choices = {}
        for cue in cues or []:
            options = [] if negative else [policy._object({'retainedMoments': {
                'type': 'array', 'minItems': 1, 'maxItems': 10,
                'items': _moments(templates, spans, context, cue['id'])}})]
            reasons = [r['id'] for r in rows if r['scope'] == 'cue' and r['citationId'] == cue['id']]
            if reasons:
                options.append(policy._object({'reasonRef': policy._choice(reasons)}))
            if not options:
                break
            choices[cue['id']] = options[0] if len(options) == 1 else {'anyOf': options}
        if cues is not None and len(choices) != len(cues):
            continue
        props['cueDecisions'] = policy._object(choices)
        if cues is None:
            props['cueDecisions'] = {'type': 'object', 'additionalProperties': {'anyOf': [
                policy._object({'reasonRef': policy._choice()}), policy._object({'retainedMoments': {
                    'type': 'array', 'minItems': 1, 'maxItems': 10, 'items': _moments(templates)}})]}}
        branch['required'] = list(props)
        result.append(branch)
    return {'anyOf': result}


def project(value, content, spans, context, template, contract):
    required = {'additionalMoments', 'emptyAssessment', 'gaps', 'abstention', 'cueDecisions'}
    if not isinstance(value, dict) or set(value) != required or not isinstance(value['additionalMoments'], list) \
            or not isinstance(value['cueDecisions'], dict):
        raise ValueError('Anchored facts require their own native moment metadata, never borrowed moment indices')
    cues = {s['id'] for s in selection.cues(list(spans.values()))}
    if set(value['cueDecisions']) != cues:
        raise ValueError('Every useful cue needs exactly one source-anchored decision')
    expected = (set(template['properties']['moments']['items']['anyOf'][0]['required'])
                - {'observations', 'factTypeCitationIds', 'titleCitationId'}) | {
                    'contextObservations', 'anchorCitationId', 'qualificationIds'}
    kinds = {r['factType']: set(r['citationIds']) for r in proofs.fact_catalog(list(spans.values()))}
    homes = completed_home_ids(list(spans.values()), context)
    converted = {k: copy.deepcopy(value[k]) for k in ('emptyAssessment', 'gaps', 'abstention')}
    converted.update(moments=[], cueDecisions={})
    bindings = []

    def retain(native, cue=None):
        if not isinstance(native, dict) or set(native) != expected:
            raise ValueError('A native anchored fact cannot contain independent type evidence or a second title selector')
        anchor = native['anchorCitationId'];kind = native['factType']
        if not isinstance(anchor, str) or anchor not in spans or cue is not None and anchor != cue \
                or cue is None and anchor in cues:
            raise ValueError('A retained fact must use its own source anchor; additional facts cannot bypass cue decisions')
        if not isinstance(kind, str) or kind not in proofs.FACT_LABELS or kind != 'life-event' and anchor not in kinds.get(kind, set()):
            raise ValueError('A proposed fact type must be supported by its own primary source anchor')
        if anchor in homes and (kind != 'life-event' or native['category'] != 'home' or native['occurrenceStatus'] != 'reported'):
            raise ValueError('A completed home declaration owns a reported home event, never professional metadata')
        extra = native['contextObservations']
        if not isinstance(extra, list) or any(not isinstance(o, dict) or o.get('citationId') == anchor for o in extra):
            raise ValueError('The primary anchor is already selected; context observations cannot repeat it')
        result = copy.deepcopy(native);qualifications = result.pop('qualificationIds')
        result['titleCitationId'] = result.pop('anchorCitationId')
        result['factTypeCitationIds'] = [] if kind == 'life-event' else [anchor]
        if cue is None:
            result['contextObservations'].insert(0, {'citationId': anchor, 'qualificationIds': qualifications})
        index = len(converted['moments']);converted['moments'].append(result)
        bindings.append({'momentIndex': index, 'cueId': cue, 'anchorCitationId': anchor,
                         'factTypeCitationIds': result['factTypeCitationIds']})
        return {'momentIndex': index, 'qualificationIds': copy.deepcopy(qualifications)}

    for native in value['additionalMoments']:
        retain(native)
    for cue in sorted(cues, key=lambda key: spans[key]['start']):
        choice = value['cueDecisions'][cue]
        if not isinstance(choice, dict):
            raise ValueError('An anchored cue decision selects its own native facts or omission reason')
        if set(choice) == {'reasonRef'}:
            converted['cueDecisions'][cue] = copy.deepcopy(choice)
            continue
        moments = choice.get('retainedMoments')
        if set(choice) != {'retainedMoments'} or not isinstance(moments, list) or not 1 <= len(moments) <= 10:
            raise ValueError('Retained cues own bounded native facts, never arbitrary existing indices')
        converted['cueDecisions'][cue] = {'retentions': [retain(native, cue) for native in moments]}
    result, changes = decisions.project(converted, content, spans, context, template, contract)
    changes[0]['derivedCueBindings'] = changes[0].pop('cueDecisions')
    changes[0]['derivedCueBindings']['isNativeWireResult'] = False
    changes[0]['anchoredFacts'] = {'contract': 'secretary.source-anchored-facts/v1',
        'nativeCueDecisions': copy.deepcopy(value['cueDecisions']),
        'additionalMomentCount': len(value['additionalMoments']), 'bindings': bindings,
        'typeEvidencePolicy': 'primary-anchor-with-matching-lexical-type-support',
        'independentModelTypeEvidenceSelector': False, 'locallyInventedMoments': 0,
        'semanticAcceptance': 'not-established'}
    changes[0]['reason'] += ' Native facts own their primary excerpts and metadata; completed home declarations cannot borrow work types or communication dates. Proposed type evidence derives only from the same primary source anchor.'
    return result, changes
