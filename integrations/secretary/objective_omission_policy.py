"""Source-conditioned omission choices; lexical support never proves meaning.

Confident dismissal of a personal cue as administrative is unavailable. Quoted
speakers need their nearest literal header, not a borrowed or following author.
Uncertain choices remain available without forcing a biography or an identity.
"""
import copy
import re

from objective_schema import field
from evidence_attribution import FORWARDED, PARTIAL_REPLY
import objective_useful_selection as selection

ADMIN = re.compile(r'\b(?:imp[oô]ts?|fiscal\w*|factures?|invoices?|formulaires?|'
                   r'attestations?|copies?\s+PDF|administrati\w*|tax\s+(?:forms?|returns?))\b', re.I)
NONBIO = re.compile(r'\b(?:brochure|newsletter|publicit[eé]|promotionnel\w*|'
                    r'fiction|ficti[fhv]\w*|exemple\s+(?:invent[eé]|fictif)|template|advertisement)\b', re.I)
NEGATION = re.compile(r"\b(?:pas|jamais|aucun\w*|sans|not|never|no)\b|\bn['’]", re.I)
GREETING = re.compile(r'^(?:bonjour|bonsoir|salut|merci|bonne\s+(?:journ[eé]e|soir[eé]e)|'
                      r'hello|hi|thanks|thank\s+you)[\s!.,:;:)\-]*$', re.I)
SPEAKER = re.compile(r'^[\s>]*(?:(?:From|De)\s*:\s*(.*)|((?:Le|On)\s+.+(?:a\s+[eé]crit|wrote)\s*:))$', re.I)


def _owner_header(text, aliases):
    return any(re.search(r'(?<!\w)' + re.escape(alias.strip()) + r'(?!\w)', text, re.I)
               for alias in aliases if isinstance(alias, str) and alias.strip())


def catalog(spans, context=None):
    """Exact cue/whole-passage alternatives, rebuilt identically during replay."""
    rows = []
    cues = selection.cues(spans)
    context = context if isinstance(context, dict) else {}
    aliases = context.get('ownerAliases', [])
    aliases = aliases if isinstance(aliases, list) else []
    headers, current = {}, None
    for span in spans:
        match = SPEAKER.match(span['text'])
        if match:
            author = match.group(1) if match.group(1) is not None else match.group(2)
            current = span if author.strip() and aliases and not _owner_header(span['text'], aliases) else None
        elif FORWARDED.match(span['text']) or PARTIAL_REPLY.match(span['text']):
            current = None
        headers[span['id']] = current

    def add(scope, reason, evidence, cue=None):
        unique = {s['id']: s for s in evidence}
        selected = sorted(unique.values(), key=lambda s: s['start'])
        rows.append({'id': 'r' + str(len(rows) + 1), 'scope': scope, 'citationId': cue,
                     'reasonCode': reason, 'contextCitationIds': [s['id'] for s in selected],
                     'sourceSpans': [{k: s[k] for k in ('id', 'start', 'end', 'text')} for s in selected],
                     'qualification': 'source-supported-option-only-human-review-required'})

    for cue in cues:
        # Neither an administrative noun elsewhere nor a document title can
        # dismiss a line that has been flagged as potentially biographical.
        if NONBIO.search(cue['text']) and not NEGATION.search(cue['text']):
            add('cue', 'non-biographical-context', [cue], cue['id'])
        header = headers[cue['id']]
        if header and header['id'] != cue['id']:
            add('cue', 'other-person-context', [cue, header], cue['id'])
        for reason in ('ambiguous-actor', 'insufficient-event-context'):
            add('cue', reason, [cue], cue['id'])

    # A whole-passage confident reason may not borrow an unrelated marker to
    # cover unresolved personal cues. Such negatives must remain uncertain.
    if not cues:
        admin = next((s for s in spans if ADMIN.search(s['text']) and not NEGATION.search(s['text'])), None)
        nonbio = next((s for s in spans if NONBIO.search(s['text']) and not NEGATION.search(s['text'])), None)
        if not nonbio and spans and all(GREETING.fullmatch(s['text'].strip()) for s in spans):
            nonbio = spans[0]
        if admin:
            add('passage', 'administrative-context', [admin])
        if nonbio:
            add('passage', 'non-biographical-context', [nonbio])
    if spans:
        if cues:
            add('passage', 'insufficient-event-context', cues[:3])
        else:
            for reason in ('ambiguous-actor', 'insufficient-event-context'):
                add('passage', reason, spans[:1])
    else:
        add('passage', 'no-readable-source', [])
    return rows


def _choice(ids=None):
    return field(minLength=1, maxLength=20, **({'enum': ids} if ids else {}))


def _object(props):
    return {'type': 'object', 'additionalProperties': False,
            'properties': props, 'required': list(props)}


def schema(template, spans=None, context=None):
    rows = None if spans is None else catalog(spans, context)
    cue_ids = None if spans is None else [s['id'] for s in selection.cues(spans)]
    generic = _object({'citationId': _choice(), 'reasonRef': _choice()})
    branches = []
    for source in template['anyOf']:
        branch = copy.deepcopy(source)
        props = branch['properties']
        omissions = props['omittedCues']
        omissions['items'] = {'anyOf': [_object({'citationId': _choice([key]),
            'reasonRef': _choice([r['id'] for r in rows if r['scope'] == 'cue' and r['citationId'] == key])})
            for key in cue_ids]} if cue_ids else generic
        if props['abstention'].get('type') != 'null':
            uncertain = props['emptyAssessment']['enum'] == ['uncertain']
            ids = None if rows is None else [r['id'] for r in rows if r['scope'] == 'passage'
                                             and (r['reasonCode'] in selection.UNCERTAIN) == uncertain]
            if ids == []:
                continue
            props['abstention'] = _object({'reasonRef': _choice(ids)})
        branches.append(branch)
    return {'anyOf': branches}


def project(value, content, spans, context, base_schema, contract):
    if not isinstance(value, dict) or not isinstance(value.get('omittedCues'), list):
        raise ValueError('Coherent omission choices require a structured result')
    rows = {r['id']: r for r in catalog(list(spans.values()), context)}

    def resolve(ref, scope, cue=None):
        row = rows.get(ref) if isinstance(ref, str) else None
        if not row or row['scope'] != scope or row['citationId'] != cue:
            raise ValueError('Omission reason must select its own source-conditioned catalog entry')
        return row

    converted = copy.deepcopy(value)
    decisions = []
    for item in value['omittedCues']:
        if not isinstance(item, dict) or set(item) != {'citationId', 'reasonRef'}:
            raise ValueError('Omissions select a cue and its reason reference, never a free reason code')
        row = resolve(item['reasonRef'], 'cue', item['citationId'])
        decisions.append(row)
    converted['omittedCues'] = [{'citationId': r['citationId'], 'reasonCode': r['reasonCode'],
                                'contextCitationIds': r['contextCitationIds']} for r in decisions]
    abstention = value.get('abstention')
    negative = None
    if abstention is not None:
        if not isinstance(abstention, dict) or set(abstention) != {'reasonRef'}:
            raise ValueError('Abstention selects an exact whole-passage reason reference')
        negative = resolve(abstention['reasonRef'], 'passage')
        converted['abstention'] = {'reasonCode': negative['reasonCode'], 'citationIds': negative['contextCitationIds']}
    result, changes = selection.project(converted, content, spans, context, base_schema, contract)
    changes[0]['omissionPolicy'] = {'contract': 'secretary.source-conditioned-omissions/v1',
                                  'selectedReasons': decisions + ([negative] if negative else []),
                                  'semanticAcceptance': 'not-established'}
    changes[0]['reason'] += ' Omission reasons selected from cue-specific source context; administrative dismissal of personal cues unavailable and quoted-speaker context retained.'
    return result, changes
