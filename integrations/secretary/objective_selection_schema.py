"""V15 keeps a nonempty native fact list separate from explicit omissions."""
import copy

import objective_omission_policy as policy
import objective_source_selection as selection


def fact_options(node):
    if isinstance(node, list):
        for child in node:
            yield from fact_options(child)
    elif isinstance(node, dict):
        if {'anchorCitationId', 'sourceClaimType'} <= node.get('properties', {}).keys():
            yield node
        else:
            for child in node.values():
                yield from fact_options(child)


def facts(template, spans=None, context=None):
    blocked = set() if spans is None else selection.excluded(spans, context)
    cues = {} if spans is None else {r['id']: r for r in selection.catalog(spans, context)}
    partial = [] if spans is None else selection.partial_dates(spans)
    options, seen = [], set()
    for original in fact_options(template):
        node = copy.deepcopy(original);p = node['properties']
        anchors = p['anchorCitationId'].get('enum')
        if anchors is not None:
            anchors = [a for a in anchors if a not in blocked]
            if not anchors:
                continue
            p['anchorCitationId']['enum'] = anchors
        # Split only where new activity cues impose a distinct policy.
        groups = [anchors] if anchors is None else [[a] for a in anchors]
        for group in groups:
            option = copy.deepcopy(node);fields = option['properties']
            if group is not None:
                fields['anchorCitationId']['enum'] = group
            cue = cues.get(group[0]) if group else None
            if cue and cue['sourceActivity']:
                if fields['factType']['enum'] != ['life-event']:
                    continue
                fields['category']['enum'] = ['daily']
            if cue and cue['directDeclaration']:
                fields['sourceClaimType']['enum'] = ['direct-source']
            if cue and cue['requiredOccurrenceStatus']:
                fields['occurrenceStatus']['enum'] = [cue['requiredOccurrenceStatus']]
            for side in ('start', 'end'):
                ref = fields[side + 'DateRef']
                if 'enum' in ref:
                    ref['enum'] += [r['id'] for r in partial if group is None or r['citationId'] in group]
            # Context is supporting text, never another required cue or signature.
            obs = fields['contextObservations'];available = obs['items'].get('anyOf')
            if available is not None:
                allowed = []
                for o in available:
                    o = copy.deepcopy(o)
                    ids = o['properties']['citationId'].get('enum', [])
                    ids = [k for k in ids if k not in blocked and k not in cues and (group is None or k not in group)]
                    if ids:
                        o['properties']['citationId']['enum'] = ids;allowed.append(o)
                obs['items'] = {'anyOf': allowed} if allowed else policy._object({})
                if not allowed:
                    obs['maxItems'] = 0
            key = repr(option)
            if key not in seen:
                seen.add(key);options.append(option)
    return {'anyOf': options} if options else False


def schema(template, spans=None, context=None):
    rows = None if spans is None else selection.catalog(spans, context)
    reasons = None if spans is None else selection.omission_catalog(spans, context)
    documents = None if spans is None else selection.documents(context)
    items = facts(template, spans, context)
    branches = []
    for outcome in ('retained', 'no-life-event', 'uncertain'):
        negative = outcome != 'retained'
        if not negative and items is False:
            continue
        decisions = {}
        for row in rows or []:
            options = [] if negative else [policy._object({'retained': {'type': 'boolean', 'enum': [True]}})]
            if row['omissionChoices']:
                options.append(policy._object({'reasonRef': policy._choice([r['id'] for r in row['omissionChoices']])}))
            if not options:
                break
            decisions[row['id']] = options[0] if len(options) == 1 else {'anyOf': options}
        if rows is not None and len(decisions) != len(rows):
            continue
        ids = None if reasons is None else [r['id'] for r in reasons if r.get('scope') == 'passage'
                    and (r['reasonCode'] in selection.selection.UNCERTAIN) == (outcome == 'uncertain')]
        if negative and ids == []:
            continue
        props = {'retainedMoments': {'type': 'array', 'minItems': 0 if negative else 1,
                                    'maxItems': 0 if negative else 1000, 'items': items},
                 'cueDecisions': policy._object(decisions) if rows is not None else {'type': 'object'},
                 'documentDecisions': policy._object({r['id']: {'type': 'string', 'enum': ['retain-reference', 'omit']}
                    for r in documents}) if documents is not None else {'type': 'object'},
                 'emptyAssessment': {'type': 'string', 'enum': ['uncertain', 'no-life-event'] if not negative else [outcome]},
                 'abstention': policy._object({'reasonRef': policy._choice(ids)}) if negative else {'type': 'null'},
                 'gaps': {'type': 'array', 'items': {'type': 'string'}}}
        branches.append(policy._object(props))
    return {'anyOf': branches}


def matches(value, schema):
    """Check the closed JSON Schema subset emitted above, including booleans.

    The native decoder remains advisory; local validation also runs when it
    ignores its format. No coercion, repair, network or third-party dependency.
    """
    if isinstance(schema, bool):
        return schema
    if 'anyOf' in schema and not any(matches(value, s) for s in schema['anyOf']):
        return False
    types = {'null': value is None, 'boolean': type(value) is bool, 'integer': type(value) is int,
             'string': isinstance(value, str), 'array': isinstance(value, list), 'object': isinstance(value, dict)}
    kind = schema.get('type')
    if kind is not None and not any(types.get(k, False) for k in (kind if isinstance(kind, list) else [kind])):
        return False
    if 'enum' in schema and not any(type(value) is type(v) and value == v for v in schema['enum']):
        return False
    if isinstance(value, (str, list)):
        lo, hi = ('minLength', 'maxLength') if isinstance(value, str) else ('minItems', 'maxItems')
        if len(value) < schema.get(lo, 0) or len(value) > schema.get(hi, float('inf')):
            return False
    if isinstance(value, list) and any(not matches(v, schema.get('items', {})) for v in value):
        return False
    if isinstance(value, dict):
        props = schema.get('properties', {})
        if not set(schema.get('required', [])) <= value.keys():
            return False
        extra = schema.get('additionalProperties', True)
        if extra is False and not value.keys() <= props.keys():
            return False
        if any(not matches(v, props.get(k, extra if isinstance(extra, dict) else {})) for k, v in value.items()):
            return False
    return True
