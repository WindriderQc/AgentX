"""Observe exact live Gmail source state through Core; no mailbox mutations."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import re
import urllib.error
import urllib.request
import uuid

from native_history_decisions import HASH, digest, pairs, invalid_constant
from native_history_message_scope import references
from retention_plan import NATIVE_GAPS

CONTRACT = 'agentx.history-mailbox-scope/v1'
MAX_RESPONSE = 1024 * 1024
MAX_TOTAL = 16 * 1024 * 1024


def keys(value, expected):
    return isinstance(value, dict) and set(value) == set(expected.split())


def decimal(value):
    return isinstance(value, str) and re.fullmatch(r'0|[1-9][0-9]{0,31}', value) is not None


def coverage(mailbox, reference):
    if not keys(mailbox, 'contract reference accountSelectionSha256 status current scope') \
            or mailbox['contract'] != 'secretary.mailbox-source/v1' or mailbox['reference'] != reference \
            or not isinstance(mailbox['accountSelectionSha256'], str) or not HASH.fullmatch(mailbox['accountSelectionSha256']) \
            or mailbox['scope'] != 'selected-live-message-raw-and-metadata':
        raise ValueError('Native live mailbox evidence is invalid')
    row = mailbox['current']
    if mailbox['status'] == 'not_found' and row is None:
        return {'sourceMatches': None, 'direction': 'unknown', 'blockers': ['live_message_not_found']}
    if mailbox['status'] != 'present' or not keys(row, 'messageId threadId internalDate historyId labelIds raw') \
            or row['messageId'] != reference['messageId'] or not isinstance(row['threadId'], str) \
            or not re.fullmatch(r'[a-f0-9]{10,32}', row['threadId']) \
            or not decimal(row['internalDate']) or int(row['internalDate']) > 253402300799999 or not decimal(row['historyId']) \
            or not keys(row['raw'], 'sha256 bytes') or not isinstance(row['raw']['sha256'], str) \
            or not HASH.fullmatch(row['raw']['sha256']) or type(row['raw']['bytes']) is not int \
            or not 1 <= row['raw']['bytes'] <= 16 * 1024 * 1024 \
            or not isinstance(row['labelIds'], list) or len(row['labelIds']) > 256 \
            or any(not isinstance(label, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', label) for label in row['labelIds']) \
            or row['labelIds'] != sorted(set(row['labelIds'])):
        raise ValueError('Native live message metadata is invalid')
    source_matches = row['raw']['sha256'] == reference['sourceSha256']
    blockers = [code for condition, code in (
        (not source_matches, 'live_source_hash_mismatch'), (row['threadId'] != reference['threadId'], 'live_thread_mismatch'),
        ('DRAFT' in row['labelIds'], 'live_message_is_draft'), ('TRASH' in row['labelIds'], 'live_message_in_trash')) if condition]
    return {'sourceMatches': source_matches, 'direction': 'draft' if 'DRAFT' in row['labelIds'] else 'sent' if 'SENT' in row['labelIds'] else 'unknown',
            'blockers': blockers}


def observe(core, reference, finding, *, expected=None, opener=urllib.request.urlopen):
    observation_id = str(uuid.uuid4())
    body = {'source': reference, 'observationId': observation_id, **({'expected': expected} if expected is not None else {})}
    request = urllib.request.Request(f"{core.rstrip('/')}/api/secretary/history/decision-state/mailbox",
        data=json.dumps(body).encode(), method='POST',
        headers={'x-service-caller': 'secretary-retention-review', 'Content-Type': 'application/json'})
    try:
        with opener(request, timeout=60) as response:
            raw = response.read(MAX_RESPONSE + 1)
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ValueError('The exact native live mailbox scope is unavailable') from None
    if len(raw) > MAX_RESPONSE:
        raise ValueError('Native live mailbox scope exceeds its response capacity')
    value = json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)
    data = value.get('data') if isinstance(value, dict) and value.get('ok') is True else None
    if not isinstance(data, dict) or data.get('authority') != 'agentx.core' or data.get('contract') != CONTRACT \
            or data.get('observationId') != observation_id or data.get('status') != ('observed_match' if expected is not None else 'observed') \
            or data.get('consistency') != 'two-agreeing-live-message-reads-with-final-core-fence' \
            or type(data.get('mailboxEffects')) is not int or data['mailboxEffects'] != 0 or data.get('approvalBound') is not False \
            or data.get('atomicBatch') is not False or data.get('semanticAcceptance') is not False \
            or 'authenticatedPerson' not in data or data['authenticatedPerson'] is not None \
            or data.get('executionAllowed') is not False or data.get('cleanupStatus') != 'blocked' \
            or data.get('downstreamState') != 'not_rechecked' or data.get('nativeValidationGaps') != list(NATIVE_GAPS):
        raise ValueError('Core did not confirm the bounded live mailbox contract')
    snapshot = data.get('snapshot')
    native_core = finding.get('snapshot', {}).get('coreScope')
    if not keys(snapshot, 'contract reference mailbox coreScope coverage') or snapshot['contract'] != CONTRACT \
            or snapshot['reference'] != reference or finding.get('reference') != reference \
            or finding.get('snapshot', {}).get('reference') != reference \
            or digest(finding['snapshot']) != finding.get('fingerprint') \
            or not keys(native_core, 'contract fingerprint members') \
            or native_core['contract'] != 'agentx.history-message-scope/v1' \
            or digest(snapshot['coreScope']) != digest(native_core):
        raise ValueError('Native live mailbox source or Core membership changed')
    if digest(snapshot['coverage']) != digest(coverage(snapshot['mailbox'], reference)):
        raise ValueError('Native live mailbox blockers disagree with the observed metadata')
    if not isinstance(data.get('fingerprint'), str) or not HASH.fullmatch(data['fingerprint']) \
            or digest(snapshot) != data['fingerprint'] or (expected is not None and data['fingerprint'] != expected):
        raise ValueError('Native live mailbox fingerprint changed or is invalid')
    at = data.get('observedAt')
    if not isinstance(at, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z', at):
        raise ValueError('Native live mailbox observation date is invalid')
    datetime.fromisoformat(at.replace('Z', '+00:00'))
    return {'reference': reference, 'snapshot': snapshot, 'fingerprint': data['fingerprint'],
            'observationId': observation_id, 'observedAt': at}, len(raw)


def capture(core, saved, findings, before, *, opener=urllib.request.urlopen):
    refs = references(saved)
    by_message = {finding['reference']['messageId']: finding for finding in findings}
    if len(by_message) != len(findings) or set(by_message) != {ref['messageId'] for ref in refs}:
        raise ValueError('The complete selected live mailbox finding scope is unavailable')
    if before.utcoffset() is None:
        raise ValueError('Live mailbox cutoff needs an explicit timezone')
    cutoff_us = (before - datetime(1970, 1, 1, tzinfo=timezone.utc)) // timedelta(microseconds=1)
    out, received, selector = [], 0, None
    for reference in refs:
        finding = by_message[reference['messageId']]
        first, size = observe(core, reference, finding, opener=opener)
        received += size
        second, size = observe(core, reference, finding, expected=first['fingerprint'], opener=opener)
        received += size
        if received > MAX_TOTAL:
            raise ValueError('Native live mailbox observations exceed their aggregate capacity')
        mailbox = second['snapshot']['mailbox']
        if selector is not None and selector != mailbox['accountSelectionSha256']:
            raise ValueError('The native configured account selector changed across selected messages')
        selector = mailbox['accountSelectionSha256']
        row = mailbox['current']
        cutoff_blockers = ['live_message_outside_cutoff'] if row and int(row['internalDate']) * 1000 >= cutoff_us else []
        out.append({**second, 'initialObservationId': first['observationId'], 'initialObservedAt': first['observedAt'],
                    'cutoffBlockers': cutoff_blockers})
    return out
