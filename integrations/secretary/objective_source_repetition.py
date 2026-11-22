"""Literal quote overlap with an earlier selected authored passage.

This is a page-reading boundary, not an event or identity equivalence decision.
It consumes only the existing frozen input packet, never other mail or files.
"""
import hashlib
import re
from email.utils import parsedate_to_datetime

from source_quote_context import segments, normalized
import objective_actor_context as actors
import objective_input_scope as inputs
import objective_source_selection as selection


def _dated_header(value):
    try:
        result = parsedate_to_datetime(value)
        return result if result.utcoffset() is not None else None
    except (TypeError, ValueError, AttributeError, OverflowError):
        return None


def catalog(spans, context=None):
    context = context or {}
    packet = context.get('selectedInputContext')
    identity = context.get('primarySource', {}).get('identity', {})
    if not isinstance(packet, dict) or packet.get('contract') != inputs.CONTRACT \
            or packet.get('attachmentContentsIncluded') is not False:
        return []
    members = packet.get('members', [])
    own_key = str(identity.get('system')) + ':' + str(identity.get('messageId'))
    positions = [i for i, m in enumerate(members) if m.get('sourceKey') == own_key]
    if len(positions) != 1 or members[positions[0]].get('chronologyKnown') is not True:
        return []
    own = members[positions[0]]
    if own.get('sourceSha256') != identity.get('sourceSha256'):
        return []
    body = own.get('untrustedContent')
    if not isinstance(body, str) or hashlib.sha256(body.encode()).hexdigest() != own.get('representation', {}).get('textSha256'):
        return []
    peers = []
    for member in members[:positions[0]]:
        body = member.get('untrustedContent')
        if member.get('chronologyKnown') is not True or not isinstance(body, str) \
                or hashlib.sha256(body.encode()).hexdigest() != member.get('representation', {}).get('textSha256'):
            continue
        for segment in segments(body, member.get('headers', {})):
            if segment['relation'] == 'authored':
                text = body[segment['start']:segment['end']]
                view, offsets = normalized(text, casefold=False)
                peers.append((member, segment, text, view, offsets))
    rows = []
    blocked = selection.excluded(spans, context)
    for span in spans:
        if span['id'] in blocked:
            continue
        segment = actors.segment_for(span, context)
        if not segment or segment['relation'] != 'quoted':
            continue
        start, end = context['offset'] + span['start'], context['offset'] + span['end']
        if own.get('untrustedContent', '')[start:end] != span['text']:
            continue
        needle, _ = normalized(span['text'], casefold=False)
        if not needle:
            continue
        matches = []
        for member, part, text, view, offsets in peers:
            claimed = actors._author_identity(segment.get('claimedAuthor'))
            sender = actors._author_identity(member.get('headers', {}).get('from'))
            if claimed and sender and claimed[1] and sender[1] and claimed[1].casefold() != sender[1].casefold():
                continue  # Contradictory source headers must not erase a different speaker's event.
            claimed_at = _dated_header(segment.get('claimedDate'))
            source_at = _dated_header(member.get('headers', {}).get('date'))
            if claimed_at is not None and source_at is not None and not all(
                    re.search(r'\b\d{1,2}:\d{2}:\d{2}\b', value or '')
                    for value in (segment.get('claimedDate'), member.get('headers', {}).get('date'))):
                claimed_at, source_at = claimed_at.replace(second=0, microsecond=0), source_at.replace(second=0, microsecond=0)
            if claimed_at is not None and source_at is not None and claimed_at != source_at:
                continue
            left = r'(?<!\w)' if needle[0].isalnum() else ''
            right = r'(?!\w)' if needle[-1].isalnum() else ''
            match = re.search(left + re.escape(needle) + right, view)
            if match is None:
                continue
            position, stop = match.span()
            begin, finish = offsets[position], offsets[stop - 1] + 1
            matches.append({'sourceKey': member['sourceKey'], 'sourceSha256': member['sourceSha256'],
                'representation': member['representation'], 'start': part['start'] + begin,
                'end': part['start'] + finish, 'text': text[begin:finish]})
        if matches:
            rows.append({'citationId': span['id'], 'sourceSpan': {'start': start, 'end': end, 'text': span['text']},
                'selectedSourceMatches': matches, 'contextOnly': True, 'identityVerified': False,
                'eventEquivalenceVerified': False, 'matchingPolicy': 'literal-whitespace-and-quote-prefix-only'})
    return rows
