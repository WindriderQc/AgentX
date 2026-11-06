"""Disjoint fact-type choices constrain dates and type evidence at generation."""
import copy

import objective_claim_proofs as proofs
import objective_date_evidence as dates
import objective_uncertainty_context as uncertainty


def schema(template, spans=None, context=None):
    result = copy.deepcopy(template)
    moments = result['properties']['moments']
    base = moments['items']
    kinds = None if spans is None else {r['factType']: r['citationIds']
                                       for r in proofs.fact_catalog(spans)}
    date_rows = None if spans is None else dates.catalog(spans, context)
    uncertainty_ids = None if spans is None else [r['id'] for r in uncertainty.catalog(spans)]
    alternatives = []
    for kind in proofs.FACT_LABELS:
        if kinds is not None and kind != 'life-event' and kind not in kinds:
            continue
        branch = copy.deepcopy(base)
        props = branch['properties']
        props['factType']['enum'] = [kind]
        evidence = props['factTypeCitationIds']
        if kind == 'life-event':
            evidence.update(minItems=0, maxItems=0)
        else:
            evidence['minItems'] = 1
            props['category']['enum'] = ['work']
            if kinds is not None:
                evidence['maxItems'] = min(20, len(kinds[kind]))
                evidence['items']['enum'] = kinds[kind]
        if date_rows is not None:
            for side in ('start', 'end'):
                allowed = [row['id'] for row in date_rows if row['kind'] == 'event-expression'
                           or side == 'start' and kind in dates.COMMUNICATION_TYPES]
                props[side + 'DateRef']['enum'] = [None] + allowed
        if uncertainty_ids is not None:
            hypotheses = props['hypotheses']
            hypotheses['items'].pop('enum', None)
            if uncertainty_ids:
                hypotheses['items']['enum'] = uncertainty_ids
                hypotheses['maxItems'] = min(4, len(uncertainty_ids))
            else:
                hypotheses['maxItems'] = 0
        # The discriminator comes first in each grammar branch. All alternatives
        # remain complete closed objects; no unsupported if/then/allOf merging.
        branch['properties'] = {'factType': props.pop('factType'), **props}
        branch['required'] = list(branch['properties'])
        alternatives.append(branch)
    moments['items'] = {'anyOf': alternatives}
    return result
