"""Bind a complete selected native finding set to one final global Core fence."""
from __future__ import annotations

from datetime import datetime
import json
import re
import urllib.error
import urllib.request
import uuid

from native_history_decisions import HASH, digest, pairs, invalid_constant
from native_history_message_scope import references
from retention_plan import NATIVE_GAPS

CONTRACT = 'agentx.history-global-decisions/v1'
MAX_RESPONSE = 2 * 1024 * 1024


def expected_snapshot(saved, findings):
    sources = references(saved)
    by_message = {row['reference']['messageId']: row for row in findings}
    if len(by_message) != len(findings) or set(by_message) != {ref['messageId'] for ref in sources}:
        raise ValueError('The complete selected global finding scope is unavailable')
    ordered, scopes = [], []
    counts = dict.fromkeys(('messages', 'entries', 'recordedFindings', 'noCoreReference', 'needsReview',
                           'observedDecision', 'threadQuestions', 'unmatchedEntries', 'heldMessages'), 0)
    seen = {}
    for reference in sources:
        row = by_message[reference['messageId']]
        snapshot = row['snapshot']
        if row['reference'] != reference or snapshot.get('reference') != reference or digest(snapshot) != row['fingerprint']:
            raise ValueError('Selected global finding source versions changed')
        ordered.append({key: row[key] for key in ('reference', 'fingerprint', 'snapshot')})
        core = snapshot['coreScope']
        scopes.append({'reference': reference, **core})
        for pin in core['members']:
            if pin['entryId'] in seen and digest(seen[pin['entryId']]) != digest(pin):
                raise ValueError('A shared global decision entry changed')
            seen[pin['entryId']] = pin
        for key in ('recordedFindings', 'noCoreReference', 'needsReview', 'observedDecision', 'threadQuestions', 'unmatchedEntries'):
            counts[key] += snapshot['coverage']['counts'][key]
        counts['heldMessages'] += bool(snapshot['coverage']['blockers'])
    counts.update(messages=len(sources), entries=len(seen))
    if len(seen) > 100:
        raise ValueError('The global decision selection exceeds its entry capacity')
    return {'contract': CONTRACT, 'sources': sources, 'sourceSetSha256': digest(sources), 'coreScopes': scopes,
            'findings': ordered, 'coverage': {'counts': counts,
            'blockers': ['selected_native_findings_need_review'] if counts['heldMessages'] else []}}


def observe(core, snapshot, *, expected=None, opener=urllib.request.urlopen):
    observation_id = str(uuid.uuid4())
    body = {'sources': snapshot['sources'], 'observationId': observation_id,
            **({'expected': expected} if expected is not None else {})}
    request = urllib.request.Request(f"{core.rstrip('/')}/api/secretary/history/decision-state/global",
        data=json.dumps(body).encode(), method='POST',
        headers={'x-service-caller': 'secretary-retention-review', 'Content-Type': 'application/json'})
    try:
        with opener(request, timeout=240) as response:
            raw = response.read(MAX_RESPONSE + 1)
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ValueError('The complete native global decision scope is unavailable') from None
    if len(raw) > MAX_RESPONSE:
        raise ValueError('The native global decision scope exceeds its response capacity')
    value = json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)
    data = value.get('data') if isinstance(value, dict) and value.get('ok') is True else None
    if not isinstance(data, dict) or data.get('authority') != 'agentx.core' or data.get('contract') != CONTRACT \
            or data.get('observationId') != observation_id or data.get('status') != ('observed_match' if expected is not None else 'observed') \
            or data.get('consistency') != 'two-complete-finding-passes-with-final-global-core-fence' \
            or data.get('atomicBatch') is not False or data.get('semanticAcceptance') is not False \
            or 'authenticatedPerson' not in data or data['authenticatedPerson'] is not None \
            or data.get('executionAllowed') is not False or data.get('cleanupStatus') != 'blocked' \
            or data.get('downstreamState') != 'not_rechecked' or data.get('nativeValidationGaps') != list(NATIVE_GAPS):
        raise ValueError('Core did not confirm the native global decision contract')
    # Canonical JSON equality also rejects bool/float substitutions for integers,
    # extra fields, omitted messages and unselected/private content in any member.
    if digest(data.get('snapshot')) != digest(snapshot):
        raise ValueError('The complete global native finding/Core versions changed')
    fingerprint = data.get('fingerprint')
    if not isinstance(fingerprint, str) or not HASH.fullmatch(fingerprint) or fingerprint != digest(snapshot) \
            or (expected is not None and fingerprint != expected):
        raise ValueError('The native global decision fingerprint changed or is invalid')
    at = data.get('observedAt')
    if not isinstance(at, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z', at):
        raise ValueError('The native global decision observation date is invalid')
    datetime.fromisoformat(at.replace('Z', '+00:00'))
    return {'snapshot': snapshot, 'fingerprint': fingerprint, 'observationId': observation_id, 'observedAt': at}


def capture(core, saved, findings, *, opener=urllib.request.urlopen):
    snapshot = expected_snapshot(saved, findings)
    first = observe(core, snapshot, opener=opener)
    second = observe(core, snapshot, expected=first['fingerprint'], opener=opener)
    return {**second, 'initialObservationId': first['observationId'], 'initialObservedAt': first['observedAt']}
