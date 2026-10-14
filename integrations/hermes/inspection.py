"""Closed, bounded Core evidence contract. This module never reads or dispatches images."""
import hashlib
import json
import re


def validate(payload, request):
    evidence = payload.get('referenceInspection')
    def fail():
        raise ValueError('Invalid verified reference-inspection evidence')
    def fields(value, allowed):
        return isinstance(value, dict) and not (set(value) - set(allowed))
    def sha(value):
        return isinstance(value, str) and bool(re.fullmatch('[a-f0-9]{64}', value))
    def positive(value):
        return type(value) is int and value > 0
    if evidence is None:
        if request.get('inspectReferences') is True:
            fail()
        return False
    if (not fields(evidence, ['version', 'source', 'referenceSha256', 'references', 'analysis', 'nativeReceipt'])
            or type(evidence.get('version')) is not int or evidence.get('version') != 1 or evidence.get('source') != 'openclaw-main'
            or not sha(evidence.get('referenceSha256')) or not isinstance(evidence.get('analysis'), str)
            or not evidence['analysis'].strip() or len(evidence['analysis'].encode('utf-16-le')) // 2 > 16000
            or not isinstance(evidence.get('references'), list) or not 1 <= len(evidence['references']) <= 2):
        fail()
    for position, row in enumerate(evidence['references']):
        if (not fields(row, ['kind', 'operationId', 'attachmentId', 'sha256', 'position', 'mimeType', 'byteLength', 'width', 'height', 'original', 'transform'])
                or row.get('position') != position or not sha(row.get('sha256'))
                or row.get('mimeType') not in ('image/png', 'image/jpeg')
                or not all(positive(row.get(key)) for key in ('byteLength', 'width', 'height'))
                or row.get('kind') not in ('parent', 'upload', 'sketch')):
            fail()
        if row['kind'] == 'parent':
            if position != 0 or not isinstance(row.get('operationId'), str) or not re.fullmatch('[a-f0-9-]{36}', row['operationId']):
                fail()
        elif not isinstance(row.get('attachmentId'), str) or not re.fullmatch('[a-f0-9]{24}', row['attachmentId']):
            fail()
        if row['kind'] == 'sketch' and position != len(evidence['references']) - 1:
            fail()
        if 'original' in row and (not fields(row['original'], ['sha256', 'mimeType', 'byteLength'])
                or not sha(row['original'].get('sha256')) or not isinstance(row['original'].get('mimeType'), str)
                or not positive(row['original'].get('byteLength'))):
            fail()
        if 'transform' in row and row['transform'] != 'browser-working-copy-v1':
            fail()
    if sum(row['byteLength'] for row in evidence['references']) > 3 * 1024 * 1024:
        fail()
    receipt = evidence.get('nativeReceipt')
    if (not fields(receipt, ['source', 'mode', 'requestId', 'runId', 'completion', 'requested'])
            or receipt.get('source') != 'openclaw' or receipt.get('mode') != 'agent'
            or receipt.get('completion') != 'completed' or not isinstance(receipt.get('requestId'), str)
            or not re.fullmatch('[a-f0-9-]{36}', receipt['requestId']) or not isinstance(receipt.get('runId'), str)
            or not 1 <= len(receipt['runId']) <= 260 or re.search('[\x00-\x1f]', receipt['runId'])
            or not fields(receipt.get('requested'), ['agentId']) or receipt['requested'].get('agentId') != 'main'):
        fail()
    serialized = json.dumps(evidence['references'], ensure_ascii=False, separators=(',', ':'))
    if (hashlib.sha256(serialized.encode()).hexdigest() != evidence['referenceSha256']
            or request.get('inspectReferences') is not True or request.get('references') != evidence['references']):
        fail()
    return True
