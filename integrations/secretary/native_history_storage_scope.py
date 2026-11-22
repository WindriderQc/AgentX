"""Observe selected archive kernel devices without accepting physical independence.

This private client consumes verified discovery and v9 review-restoration scopes.
Core owns native probes and the final membership fence. No cleanup is authorized.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime
import json
import re
import urllib.error
import urllib.request
import uuid

from history_coverage import content_hash
from native_history_decisions import HASH, ID, digest, pairs, invalid_constant
from native_history_message_scope import CONTRACT as MESSAGE_CONTRACT, references
from native_history_restoration_scope import REVIEW_CONTRACT, UUID, selection, validate_review_copy
from retention_plan import NATIVE_GAPS

CONTRACT = 'agentx.history-storage-scope/v1'
STORAGE_CONTRACT = 'secretary.archive-storage-topology/v1'
STORAGE_SCOPE = 'selected-current-review-files-kernel-device-identities'
MAX_RESPONSE = 2 * 1024 * 1024
LIMIT = 16 * 1024 * 1024
SAFE_INTEGER = 9007199254740991


def keys(value, names):
    return isinstance(value, dict) and set(value) == set(names.split())


def is_hash(value):
    return isinstance(value, str) and HASH.fullmatch(value) is not None


def integer(value, minimum, maximum):
    return type(value) is int and minimum <= value <= maximum


def date(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z', value):
        raise ValueError('Native storage observation date is invalid')
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def nonce(value):
    return isinstance(value, str) and UUID.fullmatch(value) is not None


def core_scopes(refs, scopes):
    if not isinstance(scopes, list) or len(scopes) != len(refs):
        raise ValueError('The complete verified native message scope is unavailable')
    found, shared = {}, {}
    for scope in scopes:
        if not keys(scope, 'reference fingerprint members observationId observedAt') \
                or not isinstance(scope['reference'], dict) or not isinstance(scope['members'], list) \
                or len(scope['members']) > 100 or not nonce(scope['observationId']):
            raise ValueError('Native message scope identity is invalid')
        date(scope['observedAt'])
        ref = scope['reference']; mid = ref.get('messageId')
        if not isinstance(mid, str) or mid in found or ref not in refs:
            raise ValueError('Native message references do not cover the exact selected set')
        ids = []
        for pin in scope['members']:
            if not keys(pin, 'entryId entryRevision fingerprint sourceBinding') \
                    or not isinstance(pin['entryId'], str) or not ID.fullmatch(pin['entryId']) \
                    or not integer(pin['entryRevision'], 0, SAFE_INTEGER) or not is_hash(pin['fingerprint']) \
                    or pin['sourceBinding'] != 'exact':
                raise ValueError('Native message member pins are invalid')
            key = pin['entryId']; ids.append(key)
            if key in shared and digest(shared[key]) != digest(pin):
                raise ValueError('A shared native message member pin changed')
            shared[key] = pin
        snapshot = {'contract': MESSAGE_CONTRACT, 'reference': ref, 'entries': scope['members']}
        if ids != sorted(set(ids)) or len(shared) > 100 or not is_hash(scope['fingerprint']) \
                or digest(snapshot) != scope['fingerprint']:
            raise ValueError('Native message membership failed its fingerprint check')
        found[mid] = {'reference': ref, 'members': scope['members']}
    return [found[ref['messageId']] for ref in refs]


def validate_copy(copy, reference, *, retained=False):
    fields = 'copy machineIdSha256 archiveIdSha256 content restoration' + (' status' if retained else ' storage')
    if not keys(copy, fields) or copy['copy'] not in ('primary', 'mirror') \
            or any(not is_hash(copy[key]) for key in ('machineIdSha256', 'archiveIdSha256')) \
            or (retained and copy['status'] != 'available'):
        raise ValueError('Native storage copy identity is invalid')
    content, restored = copy['content'], copy['restoration']
    if not keys(content, 'messageId threadId sourceSha256 raw attachments metadataSha256 partsDecoded attachmentsDecoded reviewPacket') \
            or any(content[key] != reference[key] for key in ('messageId', 'threadId', 'sourceSha256')) \
            or not keys(content['raw'], 'sha256 bytes') or content['raw']['sha256'] != reference['sourceSha256'] \
            or not integer(content['raw']['bytes'], 1, LIMIT) or not is_hash(content['metadataSha256']) \
            or not integer(content['partsDecoded'], 1, 4096) \
            or not integer(content['attachmentsDecoded'], 0, content['partsDecoded']) \
            or not isinstance(content['attachments'], list) or len(content['attachments']) > 128 \
            or len(content['attachments']) != content['attachmentsDecoded']:
        raise ValueError('Native storage copy content is incomplete or invalid')
    ids, total = [], content['raw']['bytes']
    for attachment in content['attachments']:
        if not keys(attachment, 'partId sha256 bytes') or not isinstance(attachment['partId'], str) \
                or not re.fullmatch(r'[a-zA-Z0-9_.:-]{1,128}', attachment['partId']) \
                or not is_hash(attachment['sha256']) or not integer(attachment['bytes'], 0, LIMIT):
            raise ValueError('Native storage attachment metadata is invalid')
        ids.append(attachment['partId']); total += attachment['bytes']
    if ids != sorted(set(ids)) or total > LIMIT \
            or not keys(restored, 'sourceFilesSha256 restoredFilesSha256 filesCopied bytesCopied temporaryCopyRemoved') \
            or not is_hash(restored['sourceFilesSha256']) \
            or restored['sourceFilesSha256'] != restored['restoredFilesSha256'] \
            or not integer(restored['filesCopied'], 7, 256) \
            or not integer(restored['bytesCopied'], content['raw']['bytes'], LIMIT) \
            or restored['temporaryCopyRemoved'] is not True:
        raise ValueError('Native storage copy restoration is incomplete or invalid')
    validate_review_copy(copy)
    if content['reviewPacket']['counts']['attachments'] != len(content['attachments']):
        raise ValueError('Native storage review attachment counts are inconsistent')


def expected_copies(saved, refs, scopes, review_restoration):
    """Revalidate retained pins; compare each new copy to its own v9 metadata."""
    try:
        observed = review_restoration
        snapshot = observed['snapshot']
        if observed.get('contract') != REVIEW_CONTRACT or observed.get('status') != 'observed_match' \
                or observed.get('authority') != 'agentx.core' or observed.get('atomicBatch') is not False \
                or observed.get('semanticAcceptance') is not False or observed.get('authenticatedPerson', False) is not None \
                or observed.get('executionAllowed') is not False or observed.get('cleanupStatus') != 'blocked' \
                or observed.get('nativeValidationGaps') != list(NATIVE_GAPS) \
                or observed.get('consistency') != 'retained-restoration-rechecks-with-final-core-fence' \
                or observed.get('coverage') != 'complete-selected-review-packet-source-set' \
                or observed.get('savedDispositionsSha256') != content_hash(saved) \
                or not nonce(observed.get('observationId')) or not nonce(observed.get('initialObservationId')) \
                or observed['observationId'] == observed['initialObservationId'] \
                or date(observed['observedAt']) < date(observed['initialObservedAt']) \
                or not keys(snapshot, 'contract sourceSetSha256 pins members') or snapshot['contract'] != REVIEW_CONTRACT \
                or snapshot['sourceSetSha256'] != digest(refs) or not is_hash(observed.get('fingerprint')) \
                or digest(snapshot) != observed['fingerprint'] \
                or not isinstance(snapshot['members'], list) or len(snapshot['members']) != len(refs) \
                or not isinstance(snapshot['pins'], list) or len(snapshot['pins']) != len(refs):
            raise ValueError('The verified native review restoration scope changed')
        checks = [{key: member[key] for key in ('entryId', 'requestId', 'snapshotHash', 'source')}
                  for member in snapshot['members']]
        if selection(saved, checks) != checks:
            raise ValueError('Native review restoration membership ordering changed')
        expected, identities = [], None
        for check, pin, member, scope in zip(checks, snapshot['pins'], snapshot['members'], scopes):
            if not keys(member, 'entryId requestId snapshotHash source snapshot') \
                    or not keys(pin, 'entryId requestId snapshotHash source entryRevision basisHash privacyHash') \
                    or any(pin[key] != value for key, value in check.items()) \
                    or not integer(pin['entryRevision'], 0, SAFE_INTEGER) \
                    or any(not is_hash(pin[key]) for key in ('basisHash', 'privacyHash')):
                raise ValueError('Native review restoration member pins changed')
            selected = [row for row in scope['members'] if row['entryId'] == pin['entryId']]
            if len(selected) != 1 or selected[0]['entryRevision'] != pin['entryRevision']:
                raise ValueError('Native restoration pins no longer match the verified Core membership')
            proof = member['snapshot']
            if not keys(proof, 'contract scope reference copies status blockers') \
                    or proof['contract'] != 'agentx.history-preservation/v3' \
                    or proof['scope'] != 'selected-original-attachments-mime-review-packet-and-temporary-disk-restore' \
                    or proof['status'] != 'verified_scope' or proof['blockers'] != [] \
                    or not isinstance(proof['reference'], dict) \
                    or any(proof['reference'].get(key) != value for key, value in check['source'].items()) \
                    or digest(proof) != check['snapshotHash'] \
                    or not isinstance(proof['copies'], list) or len(proof['copies']) != 2:
                raise ValueError('The complete native v9 review restoration is unavailable')
            for name, copy in zip(('primary', 'mirror'), proof['copies']):
                validate_copy(copy, check['source'], retained=True)
                if copy['copy'] != name:
                    raise ValueError('Native review restoration copy ordering changed')
            current = [[row['copy'], row['machineIdSha256'], row['archiveIdSha256']] for row in proof['copies']]
            if identities is not None and current != identities:
                raise ValueError('Native review restoration copy identities changed within the selection')
            identities = current
            expected.append({'reference': check['source'], 'copies': [
                {key: copy[key] for key in ('copy', 'machineIdSha256', 'archiveIdSha256', 'content', 'restoration')}
                for copy in proof['copies']]})
        return expected
    except (KeyError, TypeError, AttributeError):
        raise ValueError('The complete verified native review restoration scope is unavailable') from None


def validate_storage(storage, copy):
    if not keys(storage, 'contract scope status files filesSha256 physicalDiskIdsSha256 blockers physicalIndependenceAccepted') \
            or storage['contract'] != STORAGE_CONTRACT or storage['scope'] != STORAGE_SCOPE \
            or storage['status'] not in ('observed_local_devices', 'unqualified') \
            or not integer(storage['files'], 7, 256) or storage['files'] != copy['restoration']['filesCopied'] \
            or storage['filesSha256'] != copy['restoration']['sourceFilesSha256'] \
            or storage['physicalIndependenceAccepted'] is not False \
            or not isinstance(storage['physicalDiskIdsSha256'], list) or len(storage['physicalDiskIdsSha256']) > 32 \
            or any(not is_hash(value) for value in storage['physicalDiskIdsSha256']) \
            or storage['physicalDiskIdsSha256'] != sorted(set(storage['physicalDiskIdsSha256'])) \
            or not isinstance(storage['blockers'], list) or len(storage['blockers']) > 16 \
            or any(not isinstance(code, str) or not re.fullmatch(r'[a-z][a-z0-9_]{0,99}', code) for code in storage['blockers']) \
            or storage['blockers'] != sorted(set(storage['blockers'])) \
            or (storage['status'] == 'observed_local_devices' and (not storage['physicalDiskIdsSha256'] or storage['blockers'])) \
            or (storage['status'] == 'unqualified' and (storage['physicalDiskIdsSha256'] or not storage['blockers'])):
        raise ValueError('Native selected storage topology is invalid or incomplete')


def coverage(copies):
    blockers = []
    if any(copy['storage']['status'] == 'unqualified' for copy in copies):
        blockers.append('storage_topology_unqualified')
    if copies[0]['machineIdSha256'] == copies[1]['machineIdSha256']:
        blockers.append('same_native_machine')
    if digest(copies[0]['content']) != digest(copies[1]['content']):
        blockers.append('native_copy_content_mismatch')
    if set(copies[0]['storage']['physicalDiskIdsSha256']) & set(copies[1]['storage']['physicalDiskIdsSha256']):
        blockers.append('kernel_device_identity_overlap')
    return {'state': 'held' if blockers else 'distinct_kernel_devices_observed', 'blockers': blockers}


def validate_snapshot(snapshot, refs, scopes, expected):
    if not keys(snapshot, 'contract sources sourceSetSha256 coreScopes members coverage') \
            or snapshot['contract'] != CONTRACT or snapshot['sources'] != refs \
            or snapshot['sourceSetSha256'] != digest(refs) or digest(snapshot['coreScopes']) != digest(scopes) \
            or not isinstance(snapshot['members'], list) or len(snapshot['members']) != len(refs):
        raise ValueError('The complete native storage source set or Core pins changed')
    held = 0
    for wanted, member in zip(expected, snapshot['members']):
        if not keys(member, 'reference copies coverage') or member['reference'] != wanted['reference'] \
                or not isinstance(member['copies'], list) or len(member['copies']) != 2:
            raise ValueError('Native storage membership is incomplete or invalid')
        for copy, prior in zip(member['copies'], wanted['copies']):
            validate_copy(copy, member['reference'])
            if digest({key: copy[key] for key in prior}) != digest(prior):
                raise ValueError('Native storage copies no longer match the verified v9 restoration')
            validate_storage(copy['storage'], copy)
        expected_coverage = coverage(member['copies'])
        if member['coverage'] != expected_coverage:
            raise ValueError('Native storage member coverage is inconsistent')
        held += expected_coverage['state'] == 'held'
    expected_coverage = {'counts': {'messages': len(refs), 'distinctKernelDeviceMessages': len(refs) - held,
                                  'heldMessages': held},
                         'blockers': ['selected_storage_evidence_held'] if held else []}
    # Hash equality also distinguishes booleans/floats from integer counts.
    if digest(snapshot['coverage']) != digest(expected_coverage):
        raise ValueError('Native storage coverage counts or blockers are inconsistent')


def observe(core, refs, scopes, copies, *, expected=None, opener=urllib.request.urlopen):
    observation_id = str(uuid.uuid4())
    body = {'sources': refs, 'observationId': observation_id,
            **({'expected': expected} if expected is not None else {})}
    request = urllib.request.Request(f"{core.rstrip('/')}/api/secretary/history/storage-scope",
        data=json.dumps(body, allow_nan=False).encode(), method='POST',
        headers={'x-service-caller': 'secretary-retention-review', 'Content-Type': 'application/json'})
    try:
        with opener(request, timeout=1200) as response:
            raw = response.read(MAX_RESPONSE + 1)
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ValueError('The complete native storage observation is unavailable') from None
    if len(raw) > MAX_RESPONSE:
        raise ValueError('Native storage scope exceeds its response capacity')
    value = json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)
    data = value.get('data') if isinstance(value, dict) and value.get('ok') is True else None
    if not keys(data, 'authority contract observationId observedAt snapshot fingerprint status consistency atomicBatch reviewOnly physicalIndependenceAccepted semanticAcceptance authenticatedPerson approvalBound mailboxEffects executionAllowed cleanupStatus nativeValidationGaps') \
            or data['authority'] != 'agentx.core' or data['contract'] != CONTRACT \
            or data['observationId'] != observation_id or data['status'] != ('observed_match' if expected is not None else 'observed') \
            or data['consistency'] != 'two-complete-storage-passes-with-final-core-fence' \
            or data['atomicBatch'] is not False or data['reviewOnly'] is not True \
            or data['physicalIndependenceAccepted'] is not False or data['semanticAcceptance'] is not False \
            or data['authenticatedPerson'] is not None or data['approvalBound'] is not False \
            or type(data['mailboxEffects']) is not int or data['mailboxEffects'] != 0 \
            or data['executionAllowed'] is not False or data['cleanupStatus'] != 'blocked' \
            or data['nativeValidationGaps'] != list(NATIVE_GAPS):
        raise ValueError('Core did not confirm the bounded native storage contract')
    validate_snapshot(data['snapshot'], refs, scopes, copies)
    if not is_hash(data['fingerprint']) or data['fingerprint'] != digest(data['snapshot']) \
            or (expected is not None and data['fingerprint'] != expected):
        raise ValueError('Native storage scope changed or failed its fingerprint check')
    date(data['observedAt'])
    return data


def capture(core, saved, scopes, review_restoration, *, opener=urllib.request.urlopen):
    refs = references(saved)
    saved_hash = content_hash(saved)
    selected_scopes = deepcopy(core_scopes(refs, scopes))
    copies = deepcopy(expected_copies(saved, refs, selected_scopes, review_restoration))
    first = observe(core, refs, selected_scopes, copies, opener=opener)
    second = observe(core, refs, selected_scopes, copies, expected=first['fingerprint'], opener=opener)
    if first['observationId'] == second['observationId'] or date(second['observedAt']) < date(first['observedAt']):
        raise ValueError('Native storage observations are not fresh ordered reads')
    if content_hash(saved) != saved_hash:
        raise ValueError('The exact saved dispositions changed during storage observation')
    return {**second, 'initialObservationId': first['observationId'], 'initialObservedAt': first['observedAt'],
            'savedDispositionsSha256': saved_hash}
