"""Observe native recorded-decision acceptance for one verified review scope.

The nested current human confirmation is evidence, never permission to execute.
Only Core's native read is accepted; no caller classification or retries exist.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
import uuid

from native_history_core_restoration import keys
from native_history_decisions import HASH, ID, digest, pairs, invalid_constant
from native_history_manifest_confirmation import components, date, request_identity, validate_observation
from retention_plan import NATIVE_GAPS

CONTRACT = 'agentx.history-decision-reconciliation-acceptance/v1'
CONSISTENCY = 'native-recorded-decisions-with-current-human-confirmation'
DECISION_GAP = 'native_decision_reconciliation_unavailable'
MAX_RESPONSE = 128 * 1024
MAX_SNAPSHOT = 64 * 1024
MAX_INTEGER = 9007199254740991


def integer(value):
    return type(value) is int and 0 <= value <= MAX_INTEGER


def codes(value):
    return isinstance(value, list) and all(isinstance(code, str) and 0 < len(code) <= 100 for code in value)


def require(condition):
    if not condition:
        raise ValueError('The complete native recorded-decision graph is invalid or inconsistent')


def count_tree(value):
    """Reject ambiguous native counts even when a supplied hash was recomputed."""
    if isinstance(value, dict):
        for key, child in value.items():
            if key == 'counts':
                require(isinstance(child, dict) and all(integer(count) for count in child.values()))
            count_tree(child)
    elif isinstance(value, list):
        for child in value:
            count_tree(child)


def message(reference, finding, downstream, manifest_message, current):
    coverage, inventory, core = finding['coverage'], finding['inventory'], finding['coreScope']
    require(isinstance(coverage, dict) and set(coverage) == set('findings counts blockers unmatchedEntries meaning'.split())
            and isinstance(coverage['meaning'], str) and codes(coverage['blockers']))
    require(isinstance(coverage['findings'], list) and isinstance(inventory['findings'], list)
            and isinstance(inventory['threadQuestions'], list) and isinstance(core['members'], list))
    pins = {pin['entryId']: pin for pin in core['members']}
    require(len(pins) == len(core['members']))
    for pin in pins.values():
        require(keys(pin, 'entryId entryRevision fingerprint sourceBinding') and pin['sourceBinding'] == 'exact'
                and isinstance(pin['entryId'], str) and ID.fullmatch(pin['entryId'])
                and integer(pin['entryRevision']) and isinstance(pin['fingerprint'], str)
                and HASH.fullmatch(pin['fingerprint']))
    for row in inventory['findings']:
        require(keys(row, 'findingId section') and isinstance(row['findingId'], str) and HASH.fullmatch(row['findingId'])
                and row['section'] in ('actions', 'memories', 'deliverables', 'invoices'))
    for row in inventory['threadQuestions']:
        require(keys(row, 'questionId') and isinstance(row['questionId'], str) and HASH.fullmatch(row['questionId']))
    indexed = {row['findingId']: row['section'] for row in inventory['findings']}
    require(len(indexed) == len(inventory['findings']) and len(coverage['findings']) == len(indexed))
    require(isinstance(coverage['unmatchedEntries'], list)
            and len(set(coverage['unmatchedEntries'])) == len(coverage['unmatchedEntries'])
            and all(entry in pins for entry in coverage['unmatchedEntries']))
    counts = coverage['counts']
    expected_counts = {'recordedFindings': len(indexed), 'threadQuestions': len(inventory['threadQuestions']),
        'unmatchedEntries': len(coverage['unmatchedEntries']), **{key: sum(row['status'] == state for row in coverage['findings'])
        for key, state in (('noCoreReference', 'no_core_reference'), ('needsReview', 'needs_review'), ('observedDecision', 'observed_decision'))}}
    require(digest(counts) == digest(expected_counts))
    held = not indexed or any(counts[key] for key in ('threadQuestions', 'unmatchedEntries', 'noCoreReference', 'needsReview'))
    require(bool(coverage['blockers']) == held)
    blockers, seen, records = set(coverage['blockers']) | set(manifest_message['blockers']), set(), 0
    for row in coverage['findings']:
        require(keys(row, 'findingId section status records') and row['findingId'] in indexed
                and row['findingId'] not in seen and row['section'] == indexed[row['findingId']]
                and isinstance(row['records'], list) and len(row['records']) <= 100)
        seen.add(row['findingId'])
        record_ids = set()
        for record in row['records']:
            require(keys(record, 'entryId revision fingerprint kind state blockers')
                    and record['entryId'] in pins and record['entryId'] not in record_ids
                    and integer(record['revision']) and record['revision'] == pins[record['entryId']]['entryRevision']
                    and record['fingerprint'] == pins[record['entryId']]['fingerprint']
                    and isinstance(record['kind'], str) and isinstance(record['state'], str) and codes(record['blockers']))
            record_ids.add(record['entryId'])
            expected_kind = {'actions': 'action', 'memories': 'fact', 'deliverables': 'deliverable', 'invoices': 'invoice'}[row['section']]
            if record['blockers'] or record['kind'] != expected_kind:
                blockers.add('recorded_decision_not_observed')
            if record['kind'] in ('action', 'deliverable', 'invoice'):
                if record['state'] not in ('resolved', 'dismissed'):
                    blockers.add('actionable_record_not_resolved')
            elif record['kind'] == 'fact':
                if record['state'] not in ('retained', 'resolved', 'dismissed'):
                    blockers.add('information_decision_not_recorded')
            else:
                blockers.add('unsupported_record_kind')
        status = 'no_core_reference' if not row['records'] else 'needs_review' if any(record['blockers'] for record in row['records']) else 'observed_decision'
        require(row['status'] == status)
        if not row['records']:
            blockers.add('recorded_finding_without_decision')
        if row['status'] != 'observed_decision':
            blockers.add('recorded_decision_not_observed')
        records += len(row['records'])
    linked_coverage, entries = downstream['coverage'], downstream['entries']
    require(keys(linked_coverage, 'counts blockers') and codes(linked_coverage['blockers'])
            and isinstance(entries, list) and len(entries) == len(pins))
    linked_counts = dict.fromkeys(('entries', 'notLinked', 'currentLinks', 'unavailable', 'needsReview'), 0)
    linked_counts['entries'] = len(entries)
    states = {'not_linked': 'notLinked', 'current_link': 'currentLinks', 'unavailable': 'unavailable', 'needs_review': 'needsReview'}
    for entry, pin in zip(entries, core['members']):
        require(keys(entry, 'entryId entryRevision decisionFingerprint state note blockers')
                and entry['entryId'] == pin['entryId'] and integer(entry['entryRevision'])
                and entry['entryRevision'] == pin['entryRevision'] and entry['decisionFingerprint'] == pin['fingerprint']
                and isinstance(entry['state'], str) and entry['state'] in states and codes(entry['blockers']))
        state, note = entry['state'], entry['note']
        if state == 'not_linked':
            require(note is None and entry['blockers'] == [])
        elif state == 'unavailable':
            require(note is None and entry['blockers'] == ['linked_souvenir_unavailable'])
        else:
            require(keys(note, 'id revision fingerprint sourceBinding contextBinding replacementPending')
                    and isinstance(note['id'], str) and ID.fullmatch(note['id']) and integer(note['revision'])
                    and isinstance(note['fingerprint'], str) and HASH.fullmatch(note['fingerprint'])
                    and all(type(note[key]) is bool for key in ('sourceBinding', 'contextBinding', 'replacementPending')))
            note_blockers = [code for failed, code in ((not note['sourceBinding'], 'linked_souvenir_source_mismatch'),
                (not note['contextBinding'], 'linked_souvenir_context_mismatch'),
                (note['replacementPending'], 'linked_souvenir_replacement_pending')) if failed]
            require(entry['blockers'] == note_blockers and state == ('needs_review' if note_blockers else 'current_link'))
        linked_counts[states[entry['state']]] += 1
        if entry['blockers'] or entry['state'] not in ('current_link', 'not_linked'):
            blockers.add('linked_souvenirs_need_review')
    require(digest(linked_counts) == digest(linked_coverage['counts']))
    blockers.update(linked_coverage['blockers'])
    if not current:
        blockers.add('human_confirmation_not_current')
    return {'referenceSha256': digest(reference), 'recordedFindings': counts['recordedFindings'],
        'observedDecisions': counts['observedDecision'], 'records': records,
        'currentLinks': linked_counts['currentLinks'], 'notLinked': linked_counts['notLinked'],
        'blockers': sorted(blockers), 'accepted': not blockers}


def expected_snapshot(manifest, confirmation):
    """Reconstruct policy output from the verified v11 graph and nested v13."""
    try:
        count_tree(manifest)
        child = {key: confirmation[key] for key in ('fingerprint', 'snapshot')}
        sources, native_messages = manifest['sources'], manifest['coverage']['messages']
        require(isinstance(native_messages, list) and len(native_messages) == len(sources))
        for reference, row in zip(sources, native_messages):
            require(keys(row, 'reference blockers reviewStatus candidateForOwnerReview')
                    and row['reference'] == reference and codes(row['blockers'])
                    and row['reviewStatus'] == ('held' if row['blockers'] else 'observed')
                    and row['candidateForOwnerReview'] is False)
        require(manifest['coverage']['counts']['messages'] == len(sources)
                and manifest['coverage']['counts']['evidenceHeldMessages'] == sum(bool(row['blockers']) for row in native_messages))
        rows = [message(reference, finding['snapshot'], linked['snapshot'], native_message,
                        child['snapshot']['confirmationStatus'] == 'current')
                for reference, finding, linked, native_message in zip(sources,
                    manifest['decisions']['snapshot']['findings'], manifest['downstream']['snapshot']['members'], native_messages)]
        require(1 <= len(rows) <= 20 and len(rows) == len(manifest['sources']))
        accepted = all(row['accepted'] for row in rows)
        gaps = [gap for gap in NATIVE_GAPS if not accepted or gap != DECISION_GAP]
        counts = {'messages': len(rows), 'acceptedMessages': sum(row['accepted'] for row in rows),
                  'blockedMessages': sum(not row['accepted'] for row in rows),
                  **{key: sum(row[key] for row in rows) for key in ('recordedFindings', 'records', 'currentLinks', 'notLinked')}}
        snapshot = {'contract': CONTRACT, 'scope': 'selected-recorded-findings-and-linked-core-decisions',
            'policy': 'explicit-action-deliverable-invoice-resolution/v1', 'currentConfirmation': child,
            'messages': rows, 'counts': counts, 'acceptanceStatus': 'accepted_scope' if accepted else 'blocked_scope',
            'decisionReconciliationAccepted': accepted, 'remainingNativeValidationGaps': gaps}
        if len(json.dumps(snapshot, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()) > MAX_SNAPSHOT:
            raise ValueError('Native decision acceptance exceeds its snapshot capacity')
        return snapshot
    except (KeyError, TypeError, AttributeError, IndexError):
        raise ValueError('The complete native recorded-decision graph is unavailable') from None


def observe(core, request_id, selected, current, manifest, *, previous=None, opener=urllib.request.urlopen):
    observation_id = str(uuid.uuid4())
    body = {'checks': selected, 'before': current['before'], 'observationId': observation_id}
    if previous is not None:
        body.update(expected=previous['fingerprint'], expectedCurrent=previous['currentObservation']['fingerprint'])
    request = urllib.request.Request(
        f"{core.rstrip('/')}/api/secretary/history/manifest-confirmations/{request_id}/decision-acceptance",
        data=json.dumps(body, allow_nan=False).encode(), method='POST',
        headers={'x-service-caller': 'secretary-retention-review', 'Content-Type': 'application/json'})
    try:
        with opener(request, timeout=1200) as response:
            raw = response.read(MAX_RESPONSE + 1)
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ValueError('The native recorded-decision acceptance is unavailable') from None
    if len(raw) > MAX_RESPONSE:
        raise ValueError('Native decision acceptance exceeds its response capacity')
    value = json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)
    data = value.get('data') if isinstance(value, dict) and value.get('ok') is True else None
    if not keys(data, 'authority contract observationId observedAt fingerprint snapshot status consistency currentObservation reviewOnly atomicBatch semanticAcceptance authenticatedPerson approvalBound mailboxEffects executionAllowed cleanupStatus decisionReconciliationAccepted nativeValidationGaps') \
            or data['authority'] != 'agentx.core' or data['contract'] != CONTRACT \
            or data['observationId'] != observation_id or data['status'] != ('observed_match' if previous is not None else 'observed') \
            or data['consistency'] != CONSISTENCY or data['reviewOnly'] is not True \
            or data['atomicBatch'] is not False or data['semanticAcceptance'] is not False \
            or data['authenticatedPerson'] is not None or data['approvalBound'] is not False \
            or type(data['mailboxEffects']) is not int or data['mailboxEffects'] != 0 \
            or data['executionAllowed'] is not False or data['cleanupStatus'] != 'blocked':
        raise ValueError('Core did not confirm the native recorded-decision acceptance contract')
    child = validate_observation(data['currentObservation'], current, observation_id,
                                 previous['currentObservation'] if previous is not None else None)
    snapshot = expected_snapshot(manifest, child)
    at = date(data['observedAt'])
    require(at >= date(child['observedAt']))
    if digest(data['snapshot']) != digest(snapshot) or data['fingerprint'] != digest(snapshot) \
            or type(data['decisionReconciliationAccepted']) is not bool \
            or data['decisionReconciliationAccepted'] != snapshot['decisionReconciliationAccepted'] \
            or data['nativeValidationGaps'] != snapshot['remainingNativeValidationGaps'] \
            or (previous is not None and (data['fingerprint'] != previous['fingerprint']
                or at < date(previous['observedAt']))):
        raise ValueError('Native recorded-decision acceptance changed or disagrees with its verified evidence')
    return data


def capture(core, request_id, saved, checks, before, manifest, core_restoration, *, opener=urllib.request.urlopen):
    request_identity(request_id)
    selected, current = components(saved, checks, before, manifest, core_restoration)
    current['requestId'] = request_id
    # Validate the graph before HTTP; the actual child is validated per response.
    expected_snapshot(manifest['snapshot'], {'fingerprint': '0' * 64, 'snapshot': current})
    first = observe(core, request_id, selected, current, manifest['snapshot'], opener=opener)
    second = observe(core, request_id, selected, current, manifest['snapshot'], previous=first, opener=opener)
    return {'acceptance': {**second, 'initialObservationId': first['observationId'], 'initialObservedAt': first['observedAt']},
            'confirmation': {**second['currentObservation'], 'initialObservationId': first['currentObservation']['observationId'],
                             'initialObservedAt': first['currentObservation']['observedAt']}}
