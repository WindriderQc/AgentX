"""Versioned actor reading from the existing frozen source segments.

This changes new objectives only. Dates keep their existing conservative
contract, and a supported actor remains a proposal, never owner confirmation.
"""
import copy
from email.headerregistry import HeaderRegistry
from email.utils import unquote
import re
import unicodedata

CONTRACT = 'secretary.segment-actor-reading/v1'
POLICY = ('Proposed actors use the frozen segment containing the entire primary excerpt. '
          'An authored sent segment may support its own sender, even when another segment is quoted. '
          'Quoted and unresolved text never inherits the containing sender. '
          'These reading signals establish neither verified identity nor owner confirmation.')


def contract_for(manifest):
    contract = manifest.get('actorReadingContract')
    if contract not in (None, CONTRACT):
        raise ValueError('Unsupported objective actor reading contract')
    if contract and not manifest.get('attributionContract'):
        raise ValueError('Segment actor reading requires frozen source attribution')
    return contract


def system(base, contract):
    return base if contract is None else base + '\n\n' + POLICY


def extraction_context(context, original, record, manifest):
    contract = contract_for(manifest)
    if contract is None:
        return context
    native = record.get('nativeRef', record)
    return {**(context or {}), 'actorReadingContract': contract,
            'actorDirection': (original or {}).get('direction', 'unknown'),
            'actorSourceSegments': copy.deepcopy(native.get('sourceContext', {}).get('segments', []))}


def segment_for(span, context):
    segments = context.get('actorSourceSegments')
    offset = context.get('offset')
    if not isinstance(segments, list) or type(offset) is not int or offset < 0:
        return None
    start, end = offset + span['start'], offset + span['end']
    intersecting = [s for s in segments if isinstance(s, dict) and type(s.get('start')) is int
                    and type(s.get('end')) is int and s['start'] < end and s['end'] > start]
    if len(intersecting) != 1:
        return None
    segment = intersecting[0]
    return segment if segment['start'] <= start < end <= segment['end'] else None


def _author_identity(author):
    """A single literal name/mailbox, never a substring or a selected list member."""
    if not isinstance(author, str) or not author.strip() or any(c in author for c in '\r\n'):
        return None
    author = author.strip()
    if re.fullmatch(r'"(?:[^"\\]|\\.)*"', author):
        return unquote(author), None
    if not any(c in author for c in '@<>,;"'):
        return author, None
    try:
        header = HeaderRegistry()('From', author)
    except ValueError:
        return None
    if header.defects or len(header.addresses) != 1:
        return None
    address = header.addresses[0]
    if not address.username or not address.domain:
        return None
    return address.display_name, address.addr_spec


def _owner_author(author, aliases):
    identity = _author_identity(author)
    if identity is None or not aliases:
        return None
    normalize = lambda s: unicodedata.normalize('NFC', ' '.join(s.split())).casefold()
    name, address = identity
    for alias in aliases:
        if isinstance(alias, str) and alias.strip() and not any(c in alias for c in '@<>'):
            if name and normalize(unquote(alias.strip())) == normalize(name):
                return True
            continue
        candidate = _author_identity(alias)
        if candidate is None:
            continue
        alias_name, alias_address = candidate
        if alias_address and address and normalize(alias_address) == normalize(address) \
                or alias_address is None and name and normalize(alias_name) == normalize(name):
            return True
    return False


def reading_contexts(spans, context):
    aliases = context.get('ownerAliases', [])
    aliases = aliases if isinstance(aliases, list) else []
    result = {}
    for span in spans:
        segment = segment_for(span, context)
        owner, basis = False, 'unresolved-speaker'
        if segment:
            relation = segment.get('relation')
            author = segment.get('author') if relation == 'authored' else segment.get('claimedAuthor')
            matches_owner = _owner_author(author, aliases)
            if relation == 'authored' and context.get('actorDirection') != 'draft' and isinstance(author, str) and author.strip():
                if context.get('actorDirection') == 'sent' and matches_owner is True:
                    owner, basis = True, 'sent-authored-segment-reading-context'
                elif matches_owner is False:
                    basis = 'other-authored-segment-reading-context'
            elif relation == 'quoted' and matches_owner is not None:
                owner = matches_owner
                basis = 'owner-alias-header-reading-context' if owner else 'quoted-speaker'
        result[span['id']] = owner, basis, None
    return result
