"""Bounded selected source/analysis delivery, never semantic acceptance.

Only native graph-selected resources can be read. All source descriptors remain
open until the original byte fence completes; caller paths are never accepted.
"""
from __future__ import annotations

import base64
import json
from types import SimpleNamespace

import archive_preservation as native
import archive_review_packet as graph
from archive_findings import FindingsError, metadata
from compound_sources import container_kind
from evidence_attribution import review_pages
from history_coverage import SECTIONS, finding_id
from secretary_evidence import REVIEW_PAGE_CHARS, message_text

CONTRACT = 'secretary.archive-semantic-review/v1'
ANALYSIS_CONTRACT = 'secretary.selected-semantic-analysis/v1'
MAX_RESOURCES, PAGE_BYTES = 256, 32768
MAX_BYTES = 16 * 1024 * 1024


class SemanticReviewError(RuntimeError):
    def __init__(self, code='SECRETARY_SEMANTIC_REVIEW_INTEGRITY', status=409):
        super().__init__('The selected native source and analysis delivery could not be verified')
        self.code, self.status = code, status


def analysis(files, message_id, thread_id, source_sha256, manifest):
    review = metadata(files, f'reviews/{thread_id}.json')
    findings = [{'section': section, 'findingId': finding_id(thread_id, section, item), 'item': item}
                for section in SECTIONS for item in review[section] if item['messageId'] == message_id]
    pages = []
    root = graph.ReadPath(files)
    for page in review_pages(SimpleNamespace(root=root), manifest,
            load=lambda path: metadata(files, path.relative), message_text=message_text,
            sha=native.digest, json=json, page_chars=REVIEW_PAGE_CHARS, message_id=message_id):
        pages.append({'source': page, 'review': metadata(files, f"page-reviews/{page['pageId']}.json")})
        if len(pages) > graph.MAX_PAGES:
            raise SemanticReviewError('SECRETARY_SEMANTIC_REVIEW_TOO_LARGE', 413)
    return json.dumps({'contract': ANALYSIS_CONTRACT, 'messageId': message_id, 'threadId': thread_id,
        'sourceSha256': source_sha256, 'findings': findings, 'threadQuestions': review['unresolved'],
        'pages': pages}, sort_keys=True, ensure_ascii=False, allow_nan=False).encode()


def resources(opened, message_id, thread_id, source_sha256):
    files = graph.Files(opened)
    receipt = metadata(files, f'raw-receipts/{message_id}.json')
    manifest = metadata(files, f'threads/{thread_id}/manifest.json')
    selected = next(row for row in manifest['messages'] if row['id'] == message_id)
    result = [('original', 'original', native.checked_bytes(files, receipt))]
    # Match the original preservation descriptor order, independent of how the
    # native manifest happens to order attachment rows.
    for attachment in sorted(selected['attachments'], key=lambda row: row['partId']):
        data = native.checked_bytes(files, attachment)
        result.append(('attachment', attachment['partId'], data))
        if container_kind(attachment.get('filename', ''), data[:512], attachment.get('mimeType') or ''):
            index = metadata(files, f"compound-sources/indexes/{attachment['sha256']}.json")
            for member in index['members']:
                if member['kind'] == 'file':
                    result.append(('compound_member', member['id'], native.checked_bytes(files, member)))
    result.append(('analysis', 'selected-analysis', analysis(files, message_id, thread_id, source_sha256, manifest)))
    if len(result) > MAX_RESOURCES or sum(len(row[2]) for row in result) > MAX_BYTES:
        raise SemanticReviewError('SECRETARY_SEMANTIC_REVIEW_TOO_LARGE', 413)
    # Compound index ids are unique within their own parent graph. Duplicate
    # same-content attachments may repeat one member: preserve each occurrence
    # as a separate resource rather than silently omitting source coverage.
    return result


def probe(root, message_id, thread_id, source_sha256, request_id, *, resource=None, offset=0):
    if any(not isinstance(value, str) or not pattern.fullmatch(value) for pattern, value in (
            (native.MAIL_ID, message_id), (native.MAIL_ID, thread_id),
            (native.HASH, source_sha256), (native.UUID, request_id))) \
            or type(offset) is not int or offset < 0 or offset > MAX_BYTES \
            or resource is None and offset != 0 \
            or resource is not None and (type(resource) is not int or not 0 <= resource < MAX_RESOURCES):
        raise SemanticReviewError('SECRETARY_SEMANTIC_REVIEW_INVALID', 400)
    selected = {}

    def inspect(opened, _proof):
        packet = graph.qualify(opened, message_id, thread_id, source_sha256, request_id)
        values = resources(opened, message_id, thread_id, source_sha256)
        selected['reviewPacket'] = packet
        selected['resources'] = [{'kind': kind, 'key': key, 'sha256': native.digest(data), 'bytes': len(data)}
                                 for kind, key, data in values]
        if resource is not None:
            if resource >= len(values) or offset > len(values[resource][2]):
                raise SemanticReviewError('SECRETARY_SEMANTIC_REVIEW_INVALID', 400)
            data = values[resource][2]
            chunk = data[offset:offset + PAGE_BYTES]
            end = offset + len(chunk)
            selected['page'] = {'resource': resource, 'offset': offset,
                'nextOffset': end if end < len(data) else None,
                'contentBase64': base64.b64encode(chunk).decode('ascii'), 'chunkSha256': native.digest(chunk)}

    try:
        # _probe performs another complete byte fence after inspect returns.
        proof = native._probe(root, message_id, thread_id, source_sha256, request_id, inspect_files=inspect)
        return {**proof, 'contract': CONTRACT, **selected, 'semanticAcceptance': False, 'executionAllowed': False}
    except SemanticReviewError:
        raise
    except (native.PreservationError, graph.ReviewPacketError, FindingsError) as error:
        if error.status == 413:
            raise SemanticReviewError('SECRETARY_SEMANTIC_REVIEW_TOO_LARGE', 413) from None
        raise SemanticReviewError() from None
    except OSError:
        raise SemanticReviewError('SECRETARY_SEMANTIC_REVIEW_UNAVAILABLE', 503) from None
    except (ValueError, TypeError, LookupError, AttributeError, RecursionError):
        raise SemanticReviewError() from None
