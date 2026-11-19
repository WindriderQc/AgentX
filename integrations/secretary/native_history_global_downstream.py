"""Bind the complete selected downstream graph to a final native joined fence."""
from __future__ import annotations

from datetime import datetime
import json
import re
import urllib.error
import urllib.request
import uuid

from native_history_decisions import digest, pairs, invalid_constant
from native_history_message_scope import references
from retention_plan import NATIVE_GAPS

CONTRACT = 'agentx.history-global-downstream/v1'
MAX_RESPONSE = 2 * 1024 * 1024


def expected_snapshot(saved, scopes):
    sources = references(saved)
    by_message = {row['reference']['messageId']: row for row in scopes}
    if len(by_message) != len(scopes) or set(by_message) != {ref['messageId'] for ref in sources}:
        raise ValueError('The complete selected global downstream scope is unavailable')
    members, seen, notes = [], {}, {}
    for reference in sources:
        row = by_message[reference['messageId']]
        snapshot = row['snapshot']
        if row['reference'] != reference or snapshot.get('reference') != reference \
                or snapshot.get('contract') != 'agentx.history-downstream-scope/v1' or digest(snapshot) != row['fingerprint']:
            raise ValueError('Selected global downstream source versions changed')
        members.append({key: row[key] for key in ('reference', 'fingerprint', 'snapshot')})
        for entry in snapshot['entries']:
            if entry['entryId'] in seen and digest(seen[entry['entryId']]) != digest(entry):
                raise ValueError('A shared global downstream entry changed')
            seen[entry['entryId']] = entry
            if entry['note']:
                note = entry['note']
                pin = (note['revision'], note['fingerprint'])
                if note['id'] in notes and digest(notes[note['id']]) != digest(pin):
                    raise ValueError('A shared global souvenir changed')
                notes[note['id']] = pin
    if len(seen) > 100:
        raise ValueError('The global downstream selection exceeds its entry capacity')
    counts = {'messages': len(sources), 'entries': len(seen), 'observedNotes': len(notes),
              **{key: sum(row['state'] == state for row in seen.values()) for state, key in (
                 ('not_linked', 'notLinked'), ('current_link', 'currentLinks'), ('unavailable', 'unavailable'), ('needs_review', 'needsReview'))},
              'heldMessages': sum(bool(row['snapshot']['coverage']['blockers']) for row in members)}
    return {'contract': CONTRACT, 'sources': sources, 'sourceSetSha256': digest(sources), 'members': members,
            'coverage': {'counts': counts, 'blockers': ['selected_native_downstream_needs_review'] if counts['heldMessages'] else []}}


def observe(core, snapshot, *, expected=None, opener=urllib.request.urlopen):
    observation_id = str(uuid.uuid4())
    body = {'sources': snapshot['sources'], 'observationId': observation_id,
            **({'expected': expected} if expected is not None else {})}
    request = urllib.request.Request(f"{core.rstrip('/')}/api/secretary/history/decision-state/downstream/global",
        data=json.dumps(body).encode(), method='POST',
        headers={'x-service-caller': 'secretary-retention-review', 'Content-Type': 'application/json'})
    try:
        with opener(request, timeout=240) as response:
            raw = response.read(MAX_RESPONSE + 1)
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ValueError('The complete native global downstream scope is unavailable') from None
    if len(raw) > MAX_RESPONSE:
        raise ValueError('The native global downstream scope exceeds its response capacity')
    value = json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)
    data = value.get('data') if isinstance(value, dict) and value.get('ok') is True else None
    if not isinstance(data, dict) or data.get('authority') != 'agentx.core' or data.get('contract') != CONTRACT \
            or data.get('observationId') != observation_id or data.get('status') != ('observed_match' if expected is not None else 'observed') \
            or data.get('consistency') != 'two-complete-downstream-passes-with-final-joined-core-note-fence' \
            or data.get('atomicBatch') is not False or data.get('semanticAcceptance') is not False \
            or 'authenticatedPerson' not in data or data['authenticatedPerson'] is not None \
            or data.get('executionAllowed') is not False or data.get('cleanupStatus') != 'blocked' \
            or data.get('downstreamState') != 'selected-linked-souvenirs-observed' or data.get('nativeValidationGaps') != list(NATIVE_GAPS):
        raise ValueError('Core did not confirm the native global downstream contract')
    fingerprint = digest(snapshot)
    if data.get('fingerprint') != fingerprint or digest(data.get('snapshot')) != fingerprint \
            or (expected is not None and expected != fingerprint):
        raise ValueError('The complete global downstream evidence changed')
    at = data.get('observedAt')
    if not isinstance(at, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z', at):
        raise ValueError('The native global downstream observation date is invalid')
    datetime.fromisoformat(at.replace('Z', '+00:00'))
    return {'snapshot': snapshot, 'fingerprint': fingerprint, 'observationId': observation_id, 'observedAt': at}


def capture(core, saved, scopes, *, opener=urllib.request.urlopen):
    snapshot = expected_snapshot(saved, scopes)
    first = observe(core, snapshot, opener=opener)
    second = observe(core, snapshot, expected=first['fingerprint'], opener=opener)
    return {**second, 'initialObservationId': first['observationId'], 'initialObservedAt': first['observedAt']}
