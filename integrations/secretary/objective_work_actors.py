"""Explicit work selection and source-bound actors for new extraction results.

Earlier contracts stay frozen. Reading context supports a proposed attribution,
never verified identity; unresolved speakers are retained as unknown actors.
"""
import copy
import re

import objective_claim_typing as typing
import objective_claim_proofs as proofs
import objective_explicit_selection as explicit
import objective_omission_policy as policy
import objective_useful_selection as selection

CONTRACT = 'secretary.work-actor-selection/v1'
REPORT = re.compile(r"\bj['’]ai\s+(?:pass[eé]|travaill[eé]|consacr[eé]|envoy[eé]|livr[eé]|"
                    r"termin[eé]|r[eé]alis[eé])\b|\bI\s+(?:worked|spent|sent|delivered|completed)\b|"
                    r"\bvoici\s+(?:ma|mon|mes|notre|nos|la|le)\b|"
                    r"\b(?:here\s+is|attached\s+is)\s+(?:my|our|the)\b", re.I)
LABELS = {k: selection.REASONS[k] for k in ('ambiguous-actor', 'other-person-context',
          'insufficient-event-context', 'non-biographical-context')}


def actors(spans, context=None):
    rows = []
    for key, (owner, basis, header) in explicit.reading_contexts(spans, context).items():
        evidence = [s for s in spans if s['id'] == key or header and s['id'] == header['id']]
        subjects = ['owner', 'thirdparty', 'unknown'] if owner else (
            ['thirdparty', 'unknown'] if basis == 'quoted-speaker' else ['unknown'])
        rows.append({'citationId': key, 'allowedSubjects': subjects, 'contextBasis': basis,
                     'sourceSpans': evidence, 'identityVerified': False})
    return rows


def work_catalog(spans, context=None):
    contexts = explicit.reading_contexts(spans, context)
    existing = {s['id'] for s in selection.cues(spans)}
    types = proofs.fact_catalog(spans)
    rows = []
    for span in spans:
        kinds = [r['factType'] for r in types if r['factType'] in ('work-activity', 'work-correspondence')
                 and span['id'] in r['citationIds']]
        if span['id'] in existing or not kinds or not REPORT.search(span['text']):
            continue
        prefix = re.split(r'[.!?]', span['text'], maxsplit=1)[0]
        complete = bool(REPORT.search(prefix) and not policy.NEGATION.search(prefix)
                        and not policy.NONBIO.search(span['text'])
                        and not span['text'][len(prefix):].lstrip().startswith('?')
                        and not re.search(r'\b(?:si|if|peut[- ]être|maybe|might)\b', prefix, re.I))
        owner, basis, header = contexts[span['id']]
        evidence = [span] if header is None else [header, span]
        reasons = []
        if policy.NONBIO.search(span['text']):
            reasons.append('non-biographical-context')
        elif not owner:
            reasons.append('other-person-context' if basis == 'quoted-speaker' else 'ambiguous-actor')
        if not complete:
            reasons.append('insufficient-event-context')
        rows.append({'citationId': span['id'], 'factTypes': kinds, 'directDeclaration': complete,
                     'ownerReadingContext': owner, 'sourceSpans': evidence,
                     'requiredOccurrenceStatus': 'reported' if complete else None,
                     'omissionChoices': [{'id': 'w' + str(len(rows) + 1) + '-' + str(i + 1),
                         'reasonCode': reason, 'sourceSpans': evidence} for i, reason in enumerate(reasons)],
                     'qualification': 'reading-cue-not-verified-event-or-identity'})
    return rows


def omission_catalog(spans, context=None):
    protected = {r['citationId'] for r in typing.catalog(spans, context)
                 if r['contextBasis'] == 'unresolved-speaker'}
    return [r for r in typing.declarations.catalog(spans, context) if not (
        r['scope'] == 'cue' and r['citationId'] in protected
        and r['reasonCode'] in ('ambiguous-actor', 'insufficient-event-context'))]


def _restrict(node, actor_rows, work_ids, *, anchor=None, kinds=None, direct=False):
    """Condition each native fact on its own anchor before generation."""
    if isinstance(node, list):
        return [_restrict(n, actor_rows, work_ids, anchor=anchor, kinds=kinds, direct=direct) for n in node]
    if not isinstance(node, dict):
        return node
    node = copy.deepcopy(node)
    props = node.get('properties', {})
    if 'anchorCitationId' in props and 'sourceClaimType' in props:
        keys = props['anchorCitationId'].get('enum')
        keys = keys if anchor is None else [anchor] if keys is None or anchor in keys else []
        if keys is not None:
            keys = [k for k in keys if anchor is not None or k not in work_ids]
            if not keys:
                return False
            props['anchorCitationId']['enum'] = keys
        kind = props['factType']['enum'][0]
        if kinds is not None and kind not in kinds:
            return False
        if actor_rows is not None and keys:
            # Group only identical actor policies; keep schema growth bounded.
            branches = []
            groups = {}
            for key in keys:
                groups.setdefault(tuple(actor_rows[key]['allowedSubjects']), []).append(key)
            for subjects, anchors in groups.items():
                for subject in subjects:
                    branch = copy.deepcopy(node);p = branch['properties']
                    p['anchorCitationId']['enum'] = anchors;p['subject']['enum'] = [subject]
                    if subject == 'unknown':
                        p['subjectName'] = {'type': 'string', 'enum': ['']}
                    if direct:
                        p['sourceClaimType']['enum'] = ['direct-source']
                        p['occurrenceStatus']['enum'] = ['reported']
                    obs = p['contextObservations'];options = obs['items'].get('anyOf')
                    if options is not None:
                        options = [o for o in options if not set(o['properties']['citationId'].get('enum', [])) & work_ids]
                        obs['items'] = {'anyOf': options} if options else policy._object({})
                        if not options:
                            obs['maxItems'] = 0
                    branches.append(branch)
            return branches[0] if len(branches) == 1 else {'anyOf': branches}
        return node
    for key, child in list(node.items()):
        if isinstance(child, (dict, list)):
            node[key] = _restrict(child, actor_rows, work_ids, anchor=anchor, kinds=kinds, direct=direct)
    if 'anyOf' in node:
        node['anyOf'] = [n for n in node['anyOf'] if n is not False]
        if not node['anyOf']:
            return policy._object({})
    return node


def schema(template, spans=None, context=None):
    work = None if spans is None else work_catalog(spans, context)
    actor_rows = None if spans is None else {r['citationId']: r for r in actors(spans, context)}
    ids = set() if work is None else {r['citationId'] for r in work}
    allowed = None if spans is None else {r['id'] for r in omission_catalog(spans, context)}
    result = []
    for original in template['anyOf']:
        branch = copy.deepcopy(original);props = branch['properties']
        prototype = copy.deepcopy(props['additionalMoments']['items'])
        negative = props['abstention'].get('type') != 'null'
        choices = {}
        for row in work or []:
            options = [] if negative else [policy._object({'retainedMoments': {
                'type': 'array', 'minItems': 1, 'maxItems': 10,
                'items': _restrict(prototype, actor_rows, ids, anchor=row['citationId'],
                                   kinds=row['factTypes'], direct=row['directDeclaration'])}})]
            if row['omissionChoices']:
                options.append(policy._object({'reasonRef': policy._choice([r['id'] for r in row['omissionChoices']])}))
            if not options:
                break
            choices[row['citationId']] = options[0] if len(options) == 1 else {'anyOf': options}
        if work is not None and len(choices) != len(work):
            continue
        valid = True
        for key, cue in props['cueDecisions'].get('properties', {}).items():
            options = []
            for choice in cue.get('anyOf', [cue]):
                choice = copy.deepcopy(choice)
                ref = choice.get('properties', {}).get('reasonRef')
                if ref is not None:
                    ref['enum'] = [r for r in ref['enum'] if r in allowed]
                    if not ref['enum']:
                        continue
                options.append(choice)
            if not options:
                valid = False;break
            props['cueDecisions']['properties'][key] = options[0] if len(options) == 1 else {'anyOf': options}
        if not valid:
            continue
        branch = _restrict(branch, actor_rows, ids);props = branch['properties']
        if props['additionalMoments']['items'] == policy._object({}):
            props['additionalMoments']['maxItems'] = 0
        if work and not negative:
            props['additionalMoments'].pop('minItems', None)
        props['professionalDecisions'] = policy._object(choices) if work is not None else {
            'type': 'object', 'additionalProperties': {'anyOf': [policy._object({'reasonRef': policy._choice()}),
                policy._object({'retainedMoments': {'type': 'array', 'minItems': 1, 'maxItems': 10, 'items': prototype}})]}}
        branch['required'] = list(props);result.append(branch)
    return {'anyOf': result}


def project(value, content, spans, context, template, contract):
    required = {'professionalDecisions', 'additionalMoments', 'emptyAssessment', 'gaps', 'abstention', 'cueDecisions'}
    if not isinstance(value, dict) or set(value) != required or not isinstance(value['professionalDecisions'], dict) \
            or not isinstance(value['additionalMoments'], list) or not isinstance(value['cueDecisions'], dict):
        raise ValueError('Every professional cue needs an explicit native decision')
    source = list(spans.values());work = {r['citationId']: r for r in work_catalog(source, context)}
    if set(value['cueDecisions']) != {r['id'] for r in selection.cues(source)}:
        raise ValueError('Every original useful cue needs exactly one source-anchored decision')
    if set(value['professionalDecisions']) != set(work):
        raise ValueError('Every professional cue needs exactly one decision; missing work is not repaired')
    converted = copy.deepcopy(value);native_work = converted.pop('professionalDecisions')
    selected, decisions, omissions = [], [], []
    for key, row in work.items():
        choice = native_work[key]
        reasons = {r['id']: r for r in row['omissionChoices']}
        if isinstance(choice, dict) and set(choice) == {'reasonRef'}:
            reason = reasons.get(choice['reasonRef']) if isinstance(choice['reasonRef'], str) else None
            if reason is None:
                raise ValueError('Professional omission requires its own supported reason')
            omissions.append({'citationId': key, 'reasonCode': reason['reasonCode'],
                'label': LABELS[reason['reasonCode']], 'sourceSpans': reason['sourceSpans'],
                'qualification': 'model-proposed-reason-for-human-review'})
            continue
        facts = choice.get('retainedMoments') if isinstance(choice, dict) else None
        if not isinstance(choice, dict) or set(choice) != {'retainedMoments'} or not isinstance(facts, list) or not 1 <= len(facts) <= 10:
            raise ValueError('Professional decisions retain bounded own facts or a cited omission')
        for i, fact in enumerate(facts):
            if not isinstance(fact, dict) or fact.get('anchorCitationId') != key or fact.get('factType') not in row['factTypes'] \
                    or row['directDeclaration'] and (fact.get('sourceClaimType') != 'direct-source'
                    or fact.get('occurrenceStatus') != 'reported'):
                raise ValueError('Professional facts retain their own supported anchor, type and literal source choice')
            selected.append((f'professionalDecisions/{key}/retainedMoments/{i}', fact))
    if any(not isinstance(m, dict) or not isinstance(m.get('anchorCitationId'), str) for m in converted['additionalMoments']):
        raise ValueError('Additional facts require a known source anchor')
    if any(m['anchorCitationId'] in work for m in converted['additionalMoments']):
        raise ValueError('Additional facts cannot bypass professional decisions')
    selected += [(f'additionalMoments/{i}', m) for i, m in enumerate(converted['additionalMoments'])]
    allowed = {r['id'] for r in omission_catalog(source, context)}
    for key in sorted(converted['cueDecisions'], key=lambda k: spans[k]['start']):
        choice = converted['cueDecisions'][key]
        if not isinstance(choice, dict):
            raise ValueError('Each useful cue requires a source-anchored decision')
        if set(choice) == {'reasonRef'}:
            if not isinstance(choice['reasonRef'], str):
                raise ValueError('Omission choices require a known source reference')
            if choice['reasonRef'] not in allowed:
                raise ValueError('Unresolved identity cannot erase a complete source declaration; retain an unknown actor')
            continue
        retained = choice.get('retainedMoments')
        if set(choice) != {'retainedMoments'} or not isinstance(retained, list) or not 1 <= len(retained) <= 10:
            raise ValueError('A retained cue requires a bounded native fact list or its own omission')
        selected += [(f'cueDecisions/{key}/retainedMoments/{i}', m) for i, m in enumerate(retained)]
    actor_rows = {r['citationId']: r for r in actors(source, context)}
    for path, fact in selected:
        if not isinstance(fact, dict) or not isinstance(fact.get('anchorCitationId'), str):
            raise ValueError('Retained actors require a known primary source anchor')
        row = actor_rows.get(fact['anchorCitationId'])
        if row is None or fact.get('subject') not in row['allowedSubjects'] \
                or fact.get('subject') == 'unknown' and fact.get('subjectName') != '':
            raise ValueError('Unresolved source actors cannot become the owner or carry an asserted name')
        context_rows = fact.get('contextObservations')
        if not isinstance(context_rows, list) or any(not isinstance(o, dict) or not isinstance(o.get('citationId'), str) for o in context_rows):
            raise ValueError('Actor context requires known source observations')
        if any(o['citationId'] in work for o in context_rows):
            raise ValueError('Professional cue facts cannot be borrowed as another fact context')
        decisions.append({'nativePath': path, 'anchorCitationId': fact['anchorCitationId'],
                          'subject': fact['subject'], 'subjectName': fact['subjectName'],
                          'readingContext': row, 'identityVerified': False})
    count = sum(len(c.get('retainedMoments', [])) for c in native_work.values())
    converted['additionalMoments'] = [m for _, m in selected[:count]] + converted['additionalMoments']
    result, changes = typing.project(converted, content, spans, context, template, contract)
    proof = changes[0]
    proof['claimTyping']['projectionInputSelections'] = proof['claimTyping'].pop('selections')
    proof['workActorSelection'] = {'contract': CONTRACT, 'nativeProfessionalDecisions': copy.deepcopy(value['professionalDecisions']),
        'professionalCatalog': list(work.values()), 'actorBindings': decisions,
        'nativeSelectionsChanged': False, 'ownerConfirmation': False, 'semanticAcceptance': 'not-established'}
    proof['selectionReview']['cues'] += [{**{k: spans[key][k] for k in ('id', 'start', 'end')},
        'kinds': ['work'], 'qualification': 'reading-cue-only-not-an-event',
        'disposition': 'reasoned-omission' if key in {r['citationId'] for r in omissions} else 'cited-observation'} for key in work]
    proof['selectionReview']['omissions'] += omissions
    for row in omissions:
        result['gaps'].append('Sélection professionnelle à relire : ' + row['label'] + '. ' +
                              ' '.join('« ' + s['text'] + ' »' for s in row['sourceSpans']))
    proof['reason'] += ' Professional source cues require native own-fact decisions or cited omissions. Unresolved actors remain unknown, independently of direct source wording.'
    return result, changes
