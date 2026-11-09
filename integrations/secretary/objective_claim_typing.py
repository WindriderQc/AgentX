"""Distinguish literal source statements from proposed interpretations.

A direct source report or announced plan is not owner confirmation. Unknown
dates and local reservations keep their own evidence and never change that
distinction. Old native results retain their original claimType and projection.
"""
import copy

import objective_anchored_facts as anchored
import objective_cue_decisions as declarations

CONTRACT = 'secretary.source-claim-typing/v1'
KINDS = {'direct-source': 'direct', 'interpretation': 'hypothesis'}


def catalog(spans, context=None):
    return [{**row, 'sourceClaimType': 'direct-source',
             'typingBasis': 'explicit-plan' if 'planSpan' in row else 'explicit-declaration',
             'ownerConfirmation': False}
            for row in declarations.declarations(spans, context)]


def _moments(value):
    if not isinstance(value, dict):
        return
    additional = value.get('additionalMoments')
    if isinstance(additional, list):
        for index, moment in enumerate(additional):
            yield f'additionalMoments/{index}', moment
    choices = value.get('cueDecisions')
    if isinstance(choices, dict):
        for key, choice in choices.items():
            selected = choice.get('retainedMoments') if isinstance(choice, dict) else None
            if isinstance(selected, list):
                for index, moment in enumerate(selected):
                    yield f'cueDecisions/{key}/retainedMoments/{index}', moment


def uses_wire(value):
    return any(isinstance(moment, dict) and 'sourceClaimType' in moment for _, moment in _moments(value))


def schema(template, spans=None, context=None):
    result = copy.deepcopy(template)
    direct = set() if spans is None else {r['citationId'] for r in catalog(spans, context)}

    def visit(node):
        if isinstance(node, list):
            for child in node:
                visit(child)
        elif isinstance(node, dict):
            props = node.get('properties')
            if isinstance(props, dict) and 'anchorCitationId' in props and 'claimType' in props:
                keys = props['anchorCitationId'].get('enum', [])
                props.pop('claimType')
                props['sourceClaimType'] = {'type': 'string', 'enum': ['direct-source']
                    if keys and set(keys) <= direct else list(KINDS)}
                node['required'] = list(props)
            for child in node.values():
                if isinstance(child, (dict, list)):
                    visit(child)

    visit(result)
    return result


def project(value, content, spans, context, template, contract):
    rows = catalog(list(spans.values()), context)
    direct = {row['citationId'] for row in rows}
    converted = copy.deepcopy(value)
    selected = []
    for path, moment in _moments(converted):
        if not isinstance(moment, dict) or 'claimType' in moment:
            raise ValueError('Source claim typing cannot accept an independent legacy confidence label')
        kind = moment.pop('sourceClaimType', None)
        if not isinstance(kind, str) or kind not in KINDS:
            raise ValueError('Select direct-source or interpretation; neither choice confirms a personal fact')
        anchor = moment.get('anchorCitationId')
        explicit = isinstance(anchor, str) and anchor in direct
        if explicit and kind != 'direct-source':
            raise ValueError('An explicit source declaration is direct-source; unknown dates or pending owner review do not make it an interpretation')
        moment['claimType'] = KINDS[kind]
        selected.append({'path': path, 'anchorCitationId': anchor, 'sourceClaimType': kind,
                         'canonicalClaimType': KINDS[kind], 'explicitDeclarationCue': explicit})
    result, changes = anchored.project(converted, content, spans, context, template, contract)
    facts = changes[0]['anchoredFacts']
    facts['projectionInputCueDecisions'] = facts.pop('nativeCueDecisions')
    facts['nativeCueDecisions'] = copy.deepcopy(value['cueDecisions'])
    facts['legacyClaimTypeDerivedFromNativeSourceChoice'] = True
    changes[0]['claimTyping'] = {'contract': CONTRACT, 'sourceCatalog': rows, 'selections': selected,
        'typingScope': 'source-wording-not-world-or-owner-confirmation',
        'localReservationsPreserved': True, 'ownerConfirmation': False,
        'semanticAcceptance': 'not-established'}
    changes[0]['reason'] += ' Claim typing describes explicit source wording versus interpretation, independently of personal confirmation. Reported activities and announced plans keep local reservations, unknown dates and mandatory review.'
    return result, changes
