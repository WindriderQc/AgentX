"""Read current native binding of an existing historical human confirmation.

Only native observations qualify the receipt. This reader never prepares or
confirms one, changes canonical data, retries, or grants cleanup authority.
"""
from __future__ import annotations

from datetime import datetime
import json
import re
import urllib.error
import urllib.request
import uuid

from native_history_core_restoration import (
    CONTRACT as RESTORATION_CONTRACT, expected_bindings, keys, validate_restoration,
)
from native_history_decisions import HASH, digest, pairs, invalid_constant
from native_history_restoration_scope import UUID, selection
from native_history_review_manifest import (
    CONTRACT as MANIFEST_CONTRACT, canonical_before, expected_snapshot, proof,
)
from retention_plan import NATIVE_GAPS

CONTRACT = 'agentx.history-manifest-confirmation-current/v1'
CONFIRMATION_CONTRACT = 'agentx.history-manifest-confirmation/v1'
CONSISTENCY = 'native-confirmation-binding-with-final-source-fence'
MAX_RESPONSE = 64 * 1024
MAX_SNAPSHOT = 16 * 1024
DATE = re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\Z')


def request_identity(request_id):
    if not isinstance(request_id, str) or not UUID.fullmatch(request_id):
        raise ValueError('Use the original human confirmation request UUID')
    return request_id


def date(value):
    if not isinstance(value, str) or not DATE.fullmatch(value):
        raise ValueError('Native confirmation dates must be canonical UTC milliseconds')
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if canonical_before(parsed) != value:
        raise ValueError('Native confirmation dates must be canonical UTC milliseconds')
    return parsed


def components(saved, checks, before, manifest, core_restoration):
    """Recompose the complete verified graph before sending any native request."""
    selected = selection(saved, checks)
    cutoff = canonical_before(before)
    try:
        reviewed = proof(manifest, MANIFEST_CONTRACT)
        snapshot = reviewed['snapshot']
        expected = expected_snapshot(saved, selected, before, snapshot['decisions'], snapshot['downstream'],
                                     snapshot['restoration'], snapshot['mailbox'])
        if digest(expected) != reviewed['fingerprint']:
            raise ValueError('The verified native review manifest changed')
        bindings = expected_bindings(saved, snapshot['downstream'])
        restored = proof(core_restoration, RESTORATION_CONTRACT)
        snapshot = restored['snapshot']
        if not keys(snapshot, 'contract bindings bindingsSha256 restoration') \
                or snapshot['bindingsSha256'] != digest(bindings) or digest(snapshot['bindings']) != digest(bindings):
            raise ValueError('The verified native Core restoration changed')
        validate_restoration(snapshot['restoration'], bindings)
    except (KeyError, TypeError, AttributeError, IndexError):
        raise ValueError('The complete verified native review and Core restoration proofs are required') from None
    current = {'manifestSha256': reviewed['fingerprint'], 'coreRestorationSha256': restored['fingerprint']}
    current['bindingSha256'] = digest({'contract': CONFIRMATION_CONTRACT, **current})
    return selected, {'contract': CONTRACT, 'before': cutoff,
        'inputSha256': digest({'checks': selected, 'before': cutoff}), 'checksSha256': digest(selected),
        'sourceSetSha256': digest([check['source'] for check in selected]), 'selectedMessages': len(selected),
        'current': current, 'confirmationStatus': 'current'}


def validate_snapshot(snapshot, expected, observed_at):
    if not keys(snapshot, 'contract requestId before inputSha256 checksSha256 sourceSetSha256 selectedMessages confirmation current confirmationStatus') \
            or any(digest(snapshot[key]) != digest(value) for key, value in expected.items()) \
            or type(snapshot['selectedMessages']) is not int or not 1 <= snapshot['selectedMessages'] <= 20:
        raise ValueError('The native human confirmation no longer binds the exact verified selection')
    if len(json.dumps(snapshot, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()) > MAX_SNAPSHOT:
        raise ValueError('The native confirmation exceeds its snapshot capacity')
    confirmation = snapshot['confirmation']
    if not keys(confirmation, 'contract requestId inputSha256 bindingSha256 manifestSha256 coreRestorationSha256 preparedAt confirmedAt recordedVia authenticatedPerson') \
            or confirmation['contract'] != CONFIRMATION_CONTRACT \
            or confirmation['requestId'] != expected['requestId'] \
            or confirmation['inputSha256'] != expected['inputSha256'] \
            or confirmation['recordedVia'] != 'private_lan_surface' \
            or confirmation['authenticatedPerson'] is not None \
            or any(confirmation[key] != value for key, value in expected['current'].items()):
        raise ValueError('The original human confirmation is unavailable, changed or historical only')
    if not date(confirmation['preparedAt']) <= date(confirmation['confirmedAt']) <= observed_at:
        raise ValueError('The original human confirmation dates are inconsistent')


def observe(core, request_id, checks, snapshot, *, previous=None, opener=urllib.request.urlopen):
    observation_id = str(uuid.uuid4())
    expected = previous['fingerprint'] if previous is not None else None
    body = {'checks': checks, 'before': snapshot['before'], 'observationId': observation_id,
            **({'expected': expected} if expected is not None else {})}
    request = urllib.request.Request(
        f"{core.rstrip('/')}/api/secretary/history/manifest-confirmations/{request_id}/current",
        data=json.dumps(body, allow_nan=False).encode(), method='POST',
        headers={'x-service-caller': 'secretary-retention-review', 'Content-Type': 'application/json'})
    try:
        with opener(request, timeout=1200) as response:
            raw = response.read(MAX_RESPONSE + 1)
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ValueError('The current native human confirmation is unavailable') from None
    if len(raw) > MAX_RESPONSE:
        raise ValueError('The native confirmation exceeds its response capacity')
    value = json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)
    data = value.get('data') if isinstance(value, dict) and value.get('ok') is True else None
    return validate_observation(data, snapshot, observation_id, previous)


def validate_observation(data, expected_snapshot, observation_id, previous=None):
    """Validate a native v13 envelope without transport or other side effects."""
    expected = previous['fingerprint'] if previous is not None else None
    if not keys(data, 'authority contract observationId observedAt snapshot fingerprint status consistency reviewOnly atomicBatch semanticAcceptance authenticatedPerson approvalBound mailboxEffects executionAllowed cleanupStatus nativeValidationGaps') \
            or data['authority'] != 'agentx.core' or data['contract'] != CONTRACT \
            or data['observationId'] != observation_id \
            or data['status'] != ('observed_match' if expected is not None else 'observed') \
            or data['consistency'] != CONSISTENCY or data['reviewOnly'] is not True \
            or data['atomicBatch'] is not False or data['semanticAcceptance'] is not False \
            or data['authenticatedPerson'] is not None or data['approvalBound'] is not False \
            or type(data['mailboxEffects']) is not int or data['mailboxEffects'] != 0 \
            or data['executionAllowed'] is not False or data['cleanupStatus'] != 'blocked' \
            or data['nativeValidationGaps'] != list(NATIVE_GAPS):
        raise ValueError('Core did not confirm the current native human confirmation contract')
    at = date(data['observedAt'])
    validate_snapshot(data['snapshot'], expected_snapshot, at)
    fingerprint = data['fingerprint']
    if not isinstance(fingerprint, str) or not HASH.fullmatch(fingerprint) \
            or digest(data['snapshot']) != fingerprint \
            or (previous is not None and (fingerprint != expected
                or digest(data['snapshot']) != digest(previous['snapshot']) or at < date(previous['observedAt']))):
        raise ValueError('The original human confirmation or its complete current binding changed')
    return data


def capture(core, request_id, saved, checks, before, manifest, core_restoration, *, opener=urllib.request.urlopen):
    request_identity(request_id)
    selected, snapshot = components(saved, checks, before, manifest, core_restoration)
    snapshot['requestId'] = request_id
    first = observe(core, request_id, selected, snapshot, opener=opener)
    second = observe(core, request_id, selected, snapshot, previous=first, opener=opener)
    return {**second, 'initialObservationId': first['observationId'], 'initialObservedAt': first['observedAt']}
