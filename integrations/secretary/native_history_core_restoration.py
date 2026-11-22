"""Observe native temporary restoration of the exact selected Core records.

Core owns full source documents and native Mongo verification. This consumer
accepts only bounded proof metadata bound to an already verified v10 scope.
"""
from __future__ import annotations

from datetime import datetime
import json
import re
import urllib.error
import urllib.request
import uuid

from native_history_decisions import HASH, digest, pairs, invalid_constant
from native_history_global_downstream import expected_snapshot
from retention_plan import NATIVE_GAPS

CONTRACT = 'agentx.history-core-restoration/v1'
ENGINE_CONTRACT = 'agentx.core-temporary-restoration/v1'
MAX_RESPONSE = 2 * 1024 * 1024
MAX_SNAPSHOT = 1024 * 1024
MAX_DOCUMENT_BYTES = 512 * 1024
MAX_TOTAL_BYTES = 16 * 1024 * 1024


def keys(value, expected):
    return isinstance(value, dict) and set(value) == set(expected.split())


def expected_bindings(saved, downstream):
    try:
        snapshot = downstream['snapshot']
        if snapshot.get('contract') != 'agentx.history-global-downstream/v1' \
                or digest(snapshot) != downstream.get('fingerprint') \
                or digest(expected_snapshot(saved, snapshot['members'])) != digest(snapshot):
            raise ValueError('The verified native global downstream scope changed')
        return {'sources': snapshot['sources'], 'sourceSetSha256': snapshot['sourceSetSha256'], 'members': [
            {'reference': row['reference'], 'coreScope': row['snapshot']['findingScope']['snapshot']['coreScope'],
             'entries': row['snapshot']['entries']} for row in snapshot['members']]}
    except (KeyError, TypeError, AttributeError):
        raise ValueError('The complete verified native global downstream scope is unavailable') from None


def validate_restoration(restoration, bindings):
    if not keys(restoration, 'contract collections verificationSha256 temporaryCopyRemoved') \
            or restoration['contract'] != ENGINE_CONTRACT or restoration['temporaryCopyRemoved'] is not True \
            or restoration['verificationSha256'] != digest(bindings) \
            or not keys(restoration['collections'], 'history souvenirs'):
        raise ValueError('Core did not confirm complete native temporary restoration')
    entries = {entry['entryId'] for member in bindings['members'] for entry in member['entries']}
    notes = {entry['note']['id'] for member in bindings['members'] for entry in member['entries'] if entry['note'] is not None}
    total_bytes = 0
    for name, count in (('history', len(entries)), ('souvenirs', len(notes))):
        group = restoration['collections'][name]
        if not keys(group, 'documents bytes sourceDocumentsSha256 restoredDocumentsSha256 indexes sourceIndexesSha256 restoredIndexesSha256') \
                or any(type(group[key]) is not int for key in ('documents', 'bytes', 'indexes')) \
                or group['documents'] != count or not 0 <= group['documents'] <= 100 \
                or not count <= group['bytes'] <= count * MAX_DOCUMENT_BYTES \
                or not 1 <= group['indexes'] <= 64 \
                or any(not isinstance(group[key], str) or not HASH.fullmatch(group[key]) for key in (
                    'sourceDocumentsSha256', 'restoredDocumentsSha256', 'sourceIndexesSha256', 'restoredIndexesSha256')) \
                or group['sourceDocumentsSha256'] != group['restoredDocumentsSha256'] \
                or group['sourceIndexesSha256'] != group['restoredIndexesSha256']:
            raise ValueError('Native temporary Core collection proof is invalid or incomplete')
        total_bytes += group['bytes']
    if total_bytes > MAX_TOTAL_BYTES:
        raise ValueError('Native temporary Core restoration exceeds its document capacity')


def observe(core, bindings, *, expected=None, opener=urllib.request.urlopen):
    observation_id = str(uuid.uuid4())
    body = {'sources': bindings['sources'], 'expectedBindingsSha256': digest(bindings), 'observationId': observation_id,
            **({'expected': expected} if expected is not None else {})}
    request = urllib.request.Request(f"{core.rstrip('/')}/api/secretary/history/core-restoration",
        data=json.dumps(body, allow_nan=False).encode(), method='POST',
        headers={'x-service-caller': 'secretary-retention-review', 'Content-Type': 'application/json'})
    try:
        with opener(request, timeout=240) as response:
            raw = response.read(MAX_RESPONSE + 1)
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ValueError('The complete native Core restoration is unavailable') from None
    if len(raw) > MAX_RESPONSE:
        raise ValueError('The native Core restoration exceeds its response capacity')
    value = json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)
    data = value.get('data') if isinstance(value, dict) and value.get('ok') is True else None
    if not keys(data, 'authority contract observationId observedAt snapshot fingerprint status consistency scope indexState reviewOnly atomicBatch semanticAcceptance authenticatedPerson canonicalEffects executionAllowed cleanupStatus nativeValidationGaps') \
            or data['authority'] != 'agentx.core' or data['contract'] != CONTRACT \
            or data['observationId'] != observation_id or data['status'] != ('observed_match' if expected is not None else 'observed') \
            or data['consistency'] != 'native-typed-core-restore-with-final-source-fence' \
            or data['scope'] != 'selected-current-history-and-linked-active-souvenirs' \
            or data['indexState'] != 'mongo-index-definitions-only' or data['reviewOnly'] is not True \
            or data['atomicBatch'] is not False or data['semanticAcceptance'] is not False \
            or data['authenticatedPerson'] is not None or type(data['canonicalEffects']) is not int or data['canonicalEffects'] != 0 \
            or data['executionAllowed'] is not False or data['cleanupStatus'] != 'blocked' \
            or data['nativeValidationGaps'] != list(NATIVE_GAPS):
        raise ValueError('Core did not confirm the native Core restoration contract')
    snapshot = data['snapshot']
    if not keys(snapshot, 'contract bindings bindingsSha256 restoration') or snapshot['contract'] != CONTRACT \
            or snapshot['bindingsSha256'] != digest(bindings) or digest(snapshot['bindings']) != digest(bindings):
        raise ValueError('Native Core restoration no longer binds the verified selected evidence')
    if len(json.dumps(snapshot, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()) > MAX_SNAPSHOT:
        raise ValueError('The native Core restoration exceeds its snapshot capacity')
    validate_restoration(snapshot['restoration'], bindings)
    fingerprint = digest(snapshot)
    if not isinstance(data['fingerprint'], str) or not HASH.fullmatch(data['fingerprint']) \
            or data['fingerprint'] != fingerprint or (expected is not None and fingerprint != expected):
        raise ValueError('The native Core restoration evidence changed or failed its fingerprint check')
    at = data['observedAt']
    if not isinstance(at, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z', at):
        raise ValueError('The native Core restoration observation date is invalid')
    datetime.fromisoformat(at.replace('Z', '+00:00'))
    return data


def capture(core, saved, downstream, *, opener=urllib.request.urlopen):
    bindings = expected_bindings(saved, downstream)
    first = observe(core, bindings, opener=opener)
    second = observe(core, bindings, expected=first['fingerprint'], opener=opener)
    return {**second, 'initialObservationId': first['observationId'], 'initialObservedAt': first['observedAt']}
