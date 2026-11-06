"""Protect complete source declarations and summarize only retained observations.

Reading cues constrain omission claims; they create neither an event, an actor
identity nor an owner confirmation. Unknown speakers and speculative text keep
their conservative review paths. Earlier extraction contracts stay frozen.
"""
import copy
import re

from evidence_attribution import FORWARDED, PARTIAL_REPLY
import objective_omission_policy as policy
import objective_source_observations as observations
import objective_useful_selection as selection

DIRECT = re.compile(r"\bj['’](?:ai|habite|[eé]tudie)\b|\bje\s+(?:suis|vis|travaille|d[eé]bute|"
                    r"commence|pratique|termine)\b|\bnous\s+(?:avons|sommes)\b|\bon\s+(?:a|est)\b|"
                    r"\bI\s+(?:have|am|did|live|started)\b|\bwe\s+(?:have|are|did|started)\b", re.I)
FINISHED = re.compile(r'\b(?:mon|ma|mes|notre|nos)\s+[^.!?\r\n]{1,100}?\b(?:est|sont|[eé]tant)\s+'
                      r'(?:(?:bien|d[eé]j[aà]|enfin)\s+)?(?:termin[eé]\w*|fini\w*|achev[eé]\w*)\b', re.I)


def declarations(spans, context=None):
    context = context if isinstance(context, dict) else {}
    aliases = context.get('ownerAliases', [])
    aliases = aliases if isinstance(aliases, list) else []
    owner = bool(aliases and context.get('direction') == 'sent' and context.get('offset') == 0)
    basis, header = ('sent-container-reading-context' if owner else 'unresolved-speaker'), None
    contexts = {}
    for span in spans:
        match = policy.SPEAKER.match(span['text'])
        if match:
            owner = bool(aliases and policy._owner_header(span['text'], aliases))
            basis, header = ('owner-alias-header-reading-context' if owner else 'quoted-speaker'), span
        elif FORWARDED.match(span['text']) or PARTIAL_REPLY.match(span['text']) or span['text'].lstrip().startswith('>'):
            owner, basis, header = False, 'unresolved-speaker', None
        contexts[span['id']] = (owner, basis, header)
    reservations = {r['citationIds'][0] for r in observations.qualification_catalog(spans)}
    result = []
    for cue in selection.cues(spans):
        text = cue['text']
        if not (DIRECT.search(text) or FINISHED.search(text)) or policy.NEGATION.search(text) \
                or policy.NONBIO.search(text) or cue['id'] in reservations:
            continue
        owner, basis, header = contexts[cue['id']]
        evidence = [cue] if header is None or header['id'] == cue['id'] else [header, cue]
        result.append({'citationId': cue['id'], 'ownerReadingContext': owner, 'contextBasis': basis,
                       'contextCitationIds': [s['id'] for s in evidence],
                       'sourceSpans': [{k: s[k] for k in ('id', 'start', 'end', 'text')} for s in evidence],
                       'qualification': 'reported-declaration-cue-not-verified-identity-or-fact'})
    return result


def catalog(spans, context=None):
    protected = {r['citationId'] for r in declarations(spans, context) if r['ownerReadingContext']}
    return [r for r in policy.catalog(spans, context) if not (
        r['scope'] == 'cue' and r['citationId'] in protected
        and r['reasonCode'] in ('ambiguous-actor', 'insufficient-event-context')
        or r['scope'] == 'passage' and protected)]


def schema(template, spans=None, context=None):
    rows = None if spans is None else catalog(spans, context)
    result = []
    for original in template['anyOf']:
        branch = copy.deepcopy(original)
        props = branch['properties']
        del props['summaryCitationIds']
        branch['required'] = list(props)
        if rows is not None:
            keys = list(dict.fromkeys(r['citationId'] for r in rows if r['scope'] == 'cue'))
            choices = [policy._object({'citationId': policy._choice([key]), 'reasonRef': policy._choice(
                       [r['id'] for r in rows if r['scope'] == 'cue' and r['citationId'] == key])}) for key in keys]
            props['omittedCues']['maxItems'] = len(keys)
            props['omittedCues']['items'] = {'anyOf': choices} if choices else policy._object(
                {'citationId': policy._choice(), 'reasonRef': policy._choice()})
            if props['abstention'].get('type') != 'null':
                uncertain = props['emptyAssessment']['enum'] == ['uncertain']
                ids = [r['id'] for r in rows if r['scope'] == 'passage'
                       and (r['reasonCode'] in selection.UNCERTAIN) == uncertain]
                if not ids:
                    continue
                props['abstention'] = policy._object({'reasonRef': policy._choice(ids)})
        result.append(branch)
    return {'anyOf': result}


def project(value, content, spans, context, base_schema, contract):
    if not isinstance(value, dict) or 'summaryCitationIds' in value or not isinstance(value.get('moments'), list) \
            or not isinstance(value.get('omittedCues'), list):
        raise ValueError('Summaries select retained observations, never a separate global excerpt list')
    allowed = {r['id']: r for r in catalog(list(spans.values()), context)}
    selected = value['omittedCues'] + ([value['abstention']] if value.get('abstention') is not None else [])
    for row in selected:
        if not isinstance(row, dict) or not isinstance(row.get('reasonRef'), str) or row['reasonRef'] not in allowed:
            raise ValueError('A complete personal declaration cannot be omitted with an unsupported missing-context reason')
    converted = copy.deepcopy(value)
    summary = []
    for moment in converted['moments']:
        if not isinstance(moment, dict) or not isinstance(moment.get('observations'), list):
            raise ValueError('Retained facts require structured observations')
        if any(not isinstance(o, dict) or set(o) != {'citationId', 'qualificationIds'} for o in moment['observations']):
            raise ValueError('Summary wording comes from retained facts, never a separate observation annotation')
        key = moment.get('titleCitationId')
        if not isinstance(key, str) or key not in [o['citationId'] for o in moment['observations']]:
            raise ValueError('A summary title must belong to its own retained observations')
        if key not in summary and len(summary) < 3:
            summary.append(key)
    converted['summaryCitationIds'] = summary
    result, changes = policy.project(converted, content, spans, context, base_schema, contract)
    changes[0]['declarationSelection'] = {
        'contract': 'secretary.explicit-declaration-selection/v1',
        'readingCues': declarations(list(spans.values()), context), 'semanticAcceptance': 'not-established'}
    changes[0]['retainedSummary'] = {'contract': 'secretary.retained-observation-summary/v1',
                                    'citationIds': summary, 'selectionPolicy': 'first-three-distinct-retained-title-excerpts',
                                    'derivedOnlyFromRetainedObservations': True}
    changes[0]['reason'] += ' Complete personal declarations retain their source context; missing dates alone license no omission. Summary excerpts belong only to retained observations; abstention evidence stays separate.'
    return result, changes
