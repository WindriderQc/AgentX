import { createHash } from 'node:crypto';
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fields = (value, allowed) => value && !Array.isArray(value) && typeof value === 'object'
  && Object.keys(value).every(key => allowed.includes(key));
const fail = () => { throw new Error('Invalid verified reference-inspection evidence'); };
export function validateInspection(input) {
  const evidence = input.referenceInspection;
  const context = input.action === 'plan' ? input.request : input.context;
  if (evidence === undefined) {
    if (context?.inspectReferences === true) fail();
    return;
  }
  if (!fields(evidence, ['version', 'source', 'referenceSha256', 'references', 'analysis', 'nativeReceipt'])
    || evidence.version !== 1 || evidence.source !== 'openclaw-main' || !sha(evidence.referenceSha256)
    || typeof evidence.analysis !== 'string' || !evidence.analysis.trim() || !evidence.analysis.isWellFormed()
    || evidence.analysis.length > 16000 || !Array.isArray(evidence.references)
    || evidence.references.length < 1 || evidence.references.length > 2) fail();
  for (const [position, row] of evidence.references.entries()) {
    if (!fields(row, ['kind', 'operationId', 'attachmentId', 'sha256', 'position', 'mimeType', 'byteLength', 'width', 'height', 'original', 'transform'])
      || row.position !== position || !sha(row.sha256) || !['image/png', 'image/jpeg'].includes(row.mimeType)
      || ![row.byteLength, row.width, row.height].every(n => Number.isSafeInteger(n) && n > 0)
      || !['parent', 'upload', 'sketch'].includes(row.kind)
      || (row.kind === 'parent' ? !/^[a-f0-9-]{36}$/.test(row.operationId || '') || position !== 0 : !/^[a-f0-9]{24}$/.test(row.attachmentId || ''))
      || (row.kind === 'sketch' && position !== evidence.references.length - 1)) fail();
    if (row.original && (!fields(row.original, ['sha256', 'mimeType', 'byteLength']) || !sha(row.original.sha256)
      || typeof row.original.mimeType !== 'string' || !Number.isSafeInteger(row.original.byteLength) || row.original.byteLength < 1)) fail();
    if (row.transform !== undefined && row.transform !== 'browser-working-copy-v1') fail();
  }
  if (evidence.references.reduce((sum, row) => sum + row.byteLength, 0) > 3 * 1024 * 1024) fail();
  const receipt = evidence.nativeReceipt;
  if (!fields(receipt, ['source', 'mode', 'requestId', 'runId', 'completion', 'requested'])
    || receipt.source !== 'openclaw' || receipt.mode !== 'agent' || receipt.completion !== 'completed'
    || typeof receipt.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(receipt.requestId)
    || typeof receipt.runId !== 'string' || !receipt.runId || receipt.runId.length > 260 || /[\x00-\x1f]/.test(receipt.runId)
    || !fields(receipt.requested, ['agentId']) || receipt.requested.agentId !== 'main') fail();
  if (createHash('sha256').update(JSON.stringify(evidence.references)).digest('hex') !== evidence.referenceSha256
    || context?.inspectReferences !== true || JSON.stringify(context.references) !== JSON.stringify(evidence.references)) fail();
}
