"""Explicit per-cue model decisions, never local repair of a missing fact.

Each useful cue is a required schema property. Its model-selected retentions
bind the original excerpt to existing proposed moments; omissions select their
own source-supported reason. Context observations cannot bypass this decision.
Earlier wire contracts and projections remain independently readable.
"""
import copy
import re

from objective_schema import field
import objective_explicit_selection as explicit
import objective_omission_policy as policy
import objective_source_observations as observations
import objective_useful_selection as selection

PLAN = re.compile(r"\b(?:je\s+(?:vais|pr[eé]vois|projette|envisage)|nous\s+(?:allons|pr[eé]voyons|"
                  r"projetons|envisageons)|on\s+(?:va|pr[eé]voit|envisage)|"
                  r"I\s+(?:will|plan|intend)|we\s+(?:will|plan|intend))\b", re.I)
MAX_MOMENTS = 1000


def declarations(spans, context=None):
    result = explicit.declarations(spans, context)
    known = {r['citationId'] for r in result}
    contexts = explicit.reading_contexts(spans, context)
    for cue in selection.cues(spans):
        # A later warning/question must not erase an earlier complete plan.
        prefix = re.split(r'[.!?]', cue['text'], maxsplit=1)[0].rstrip()
        if cue['id'] in known or not PLAN.search(prefix) or policy.NEGATION.search(prefix) \
                or policy.NONBIO.search(cue['text']) or not prefix.strip() \
                or not selection.cues([{**cue, 'text': prefix}]) \
                or observations.qualification_catalog([{**cue, 'text': prefix}]) \
                or cue['text'][len(prefix):].lstrip().startswith('?') or not prefix[PLAN.search(prefix).end():].strip():
            continue
        owner, basis, header = contexts[cue['id']]
        evidence = [cue] if header is None else [header, cue]
        result.append({'citationId': cue['id'], 'ownerReadingContext': owner, 'contextBasis': basis,
                       'contextCitationIds': [s['id'] for s in evidence],
                       'sourceSpans': [{k: s[k] for k in ('id', 'start', 'end', 'text')} for s in evidence],
                       'planSpan': {'start': cue['start'], 'end': cue['start'] + len(prefix), 'text': prefix},
                       'requiredOccurrenceStatus': 'planned',
                       'qualification': 'reported-plan-cue-not-verified-identity-or-realization'})
    return sorted(result, key=lambda r: next(s['start'] for s in spans if s['id'] == r['citationId']))


def catalog(spans, context=None):
    protected = {r['citationId'] for r in declarations(spans, context) if r['ownerReadingContext']}
    return [r for r in policy.catalog(spans, context) if not (
        r['scope'] == 'cue' and r['citationId'] in protected
        and r['reasonCode'] in ('ambiguous-actor', 'insufficient-event-context')
        or r['scope'] == 'passage' and protected)]


def _retention(refs=None):
    qualifications = {'type': 'array', 'maxItems': 1, 'items': policy._choice(refs)}
    if refs == []:
        qualifications['maxItems'] = 0
    return policy._object({'retentions': {'type': 'array', 'minItems': 1, 'maxItems': 10,
        'items': policy._object({'momentIndex': field('integer', minimum=0, maximum=MAX_MOMENTS - 1),
                                 'qualificationIds': qualifications})}})


def schema(template, spans=None, context=None):
    cues = None if spans is None else selection.cues(spans)
    cue_ids = set() if cues is None else {s['id'] for s in cues}
    rows = None if spans is None else catalog(spans, context)
    qualifications = [] if spans is None else observations.qualification_catalog(spans)
    result = []
    for original in template['anyOf']:
        branch = copy.deepcopy(original)
        props = branch['properties']
        del props['omittedCues']
        for moment in props['moments']['items']['anyOf']:
            fields = moment['properties']
            fields.pop('observations')
            available = None if spans is None else [s for s in spans if s['id'] not in cue_ids]
            options = [] if available is None else [observations._observation([s['id']],
                [r['id'] for r in qualifications if r['citationIds'] == [s['id']]]) for s in available]
            fields['contextObservations'] = {'type': 'array', 'maxItems': observations.MAX_OBSERVATIONS,
                'items': {'anyOf': options} if options else observations._observation()}
            if available == []:
                fields['contextObservations']['maxItems'] = 0
            moment['required'] = list(fields)
        props['moments']['maxItems'] = min(MAX_MOMENTS, props['moments'].get('maxItems', MAX_MOMENTS))
        decisions = {}
        for cue in cues or []:
            options = [] if props['moments'].get('maxItems') == 0 else [
                _retention([r['id'] for r in qualifications if r['citationIds'] == [cue['id']]])]
            reasons = [r['id'] for r in rows if r['scope'] == 'cue' and r['citationId'] == cue['id']]
            if reasons:
                options.append(policy._object({'reasonRef': policy._choice(reasons)}))
            if not options:
                break
            decisions[cue['id']] = options[0] if len(options) == 1 else {'anyOf': options}
        if cues is not None and len(decisions) != len(cues):
            continue
        props['cueDecisions'] = policy._object(decisions)
        if spans is None:
            props['cueDecisions'] = {'type': 'object', 'additionalProperties': {'anyOf': [
                _retention(), policy._object({'reasonRef': policy._choice()})]}}
        if rows is not None and props['abstention'].get('type') != 'null':
            uncertain = props['emptyAssessment']['enum'] == ['uncertain']
            ids = [r['id'] for r in rows if r['scope'] == 'passage'
                   and (r['reasonCode'] in selection.UNCERTAIN) == uncertain]
            if not ids:
                continue
            props['abstention'] = policy._object({'reasonRef': policy._choice(ids)})
        branch['required'] = list(props)
        result.append(branch)
    return {'anyOf': result}


def project(value, content, spans, context, template, contract):
    required = {'moments', 'emptyAssessment', 'gaps', 'abstention', 'cueDecisions'}
    if not isinstance(value, dict) or set(value) != required or not isinstance(value['moments'], list) \
            or len(value['moments']) > MAX_MOMENTS or not isinstance(value['cueDecisions'], dict):
        raise ValueError('Per-cue extraction requires explicit decisions and context-only observations')
    cue_ids = {s['id'] for s in selection.cues(list(spans.values()))}
    if set(value['cueDecisions']) != cue_ids:
        raise ValueError('Every useful cue needs exactly one explicit decision; missing or extra decisions are rejected')
    converted = copy.deepcopy(value)
    converted.pop('cueDecisions')
    converted['omittedCues'] = []
    for moment in converted['moments']:
        if not isinstance(moment, dict) or 'observations' in moment or not isinstance(moment.get('contextObservations'), list):
            raise ValueError('Cue observations come only from explicit retentions, never a parallel observation list')
        moment['observations'] = moment.pop('contextObservations')
        if any(not isinstance(o, dict) or not isinstance(o.get('citationId'), str)
               or o['citationId'] not in spans or o['citationId'] in cue_ids for o in moment['observations']):
            raise ValueError('Context observations cannot bypass a cue decision')
    allowed = {r['id']: r for r in catalog(list(spans.values()), context)}
    abstention = value['abstention']
    if abstention is not None and (not isinstance(abstention, dict) or set(abstention) != {'reasonRef'}
            or not isinstance(abstention['reasonRef'], str) or abstention['reasonRef'] not in allowed
            or allowed[abstention['reasonRef']]['scope'] != 'passage'):
        raise ValueError('A whole-passage abstention cannot erase an explicit declaration or plan')
    plans = {r['citationId']: r for r in declarations(list(spans.values()), context) if 'planSpan' in r}
    bindings = []
    for key, decision in value['cueDecisions'].items():
        if not isinstance(decision, dict):
            raise ValueError('A cue decision selects retentions or its own omission reference')
        if set(decision) == {'reasonRef'}:
            ref = decision['reasonRef']
            row = allowed.get(ref) if isinstance(ref, str) else None
            if not row or row['scope'] != 'cue' or row['citationId'] != key:
                raise ValueError('A cue omission must select its own supported reason; complete declarations cannot use blanket ambiguity')
            converted['omittedCues'].append({'citationId': key, 'reasonRef': ref})
            continue
        retentions = decision.get('retentions')
        if set(decision) != {'retentions'} or not isinstance(retentions, list) or not 1 <= len(retentions) <= 10:
            raise ValueError('A retained cue needs bounded explicit moment assignments')
        seen = set()
        for retention in retentions:
            if not isinstance(retention, dict) or set(retention) != {'momentIndex', 'qualificationIds'}:
                raise ValueError('A retention selects a moment index and local qualification references')
            index = retention['momentIndex']
            if type(index) is not int or not 0 <= index < len(converted['moments']) or index in seen:
                raise ValueError('A retained cue must bind a distinct existing moment, never create one locally')
            seen.add(index)
            moment = converted['moments'][index]
            if key in plans and moment.get('occurrenceStatus') != 'planned':
                raise ValueError('An explicit future plan cannot become a reported realization')
            moment['observations'].append({'citationId': key, 'qualificationIds': retention['qualificationIds']})
            bindings.append({'citationId': key, 'momentIndex': index,
                             'qualificationIds': copy.deepcopy(retention['qualificationIds'])})
    for moment in converted['moments']:
        moment['observations'].sort(key=lambda o: spans[o['citationId']]['start'])
    # v10 already validates exact observations, dates, types, titles and summaries.
    # New plan omissions are checked above; other choices are its frozen subset.
    result, changes = explicit.project(converted, content, spans, context, template, contract)
    changes[0]['cueDecisions'] = {'contract': 'secretary.explicit-cue-decisions/v1',
        'requiredCitationIds': sorted(cue_ids, key=lambda k: spans[k]['start']),
        'modelDecisions': copy.deepcopy(value['cueDecisions']), 'retainedBindings': bindings,
        'planDeclarations': list(plans.values()), 'semanticAcceptance': 'not-established',
        'locallyCreatedMoments': 0}
    changes[0]['reason'] += ' Every useful cue has an explicit native retention or source-backed omission; assignments bind existing proposed moments without repairing absent decisions. Explicit future plans remain planned.'
    return result, changes
