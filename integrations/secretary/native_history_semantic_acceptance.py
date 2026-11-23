"""Read an explicit native human semantic judgement; never create or infer one.

The private LAN human surface owns the judgement. This transport binds its
original identity, exact sources and recorded analyses to current native P/D
evidence. Serving bytes alone is not comprehension or mailbox approval.
"""
from __future__ import annotations

from copy import deepcopy
import json
import re
import urllib.error
import urllib.request
import uuid

from history_coverage import content_hash
from native_history_core_restoration import keys
from native_history_decisions import HASH, digest, invalid_constant, pairs
from native_history_manifest_confirmation import components, date, request_identity
import native_history_preservation_acceptance as preservation

CONTRACT = 'agentx.history-semantic-acceptance/v1'
REVIEW_CONTRACT = 'agentx.history-human-semantic-review/v1'
PURPOSE = 'human_selected_sources_and_recorded_analyses'
POLICY = 'explicit-human-judgement-on-private-lan/v1'
SCOPE = 'human-selected-originals-attachments-and-recorded-analyses'
CONSISTENCY = 'native-human-semantic-with-preservation-and-final-core-fence'
SEMANTIC_GAP = 'native_semantic_acceptance_unavailable'
MAX_RESPONSE = 3 * 1024 * 1024
MAX_SNAPSHOT = 1024 * 1024
KEY = re.compile(r'[A-Za-z0-9._:-]{1,128}\Z')


def require(condition, message='The exact native human semantic judgement is invalid or changed'):
    if not condition:
        raise ValueError(message)


def hash_value(value):
    return isinstance(value, str) and HASH.fullmatch(value) is not None


def integer(value, maximum):
    return type(value) is int and 0 <= value <= maximum


def validate_binding(binding, selected, manifest, current):
    require(keys(binding, 'contract purpose inputSha256 current originalConfirmation sources')
        and binding['contract'] == REVIEW_CONTRACT and binding['purpose'] == PURPOSE
        and binding['inputSha256'] == digest(selected)
        and digest(binding['current']) == digest(current['current'])
        and digest(binding['originalConfirmation']) == digest(current['confirmation'])
        and isinstance(binding['sources'], list) and len(binding['sources']) == len(manifest['sources']))
    resource_count, total_bytes = 0, 0
    for source, ref, restored in zip(binding['sources'], manifest['sources'], manifest['restoration']['snapshot']['members']):
        require(keys(source, 'resources') and isinstance(source['resources'], list) and 2 <= len(source['resources']) <= 256)
        resources, seen = source['resources'], {}
        size = 0
        for resource in resources:
            require(keys(resource, 'kind key sha256 bytes')
                and resource['kind'] in ('original', 'attachment', 'analysis', 'compound_member')
                and isinstance(resource['key'], str) and KEY.fullmatch(resource['key'])
                and hash_value(resource['sha256']) and integer(resource['bytes'], 16 * 1024 * 1024)
                and ((resource['kind'], resource['key']) not in seen
                    or resource['kind'] == 'compound_member'
                    and resource == seen[(resource['kind'], resource['key'])]))
            seen[(resource['kind'], resource['key'])] = resource; size += resource['bytes']
        content = restored['snapshot']['copies'][0]['content']
        originals = [resource for resource in resources if resource['kind'] == 'original']
        require(originals == [{'kind': 'original', 'key': 'original', 'sha256': ref['sourceSha256'], 'bytes': content['raw']['bytes']}])
        attached = sorted(({'partId': r['key'], 'sha256': r['sha256'], 'bytes': r['bytes']}
                           for r in resources if r['kind'] == 'attachment'), key=lambda r: r['partId'])
        require(attached == sorted(content['attachments'], key=lambda r: r['partId']))
        analyses = [resource for resource in resources if resource['kind'] == 'analysis']
        require(len(analyses) == 1 and analyses[0]['key'] == 'selected-analysis' and analyses[0]['bytes'] > 0
            and sum(r['kind'] == 'compound_member' for r in resources) <= content['reviewPacket']['counts']['compoundMembers']
            and size <= 16 * 1024 * 1024)
        resource_count += len(resources); total_bytes += size
    return resource_count, total_bytes


def validate_receipt(receipt, semantic_id, binding, selected, manifest, current, observed_at):
    require(keys(receipt, 'contract requestId state inputSha256 bindingSha256 preparedAt decidedAt decision blockedCode coverage recordedVia authenticatedPerson semanticAcceptance approvalBound executionAllowed cleanupStatus mailboxEffects replayed nativeState')
        and receipt['contract'] == REVIEW_CONTRACT and receipt['requestId'] == semantic_id
        and receipt['state'] in ('prepared', 'deciding', 'accepted', 'held', 'blocked')
        and receipt['inputSha256'] == binding['inputSha256'] and receipt['bindingSha256'] == digest(binding)
        and receipt['recordedVia'] == 'private_lan_surface' and receipt['authenticatedPerson'] is None
        and receipt['semanticAcceptance'] is False and receipt['approvalBound'] is False
        and receipt['executionAllowed'] is False and receipt['cleanupStatus'] == 'blocked'
        and type(receipt['mailboxEffects']) is int and receipt['mailboxEffects'] == 0
        and receipt['replayed'] is True and receipt['nativeState'] == 'not_rechecked')
    require(date(current['confirmation']['confirmedAt']) <= date(receipt['preparedAt']) <= observed_at)
    decision = receipt['decision']; state = receipt['state']
    if state in ('accepted', 'held'):
        require(decision == ('accepted_selected_semantics' if state == 'accepted' else 'held_ambiguous')
            and date(receipt['preparedAt']) <= date(receipt['decidedAt']) <= observed_at)
    else:
        require(receipt['decidedAt'] is None and (decision is None if state == 'prepared'
            else decision in ('accepted_selected_semantics', 'held_ambiguous') if state == 'deciding'
            else decision in (None, 'accepted_selected_semantics', 'held_ambiguous')))
    require(receipt['blockedCode'] in ('evidence_changed', 'evidence_unavailable', 'evidence_capacity')
        if state == 'blocked' else receipt['blockedCode'] is None)
    count, size = validate_binding(binding, {'manifestRequestId': current['requestId'], 'checks': selected,
        'before': current['before']}, manifest, current)
    coverage = receipt['coverage']
    require(keys(coverage, 'resources totalBytes servedResources servedBytes complete')
        and type(coverage['resources']) is int and coverage['resources'] == count
        and type(coverage['totalBytes']) is int and coverage['totalBytes'] == size
        and integer(coverage['servedResources'], count) and integer(coverage['servedBytes'], size)
        and type(coverage['complete']) is bool
        and coverage['complete'] == (coverage['servedResources'] == count and coverage['servedBytes'] == size))
    require(state != 'accepted' or coverage['complete'])
    return receipt


def expected_snapshot(manifest_id, semantic_id, selected, manifest, child, receipt, binding, observed_at):
    current = child['decisionObservation']['currentObservation']['snapshot']
    validate_receipt(receipt, semantic_id, binding, selected, manifest, current, observed_at)
    blockers = ['thread_questions_unresolved'] if any(row['snapshot']['inventory']['threadQuestions']
        for row in manifest['decisions']['snapshot']['findings']) else []
    if receipt['state'] != 'accepted': blockers.append('explicit_human_semantic_decision_missing')
    if not receipt['coverage']['complete']: blockers.append('semantic_sources_not_fully_served')
    accepted = not blockers
    return {'contract': CONTRACT, 'scope': SCOPE, 'policy': POLICY, 'manifestRequestId': manifest_id,
        'semanticRequestId': semantic_id, 'inputSha256': receipt['inputSha256'], 'bindingSha256': receipt['bindingSha256'],
        'preservationAcceptanceSha256': child['fingerprint'], 'reviewBinding': binding, 'receipt': receipt,
        'blockers': blockers, 'semanticAcceptance': accepted, 'preservationAccepted': child['preservationAccepted'],
        'decisionReconciliationAccepted': child['decisionReconciliationAccepted'],
        'remainingNativeValidationGaps': [gap for gap in child['nativeValidationGaps'] if not (gap == SEMANTIC_GAP and accepted)]}


def validate_observation(data, manifest_id, semantic_id, selected, current, manifest, bindings, observation_id, previous=None):
    require(keys(data, 'authority contract observationId observedAt snapshot fingerprint status consistency preservationObservation reviewOnly atomicBatch authenticatedPerson semanticAcceptance preservationAccepted decisionReconciliationAccepted approvalBound executionAllowed cleanupStatus mailboxEffects nativeValidationGaps')
        and data['authority'] == 'agentx.core' and data['contract'] == CONTRACT and data['observationId'] == observation_id
        and data['status'] == ('observed_match' if previous is not None else 'observed')
        and data['consistency'] == CONSISTENCY and data['reviewOnly'] is True and data['atomicBatch'] is False
        and data['authenticatedPerson'] is None and data['approvalBound'] is False and data['executionAllowed'] is False
        and data['cleanupStatus'] == 'blocked' and type(data['mailboxEffects']) is int and data['mailboxEffects'] == 0)
    # v16 sends no child expectations. Validate the unchanged v15 contract as
    # a first observation, then separately require stable hashes and dates.
    child = preservation.validate_observation(data['preservationObservation'], current, manifest, bindings, observation_id)
    at = date(data['observedAt']); require(at >= date(child['observedAt']))
    snapshot = data['snapshot']
    require(isinstance(snapshot, dict) and isinstance(snapshot.get('receipt'), dict) and isinstance(snapshot.get('reviewBinding'), dict))
    expected = expected_snapshot(manifest_id, semantic_id, selected, manifest, child, snapshot['receipt'], snapshot['reviewBinding'], at)
    require(digest(snapshot) == digest(expected) and data['fingerprint'] == digest(expected)
        and len(json.dumps(snapshot, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()) <= MAX_SNAPSHOT
        and all(type(data[key]) is bool and data[key] == expected[key]
            for key in ('semanticAcceptance', 'preservationAccepted', 'decisionReconciliationAccepted'))
        and data['nativeValidationGaps'] == expected['remainingNativeValidationGaps'])
    if previous is not None:
        require(data['fingerprint'] == previous['fingerprint'] and at >= date(previous['observedAt']))
        old = previous['preservationObservation']
        for observed, earlier in ((child, old), (child['decisionObservation'], old['decisionObservation']),
                (child['decisionObservation']['currentObservation'], old['decisionObservation']['currentObservation']),
                (child['storageObservation'], old['storageObservation'])):
            require(observed['fingerprint'] == earlier['fingerprint'] and date(observed['observedAt']) >= date(earlier['observedAt']))
    return data


def observe(core, manifest_id, semantic_id, selected, current, manifest, bindings, *, previous=None, opener=urllib.request.urlopen):
    observation_id = str(uuid.uuid4())
    body = {'semanticRequestId': semantic_id, 'checks': selected, 'before': current['before'], 'observationId': observation_id}
    if previous is not None: body['expected'] = previous['fingerprint']
    request = urllib.request.Request(
        f"{core.rstrip('/')}/api/secretary/history/manifest-confirmations/{manifest_id}/semantic-acceptance",
        data=json.dumps(body, allow_nan=False).encode(), method='POST',
        headers={'x-service-caller': 'secretary-retention-review', 'Content-Type': 'application/json'})
    try:
        with opener(request, timeout=1800) as response:
            raw = response.read(MAX_RESPONSE + 1)
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ValueError('The complete current human semantic acceptance is unavailable') from None
    require(len(raw) <= MAX_RESPONSE, 'Native human semantic acceptance exceeds its response capacity')
    value = json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)
    data = value.get('data') if isinstance(value, dict) and value.get('ok') is True else None
    try:
        return validate_observation(data, manifest_id, semantic_id, selected, current, manifest, bindings, observation_id, previous)
    except (KeyError, TypeError, AttributeError, IndexError):
        raise ValueError('The complete native human semantic evidence is unavailable or invalid') from None


def capture(core, manifest_id, semantic_id, saved, checks, before, manifest, core_restoration, *, opener=urllib.request.urlopen):
    request_identity(manifest_id); request_identity(semantic_id)
    selected, current = components(saved, checks, before, manifest, core_restoration)
    current['requestId'] = manifest_id
    verified = deepcopy(manifest['snapshot']); bindings = preservation.storage_bindings(verified)
    saved_hash = content_hash(saved)
    first = observe(core, manifest_id, semantic_id, selected, current, verified, bindings, opener=opener)
    second = observe(core, manifest_id, semantic_id, selected, current, verified, bindings, previous=first, opener=opener)
    require(first['observationId'] != second['observationId'] and content_hash(saved) == saved_hash)
    def retained(later, earlier):
        return {**later, 'initialObservationId': earlier['observationId'], 'initialObservedAt': earlier['observedAt']}
    p, old = second['preservationObservation'], first['preservationObservation']
    return {'semantic': retained(second, first), 'preservation': retained(p, old),
        'acceptance': retained(p['decisionObservation'], old['decisionObservation']),
        'confirmation': retained(p['decisionObservation']['currentObservation'], old['decisionObservation']['currentObservation']),
        'storage': retained(p['storageObservation'], old['storageObservation'])}
