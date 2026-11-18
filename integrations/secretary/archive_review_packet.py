"""Bounded current selected review-file graph; bytes, never semantic acceptance."""
from __future__ import annotations

import json
from types import SimpleNamespace

import archive_preservation as native
from archive_findings import inventory as finding_inventory, metadata
from compound_sources import CONTRACT as COMPOUND, container_kind, identity
from evidence_attribution import review_pages
from history_coverage import content_hash
from secretary_evidence import REVIEW_PAGE_CHARS, message_text, parts

CONTRACT = 'secretary.archive-review-packet/v1'
MAX_FILES, MAX_PAGES, MAX_MEMBERS, MAX_MESSAGES = 256, 128, 128, 512


class ReviewPacketError(RuntimeError):
    def __init__(self, code='SECRETARY_REVIEW_PACKET_INTEGRITY', status=409):
        super().__init__('The selected current review-file graph could not be qualified')
        self.code, self.status = code, status


class Files:
    def __init__(self, files): self.source, self.files = files, files.files
    def read(self, path):
        if path not in self.source.files and len(self.source.files) >= MAX_FILES:
            raise ReviewPacketError('SECRETARY_REVIEW_PACKET_TOO_LARGE', 413)
        try: return self.source.read(path)
        except FileNotFoundError:
            raise ReviewPacketError('SECRETARY_REVIEW_PACKET_INCOMPLETE') from None
    def finish(self): self.source.finish()


class ReadPath:
    """Only the existing page producer's injected bounded reads; no real Path IO."""
    def __init__(self, files, relative=''): self.files, self.relative = files, relative
    def __truediv__(self, part):
        return ReadPath(self.files, self.relative + ('/' if self.relative else '') + str(part))
    def read_text(self, encoding='utf-8', errors='strict'):
        if encoding != 'utf-8': raise ReviewPacketError()
        return self.files.read(self.relative).decode(encoding, errors=errors)


def checked(files, record):
    return native.checked_bytes(files, record)


def compound(files, attachment):
    data = checked(files, attachment)
    if not container_kind(attachment.get('filename', ''), data[:512], attachment.get('mimeType') or ''):
        return 0
    sha = attachment['sha256']
    index = metadata(files, f'compound-sources/indexes/{sha}.json')
    rows = index.get('members')
    if index.get('schema') != COMPOUND or index.get('sourceSha256') != sha \
            or type(index.get('sourceBytes')) is not int or index['sourceBytes'] != attachment['bytes'] \
            or index.get('status') != 'complete' or index.get('errors') not in (None, []) \
            or not isinstance(rows, list) or len(rows) > MAX_MEMBERS:
        raise ReviewPacketError()
    seen = {sha}
    for row in rows:
        if not isinstance(row, dict) or row.get('parentId') not in seen or row.get('id') in seen \
                or type(row.get('ordinal')) is not int or row['ordinal'] < 0 \
                or not isinstance(row.get('nameAsWritten'), str) or not row['nameAsWritten'] \
                or len(row['nameAsWritten']) > 2048 \
                or row.get('id') != identity(row['parentId'], row['ordinal'], row['nameAsWritten']):
            raise ReviewPacketError()
        seen.add(row['id'])
        if row.get('kind') == 'file':
            if not isinstance(row.get('sha256'), str) or not native.HASH.fullmatch(row['sha256']) \
                    or row.get('path') != f"compound-sources/blobs/{row['sha256']}.bin":
                raise ReviewPacketError()
            checked(files, row)
        elif row.get('kind') != 'directory' or type(row.get('bytes')) is not int or row['bytes'] != 0:
            raise ReviewPacketError()
    return len(rows)


def qualify(opened, message_id, thread_id, source_sha256, request_id):
    files = Files(opened)
    findings = finding_inventory(files, message_id, thread_id, source_sha256, request_id)
    manifest = metadata(files, f'threads/{thread_id}/manifest.json')
    messages = manifest['messages']
    if len(messages) > MAX_MESSAGES: raise ReviewPacketError('SECRETARY_REVIEW_PACKET_TOO_LARGE', 413)
    selected = next(row for row in messages if row['id'] == message_id)
    original = metadata(files, f'threads/{thread_id}/original.json')
    thread = original.get('thread', original)
    originals = thread.get('messages') if isinstance(thread, dict) else None
    if not isinstance(originals, list) or not 1 <= len(originals) <= MAX_MESSAGES \
            or thread.get('id', thread_id) != thread_id:
        raise ReviewPacketError()
    by_id = {}
    for row in originals:
        mid = row.get('id') if isinstance(row, dict) else None
        if not isinstance(mid, str) or not native.MAIL_ID.fullmatch(mid) or mid in by_id \
                or row.get('threadId', thread_id) != thread_id: raise ReviewPacketError()
        by_id[mid] = row
    if message_id not in by_id or any(row['id'] not in by_id for row in messages): raise ReviewPacketError()
    body = message_text(by_id[message_id])
    if selected.get('bodySha256') != native.digest(body.encode()): raise ReviewPacketError()
    packet = files.read(f'threads/{thread_id}/packet.txt')
    if native.digest(packet) != findings['evidenceHash']: raise ReviewPacketError()
    lanes = metadata(files, 'value-lanes.json')
    lane = lanes.get('messages', {}).get(message_id)
    if lanes.get('schema') != 'agentx.secretary-value-lanes/v1' or not isinstance(lane, dict) \
            or lane.get('threadId') != thread_id or lane.get('lane') not in ('person', 'important', 'bulk'):
        raise ReviewPacketError()
    attachments = selected.get('attachments')
    if not isinstance(attachments, list) or len(attachments) > native.MAX_ATTACHMENTS:
        raise ReviewPacketError()
    attachment_ids = [row.get('partId') for row in attachments if isinstance(row, dict)]
    if len(attachment_ids) != len(attachments) or any(not isinstance(pid, str) for pid in attachment_ids) \
            or len(set(attachment_ids)) != len(attachment_ids): raise ReviewPacketError()
    source_parts = {}
    for number, part in enumerate(parts(by_id[message_id].get('payload', {}))):
        if number >= 4096: raise ReviewPacketError('SECRETARY_REVIEW_PACKET_TOO_LARGE', 413)
        if part.get('filename') or (part.get('body', {}).get('attachmentId') and not part.get('mimeType', '').startswith('text/')):
            part_id = part.get('partId')
            if not isinstance(part_id, str) or part_id in source_parts: raise ReviewPacketError()
            source_parts[part_id] = (number, part)
    if set(source_parts) != {row.get('partId') for row in attachments}: raise ReviewPacketError()
    member_count = 0
    for attachment in attachments:
        checked(files, attachment)
        number, part = source_parts[attachment['partId']]
        receipt = metadata(files, f'download-receipts/{message_id}-{number}.json')
        stored = receipt.get('attachment')
        if receipt.get('sourceHash') != native.digest(json.dumps(part, sort_keys=True).encode()) \
                or not isinstance(stored, dict) or any(stored.get(key) != attachment.get(key) for key in ('partId', 'path', 'sha256', 'bytes')) \
                or type(stored.get('bytes')) is not int:
            raise ReviewPacketError()
        text_path = attachment.get('textPath')
        if text_path:
            if text_path not in (attachment['path'] + '.txt', attachment['path'] + '.ocr.txt'): raise ReviewPacketError()
            files.read(text_path)
        if attachment.get('status') == 'ocr_text_extracted':
            receipt = metadata(files, f"ocr-receipts/{attachment['sha256']}.json")
            if receipt.get('attachment', {}).get('textPath') != text_path or not text_path \
                    or receipt['attachment'].get('status') != 'ocr_text_extracted': raise ReviewPacketError()
        member_count += compound(files, attachment)
        if member_count > MAX_MEMBERS: raise ReviewPacketError('SECRETARY_REVIEW_PACKET_TOO_LARGE', 413)
    root = ReadPath(files)
    pages, page_ids = {}, set()
    for page in review_pages(SimpleNamespace(root=root), manifest, load=lambda path: metadata(files, path.relative),
            message_text=message_text, sha=native.digest, json=json, page_chars=REVIEW_PAGE_CHARS, message_id=message_id):
        pid = page['pageId']
        if pid in page_ids: raise ReviewPacketError()
        page_ids.add(pid)
        if len(page_ids) > MAX_PAGES: raise ReviewPacketError('SECRETARY_REVIEW_PACKET_TOO_LARGE', 413)
        receipt = metadata(files, f'page-reviews/{pid}.json')
        if receipt.get('pageId') != pid or receipt.get('threadId') != thread_id \
                or receipt.get('evidenceHash', findings['evidenceHash']) != findings['evidenceHash']:
            raise ReviewPacketError()
        pages[pid] = content_hash(page)
    if not pages: raise ReviewPacketError()
    files.finish()
    from archive_restoration import file_set, set_hash
    rows = file_set(opened)
    return {'contract': CONTRACT, 'evidenceHash': findings['evidenceHash'], 'reviewSha256': findings['reviewSha256'],
            'pagesSha256': content_hash(pages), 'valueLanesSha256': content_hash(lanes), 'filesSha256': set_hash(rows),
            'counts': {'files': len(rows), 'bytes': sum(row[1] for row in rows), 'pages': len(pages),
                       'attachments': len(attachments), 'compoundMembers': member_count}}


def inventory(root, message_id, thread_id, source_sha256, request_id):
    opened = native.SourceFiles(root)
    try: return qualify(opened, message_id, thread_id, source_sha256, request_id)
    finally: opened.close()
