"""V15 keeps a nonempty native fact list separate from explicit omissions."""
import copy

import objective_omission_policy as policy
import objective_source_selection as selection
import objective_source_observations as observations


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


def facts(template, spans=None, context=None, *, selection_model=selection):
    selection = selection_model
    blocked = set() if spans is None else selection.excluded(spans, context)
    cues = {} if spans is None else {r['id']: r for r in selection.catalog(spans, context)}
    partial = [] if spans is None else selection.partial_dates(spans)
    primary_blocked = set() if spans is None else getattr(
        selection, 'primary_excluded', lambda spans, ctx: set())(spans, context)
    options, seen = [], set()
    for original in fact_options(template):
        node = copy.deepcopy(original);p = node['properties']
        anchors = p['anchorCitationId'].get('enum')
        if anchors is not None:
            anchors = [a for a in anchors if a not in blocked and a not in primary_blocked]
            if not anchors:
                continue
            p['anchorCitationId']['enum'] = anchors
        # Keep identical policies grouped. Copying the full context schema for
        # every ordinary line otherwise makes the native format grow quadratically.
        grouped = {}
        for anchor in anchors or []:
            row = cues.get(anchor, {})
            key = (bool(row.get('sourceActivity')), bool(row.get('directDeclaration')),
                   row.get('requiredOccurrenceStatus'),
                   tuple(r['id'] for r in partial if r['citationId'] == anchor))
            grouped.setdefault(key, []).append(anchor)
        groups = [None] if anchors is None else list(grouped.values())
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
                    ids = [k for k in ids if k not in blocked and k not in cues
                           and (group is None or len(group) > 1 or k not in group)]
                    if ids:
                        o['properties']['citationId']['enum'] = ids;allowed.append(o)
                obs['items'] = {'anyOf': allowed} if allowed else policy._object({})
                if not allowed:
                    obs['maxItems'] = 0
            # An earlier selected work cue may have been excluded by the frozen
            # work schema. In this reading policy it is context only, so retain
            # its own locally qualified observation rather than losing the quote.
            if primary_blocked:
                present = obs['items'].get('anyOf', []) if obs.get('maxItems') != 0 else []
                known = {key for o in present for key in o['properties']['citationId'].get('enum', [])}
                refs = observations.qualification_catalog(spans)
                extra = [observations._observation([key], [r['id'] for r in refs if r['citationIds'] == [key]])
                         for key in sorted(primary_blocked - blocked - known)]
                if extra:
                    obs['items'] = {'anyOf': [*present, *extra]}
                    if obs.get('maxItems') == 0:
                        obs['maxItems'] = observations.MAX_OBSERVATIONS - 1
            key = repr(option)
            if key not in seen:
                seen.add(key);options.append(option)
    return {'anyOf': options} if options else False


def schema(template, spans=None, context=None, *, selection_model=selection):
    selection = selection_model
    rows = None if spans is None else selection.catalog(spans, context)
    reasons = None if spans is None else selection.omission_catalog(spans, context)
    documents = None if spans is None else selection.documents(context)
    items = facts(template, spans, context, selection_model=selection)
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
