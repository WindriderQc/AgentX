"""Project native v15 choices without inventing facts, dates or body citations."""
import copy

import objective_fact_policy as legacy_facts
import objective_source_observations as observations
import objective_source_selection as selection
import objective_selection_schema as wire
import objective_work_actors as work
from objective_claim_typing import KINDS


def project(value, content, spans, context, legacy_schema, source_template, *, date_rows=None, contract=selection.CONTRACT):
    rows = selection.catalog(list(spans.values()), context)
    reasons = selection.omission_catalog(list(spans.values()), context)
    if not wire.matches(value, wire.schema(legacy_schema, list(spans.values()), context)):
        raise ValueError('Native source-selection result violates its frozen page schema')
    native = copy.deepcopy(value)
    selected = {m['anchorCitationId'] for m in native['retainedMoments']}
    omissions = []
    for row in rows:
        decision = native['cueDecisions'][row['id']]
        if decision == {'retained': True}:
            if row['id'] not in selected:
                raise ValueError('A retained cue requires its own complete native anchored fact')
        else:
            if row['id'] in selected:
                raise ValueError('An omitted cue cannot also anchor a retained fact')
            omissions.append(next(r for r in row['omissionChoices'] if r['id'] == decision['reasonRef']))
    metadata = selection.documents(context)
    references = [r for r in metadata if native['documentDecisions'][r['id']] == 'retain-reference']
    partial = {r['id']: r for r in selection.partial_dates(list(spans.values()))}
    bindings, partial_bindings, converted = [], [], []
    for index, m in enumerate(native['retainedMoments']):
        anchor = m.pop('anchorCitationId')
        source_type = m.pop('sourceClaimType')
        qualifications = m.pop('qualificationIds')
        extra = m.pop('contextObservations')
        if len({o['citationId'] for o in extra}) != len(extra):
            raise ValueError('Context observations must be distinct')
        m.update(titleCitationId=anchor, claimType=KINDS[source_type],
                 factTypeCitationIds=[] if m['factType'] == 'life-event' else [anchor],
                 observations=[{'citationId': anchor, 'qualificationIds': qualifications}, *extra])
        for side in ('start', 'end'):
            ref = m[side + 'DateRef']
            if ref in partial:
                row = partial[ref]
                if row['citationId'] != anchor:
                    raise ValueError('A partial date must belong to its own primary event anchor')
                partial_bindings.append({'momentIndex': index, 'side': side, 'reference': row})
                m[side + 'DateRef'] = None
        converted.append(m)
        bindings.append({'momentIndex': index, 'anchorCitationId': anchor, 'sourceClaimType': source_type,
                         'actorReading': next(r for r in work.actors(list(spans.values()), context) if r['citationId'] == anchor),
                         'identityVerified': False})
    if converted:
        summary_ids = list(dict.fromkeys(m['titleCitationId'] for m in converted))[:3]
        observed = {o['citationId'] for m in converted for o in m['observations']}
        omitted = [r['id'] for r in legacy_facts.career_cues(list(spans.values())) if r['id'] not in observed]
        result, changes = observations.project({'emptyAssessment': value['emptyAssessment'], 'moments': converted,
            'gaps': copy.deepcopy(value['gaps']), 'summaryCitationIds': summary_ids, 'omittedCueIds': omitted},
            content, spans, context, source_template, contract, date_rows=date_rows)
    else:
        reason = next(r for r in reasons if r.get('scope') == 'passage' and r['id'] == native['abstention']['reasonRef'])
        text = selection.selection.REASONS[reason['reasonCode']]
        quotes = ' '.join('« ' + s['text'] + ' »' for s in reason['sourceSpans'])
        result = {'summary': ('Abstention à relire : ' + text + '. ' + quotes)[:2000],
                  'classification': value['emptyAssessment'], 'moments': [], 'gaps': copy.deepcopy(value['gaps'])}
        changes = [{'path': '', 'contract': contract, 'claims': [], 'emptyAssessmentUsed': True,
                    'reason': 'Native cited whole-passage abstention; no model output repaired.', 'abstention': reason}]
    for b in partial_bindings:
        m = result['moments'][b['momentIndex']]
        text = b['reference']['text']
        m['originalDate'] = ' ; '.join(v for v in (m['originalDate'], text) if v)
        m['uncertainty'] += ' Date partielle citée : « ' + text + ' » ; année inconnue, aucune date complète déduite.'
    for row in omissions:
        result['gaps'].append('Sélection à relire : ' + selection.selection.REASONS[row['reasonCode']] + '. ' +
                              ' '.join('« ' + s['text'] + ' »' for s in row['sourceSpans']))
    for ref in references:
        result['gaps'].append('Référence de document retenue (métadonnées uniquement) : « ' + ref['filename'] +
                              ' » ; contenu non lu, aucun événement ou rôle déduit.')
    changes[0]['sourceSelection'] = {'contract': contract,
        'nativeCueDecisions': copy.deepcopy(value['cueDecisions']), 'selectionCatalog': rows,
        'bindings': bindings, 'omissions': omissions, 'partialDates': partial_bindings,
        'nativeDocumentDecisions': copy.deepcopy(value['documentDecisions']),
        'documentReferences': references, 'documentCatalog': metadata,
        'metadataBodyCitationAuthority': False, 'locallyInventedMoments': 0,
        'ownerConfirmation': False, 'semanticAcceptance': 'not-established'}
    return result, changes
