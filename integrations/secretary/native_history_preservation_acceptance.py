"""Validate native selected preservation acceptance independently of decisions.

Core produces the current human, restored Core and storage evidence. This client
reconstructs the selected policy; it neither supplies attestations nor cleans mail.
"""
from __future__ import annotations

from copy import deepcopy
import json
import urllib.error
import urllib.request
import uuid

from history_coverage import content_hash
from native_history_core_restoration import keys
from native_history_decisions import digest, pairs, invalid_constant
import native_history_decision_acceptance as decisions
from native_history_manifest_confirmation import components, date, request_identity
import native_history_storage_scope as storage
from retention_plan import NATIVE_GAPS

CONTRACT = 'agentx.history-preservation-acceptance/v1'
POLICY = 'native-distinct-machines-and-whole-devices/v1'
SCOPE = 'selected-originals-review-files-and-current-core-roundtrip'
CONSISTENCY = 'native-preservation-with-current-human-and-core-fence'
PRESERVATION_GAP = 'native_preservation_acceptance_unavailable'
MAX_RESPONSE = 2 * 1024 * 1024
MAX_SNAPSHOT = 64 * 1024


def storage_bindings(manifest):
    """Derive expected native metadata from the already verified v11 graph."""
    try:
        refs = manifest['sources']
        findings = manifest['decisions']['snapshot']['findings']
        restored = manifest['restoration']['snapshot']['members']
        if not isinstance(refs, list) or not 1 <= len(refs) <= 20 \
                or len(findings) != len(refs) or len(restored) != len(refs):
            raise ValueError('The complete selected native storage bindings are unavailable')
        scopes, copies = [], []
        for reference, finding, member in zip(refs, findings, restored):
            if finding['reference'] != reference or member['source'] != reference:
                raise ValueError('Native storage references differ from the verified review manifest')
            native_copies = member['snapshot']['copies']
            if not isinstance(native_copies, list) or len(native_copies) != 2:
                raise ValueError('Both complete retained native copies are required')
            for name, copy in zip(('primary', 'mirror'), native_copies):
                storage.validate_copy(copy, reference, retained=True)
                if copy['copy'] != name:
                    raise ValueError('Native storage copy ordering differs from the verified manifest')
            scopes.append({'reference': reference, 'members': finding['snapshot']['coreScope']['members']})
            copies.append({'reference': reference, 'copies': [
                {key: value for key, value in copy.items() if key != 'status'} for copy in native_copies]})
        return deepcopy((refs, scopes, copies))
    except (KeyError, TypeError, AttributeError, IndexError):
        raise ValueError('The complete verified native storage bindings are unavailable') from None


def expected_snapshot(manifest, decision, observed_storage):
    """Apply the selected whole-device policy after both children are verified."""
    snapshot = observed_storage['snapshot']
    first = snapshot['members'][0]['copies']
    copies = [{**{key: copy[key] for key in ('copy', 'machineIdSha256', 'archiveIdSha256')},
               'physicalDiskIdsSha256': []} for copy in first]
    disks, blockers = [set(), set()], set()
    for member in snapshot['members']:
        if member['coverage']['state'] == 'held':
            blockers.add('selected_storage_evidence_held')
        for index, copy in enumerate(member['copies']):
            if any(copy[key] != copies[index][key] for key in ('machineIdSha256', 'archiveIdSha256')):
                blockers.add('storage_copy_identity_changed')
            if copy['storage']['status'] == 'unqualified':
                blockers.add('storage_topology_unqualified')
            disks[index].update(copy['storage']['physicalDiskIdsSha256'])
    if copies[0]['machineIdSha256'] == copies[1]['machineIdSha256']:
        blockers.add('same_native_machine')
    if disks[0] & disks[1]:
        blockers.add('selected_device_identity_overlap')
    current = decision['currentObservation']['snapshot']
    if current['confirmationStatus'] != 'current':
        blockers.add('human_confirmation_not_current')
    for copy, identifiers in zip(copies, disks):
        copy['physicalDiskIdsSha256'] = sorted(identifiers)
    accepted, decided = not blockers, decision['decisionReconciliationAccepted']
    gaps = [gap for gap in NATIVE_GAPS if not (accepted and gap == PRESERVATION_GAP)
            and not (decided and gap == decisions.DECISION_GAP)]
    result = {'contract': CONTRACT, 'scope': SCOPE, 'policy': POLICY,
        'binding': {'decisionReconciliationSha256': decision['fingerprint'],
            'storageScopeSha256': observed_storage['fingerprint'],
            'manifestSha256': current['current']['manifestSha256'],
            'coreRestorationSha256': current['current']['coreRestorationSha256'],
            **{key: manifest[key] for key in ('sourceSetSha256', 'checksSha256', 'before')}},
        'copies': copies, 'counts': {'messages': len(manifest['sources']), 'primaryDisks': len(disks[0]),
            'mirrorDisks': len(disks[1]), 'heldMessages': snapshot['coverage']['counts']['heldMessages']},
        'blockers': sorted(blockers), 'preservationStatus': 'accepted_scope' if accepted else 'held_scope',
        'preservationAccepted': accepted, 'decisionReconciliationAccepted': decided,
        'remainingNativeValidationGaps': gaps}
    if len(json.dumps(result, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()) > MAX_SNAPSHOT:
        raise ValueError('Native preservation acceptance exceeds its snapshot capacity')
    return result


def validate_observation(data, current, manifest, bindings, observation_id, previous=None):
    if not keys(data, 'authority contract observationId observedAt snapshot fingerprint status consistency decisionObservation storageObservation reviewOnly atomicBatch semanticAcceptance authenticatedPerson approvalBound mailboxEffects executionAllowed cleanupStatus preservationAccepted decisionReconciliationAccepted nativeValidationGaps') \
            or data['authority'] != 'agentx.core' or data['contract'] != CONTRACT \
            or data['observationId'] != observation_id or data['status'] != ('observed_match' if previous is not None else 'observed') \
            or data['consistency'] != CONSISTENCY or data['reviewOnly'] is not True \
            or data['atomicBatch'] is not False or data['semanticAcceptance'] is not False \
            or data['authenticatedPerson'] is not None or data['approvalBound'] is not False \
            or type(data['mailboxEffects']) is not int or data['mailboxEffects'] != 0 \
            or data['executionAllowed'] is not False or data['cleanupStatus'] != 'blocked':
        raise ValueError('Core did not confirm the native selected preservation contract')
    decision = decisions.validate_observation(data['decisionObservation'], current, manifest, observation_id,
        previous['decisionObservation'] if previous is not None else None)
    observed_storage = storage.validate_observation(data['storageObservation'], *bindings, observation_id,
        previous['storageObservation']['fingerprint'] if previous is not None else None)
    at = date(data['observedAt'])
    if at < date(decision['observedAt']) or at < date(observed_storage['observedAt']):
        raise ValueError('Native preservation child dates exceed the parent observation')
    snapshot = expected_snapshot(manifest, decision, observed_storage)
    if digest(data['snapshot']) != digest(snapshot) or data['fingerprint'] != digest(snapshot) \
            or type(data['preservationAccepted']) is not bool \
            or data['preservationAccepted'] != snapshot['preservationAccepted'] \
            or type(data['decisionReconciliationAccepted']) is not bool \
            or data['decisionReconciliationAccepted'] != snapshot['decisionReconciliationAccepted'] \
            or data['nativeValidationGaps'] != snapshot['remainingNativeValidationGaps'] \
            or (previous is not None and (data['fingerprint'] != previous['fingerprint']
                or at < date(previous['observedAt'])
                or date(observed_storage['observedAt']) < date(previous['storageObservation']['observedAt']))):
        raise ValueError('Native preservation acceptance changed or disagrees with its verified evidence')
    return data


def observe(core, request_id, selected, current, manifest, bindings, *, previous=None, opener=urllib.request.urlopen):
    observation_id = str(uuid.uuid4())
    body = {'checks': selected, 'before': current['before'], 'observationId': observation_id}
    if previous is not None:
        body.update(expected=previous['fingerprint'], expectedDecision=previous['decisionObservation']['fingerprint'],
            expectedCurrent=previous['decisionObservation']['currentObservation']['fingerprint'],
            expectedStorage=previous['storageObservation']['fingerprint'])
    request = urllib.request.Request(
        f"{core.rstrip('/')}/api/secretary/history/manifest-confirmations/{request_id}/preservation-acceptance",
        data=json.dumps(body, allow_nan=False).encode(), method='POST',
        headers={'x-service-caller': 'secretary-retention-review', 'Content-Type': 'application/json'})
    try:
        with opener(request, timeout=1800) as response:
            raw = response.read(MAX_RESPONSE + 1)
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ValueError('The complete native selected preservation acceptance is unavailable') from None
    if len(raw) > MAX_RESPONSE:
        raise ValueError('Native preservation acceptance exceeds its response capacity')
    value = json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)
    data = value.get('data') if isinstance(value, dict) and value.get('ok') is True else None
    return validate_observation(data, current, manifest, bindings, observation_id, previous)


def capture(core, request_id, saved, checks, before, manifest, core_restoration, *, opener=urllib.request.urlopen):
    request_identity(request_id)
    selected, current = components(saved, checks, before, manifest, core_restoration)
    current['requestId'] = request_id
    verified = deepcopy(manifest['snapshot'])
    bindings = storage_bindings(verified)
    saved_hash = content_hash(saved)
    first = observe(core, request_id, selected, current, verified, bindings, opener=opener)
    second = observe(core, request_id, selected, current, verified, bindings, previous=first, opener=opener)
    if first['observationId'] == second['observationId'] or content_hash(saved) != saved_hash:
        raise ValueError('The exact preservation observation identity or saved dispositions changed')
    def retained(later, earlier):
        return {**later, 'initialObservationId': earlier['observationId'], 'initialObservedAt': earlier['observedAt']}
    return {'preservation': retained(second, first),
            'acceptance': retained(second['decisionObservation'], first['decisionObservation']),
            'confirmation': retained(second['decisionObservation']['currentObservation'], first['decisionObservation']['currentObservation']),
            'storage': retained(second['storageObservation'], first['storageObservation'])}
