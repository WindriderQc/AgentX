"""Compare Core's native review manifest with already verified child scopes.

Only Core observations establish native evidence. No local manifest input,
approval, cleanup, memory write or automatic retry is supported.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import re
import urllib.error
import urllib.request
import uuid

from native_history_decisions import digest, pairs, invalid_constant
from native_history_global_decisions import expected_snapshot as decision_snapshot
from native_history_global_downstream import expected_snapshot as downstream_snapshot
from native_history_mailbox_scope import coverage as mailbox_coverage
from native_history_restoration_scope import selection, REVIEW_CONTRACT, validate_review_copy
from retention_plan import NATIVE_GAPS

CONTRACT = 'agentx.history-review-manifest/v1'
MAX_RESPONSE = 2 * 1024 * 1024
MAX_SNAPSHOT = 1024 * 1024
CONSISTENCY = 'composed-native-scopes-with-final-joined-core-note-fence'


def canonical_before(before):
    if not isinstance(before, datetime) or before.utcoffset() is None or before.microsecond % 1000:
        raise ValueError('Native review manifest cutoff needs a timezone and exact milliseconds')
    return before.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def proof(row, contract):
    if not isinstance(row, dict) or not isinstance(row.get('snapshot'), dict) \
            or row['snapshot'].get('contract') != contract or digest(row['snapshot']) != row.get('fingerprint'):
        raise ValueError('A verified native review component is unavailable or changed')
    return {key: row[key] for key in ('fingerprint', 'snapshot')}


def ordered(rows, sources):
    if not isinstance(rows, list) or len(rows) != len(sources) \
            or any(not isinstance(row, dict) or row.get('reference') != ref for row, ref in zip(rows, sources)):
        raise ValueError('The complete ordered native review selection is unavailable')
    return rows


def expected_snapshot(saved, checks, before, decisions, downstream, restoration, mailbox):
    cutoff = canonical_before(before)
    selected = selection(saved, checks)
    sources = [check['source'] for check in selected]
    decision = proof(decisions, 'agentx.history-global-decisions/v1')
    linked = proof(downstream, 'agentx.history-global-downstream/v1')
    restored = proof(restoration, REVIEW_CONTRACT)
    findings = ordered(decision['snapshot'].get('findings'), sources)
    members = ordered(linked['snapshot'].get('members'), sources)
    if digest(decision_snapshot(saved, findings)) != decision['fingerprint'] \
            or digest(downstream_snapshot(saved, members)) != linked['fingerprint']:
        raise ValueError('The native global review components changed')
    restore = restored['snapshot']
    if set(restore) != {'contract', 'sourceSetSha256', 'pins', 'members'} \
            or restore['sourceSetSha256'] != digest(sources) \
            or not isinstance(restore['pins'], list) or len(restore['pins']) != len(sources) \
            or not isinstance(restore['members'], list) or len(restore['members']) != len(sources):
        raise ValueError('The complete retained native review restoration is unavailable')
    live = ordered(mailbox, sources)
    live_proofs, messages, selectors = [], [], set()
    cutoff_ms = (before - datetime(1970, 1, 1, tzinfo=timezone.utc)) // timedelta(milliseconds=1)
    for check, finding, member, pin, retained, row in zip(selected, findings, members, restore['pins'], restore['members'], live):
        ref = check['source']
        finding_proof = {key: finding[key] for key in ('fingerprint', 'snapshot')}
        if digest(member['snapshot'].get('findingScope')) != digest(finding_proof):
            raise ValueError('Linked souvenirs no longer bind the same selected findings')
        if not isinstance(pin, dict) or set(pin) != set(check) | {'entryRevision', 'basisHash', 'privacyHash'} \
                or any(digest(pin.get(key)) != digest(value) for key, value in check.items()) \
                or not isinstance(retained, dict) or set(retained) != set(check) | {'snapshot'} \
                or any(digest(retained.get(key)) != digest(value) for key, value in check.items()):
            raise ValueError('Retained native review restoration pins changed')
        restored_entry = retained['snapshot']
        if not isinstance(restored_entry, dict) or digest(restored_entry) != check['snapshotHash'] \
                or restored_entry.get('contract') != 'agentx.history-preservation/v3' \
                or restored_entry.get('status') != 'verified_scope' or restored_entry.get('blockers') != [] \
                or not isinstance(restored_entry.get('copies'), list) or len(restored_entry['copies']) != 2:
            raise ValueError('A retained native v3 review restoration is unavailable')
        for copy in restored_entry['copies']:
            validate_review_copy(copy)
            graph = copy['content']['reviewPacket']
            if any(graph[key] != finding['snapshot']['inventory'][key] for key in ('evidenceHash', 'reviewSha256')):
                raise ValueError('Retained native review restoration no longer binds the same findings')
        live_proof = proof(row, 'agentx.history-mailbox-scope/v1')
        snapshot = live_proof['snapshot']
        if snapshot.get('reference') != ref or digest(snapshot.get('coreScope')) != digest(finding['snapshot']['coreScope']) \
                or digest(snapshot.get('coverage')) != digest(mailbox_coverage(snapshot.get('mailbox'), ref)):
            raise ValueError('The live mailbox no longer binds the same selected Core scope')
        live_proofs.append({'reference': ref, **live_proof})
        current = snapshot['mailbox']['current']
        selectors.add(snapshot['mailbox']['accountSelectionSha256'])
        blockers = list(dict.fromkeys([
            *finding['snapshot']['coverage']['blockers'], *member['snapshot']['coverage']['blockers'],
            *snapshot['coverage']['blockers'],
            *(['live_message_outside_cutoff'] if current and int(current['internalDate']) >= cutoff_ms else [])]))
        messages.append({'reference': ref, 'blockers': blockers, 'reviewStatus': 'held' if blockers else 'observed',
                         'candidateForOwnerReview': False})
    if len(selectors) != 1:
        raise ValueError('The native mailbox account selection changed')
    counts = {'messages': len(sources), 'entries': decision['snapshot']['coverage']['counts']['entries'],
              'observedNotes': linked['snapshot']['coverage']['counts']['observedNotes'],
              'livePresent': sum(row['snapshot']['mailbox']['status'] == 'present' for row in live),
              'evidenceHeldMessages': sum(bool(row['blockers']) for row in messages), 'candidatesForOwnerReview': 0}
    snapshot = {'contract': CONTRACT, 'before': cutoff, 'sources': sources, 'sourceSetSha256': digest(sources),
                'checksSha256': digest(selected), 'decisions': decision, 'downstream': linked, 'restoration': restored,
                'mailbox': live_proofs, 'coverage': {'messages': messages, 'counts': counts,
                'blockers': [*NATIVE_GAPS, *(['selected_evidence_needs_review'] if counts['evidenceHeldMessages'] else [])]}}
    if len(json.dumps(snapshot, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()) > MAX_SNAPSHOT:
        raise ValueError('The native review manifest exceeds its snapshot capacity')
    return snapshot


def observe(core, checks, snapshot, *, expected=None, opener=urllib.request.urlopen):
    observation_id = str(uuid.uuid4())
    body = {'checks': checks, 'before': snapshot['before'], 'observationId': observation_id,
            **({'expected': expected} if expected is not None else {})}
    request = urllib.request.Request(f"{core.rstrip('/')}/api/secretary/history/review-manifest",
        data=json.dumps(body, allow_nan=False).encode(), method='POST',
        headers={'x-service-caller': 'secretary-retention-review', 'Content-Type': 'application/json'})
    try:
        with opener(request, timeout=960) as response:
            raw = response.read(MAX_RESPONSE + 1)
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ValueError('The complete native review manifest is unavailable') from None
    if len(raw) > MAX_RESPONSE:
        raise ValueError('The native review manifest exceeds its response capacity')
    value = json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)
    data = value.get('data') if isinstance(value, dict) and value.get('ok') is True else None
    if not isinstance(data, dict) or set(data) != {
            'authority', 'contract', 'observationId', 'observedAt', 'snapshot', 'fingerprint', 'status', 'consistency',
            'reviewOnly', 'atomicBatch', 'semanticAcceptance', 'authenticatedPerson', 'mailboxEffects',
            'approvalBound', 'executionAllowed', 'cleanupStatus', 'nativeValidationGaps'} \
            or data['authority'] != 'agentx.core' or data['contract'] != CONTRACT \
            or data['observationId'] != observation_id or data['status'] != ('observed_match' if expected is not None else 'observed') \
            or data['consistency'] != CONSISTENCY or data['reviewOnly'] is not True \
            or data['atomicBatch'] is not False or data['semanticAcceptance'] is not False \
            or data['authenticatedPerson'] is not None or type(data['mailboxEffects']) is not int or data['mailboxEffects'] != 0 \
            or data['approvalBound'] is not False or data['executionAllowed'] is not False \
            or data['cleanupStatus'] != 'blocked' or data['nativeValidationGaps'] != list(NATIVE_GAPS):
        raise ValueError('Core did not confirm the native review manifest contract')
    fingerprint = digest(snapshot)
    if data['fingerprint'] != fingerprint or digest(data['snapshot']) != fingerprint \
            or (expected is not None and expected != fingerprint):
        raise ValueError('The complete native review manifest evidence changed')
    at = data['observedAt']
    if not isinstance(at, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z', at):
        raise ValueError('The native review manifest observation date is invalid')
    datetime.fromisoformat(at.replace('Z', '+00:00'))
    return data


def capture(core, saved, checks, before, decisions, downstream, restoration, mailbox, *, opener=urllib.request.urlopen):
    snapshot = expected_snapshot(saved, checks, before, decisions, downstream, restoration, mailbox)
    selected = selection(saved, checks)
    first = observe(core, selected, snapshot, opener=opener)
    second = observe(core, selected, snapshot, expected=first['fingerprint'], opener=opener)
    return {**second, 'initialObservationId': first['observationId'], 'initialObservedAt': first['observedAt']}
