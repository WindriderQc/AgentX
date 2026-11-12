'use strict';

const { createHash } = require('node:crypto');
const CONTRACT = 'secretary.archive-reader/v3';
const SNAPSHOT_CONTRACT = 'agentx.history-source-review/v2';
const LEGACY_CONTRACT = 'agentx.history-source-review/v1';
const HEADER_NAMES = ['From', 'To', 'Cc', 'Date', 'Subject'];
const HASH = /^[a-f0-9]{64}$/;
const MAX_SNAPSHOT_BYTES = 256 * 1024;
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' && !(value instanceof Date)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const failure = (message, statusCode = 409, code = 'HISTORY_SOURCE_REVIEW_CHANGED') => Object.assign(new Error(message), { statusCode, code });

function basis(row) {
  return digest([String(row._id), row.key, row.revision, row.kind, row.text, row.actor, row.sourceDate,
    row.source, row.relatedSources, row.reviewState, row.assertionState, row.eventDate, row.eventDatePrecision,
    row.context?.revision || 0, row.context?.inputHash || '', row.context?.overrides || {}]);
}

function references(row) {
  const seen = new Set();
  return [row.source, ...(row.relatedSources || [])].filter(Boolean).map(source => ({
    system: source.system, id: source.id || '', messageId: source.messageId || '', threadId: source.threadId || '',
    sourceSha256: source.sourceSha256, findingId: source.findingId
  })).filter(source => {
    const identity = digest([source.system, source.id, source.messageId, source.threadId, source.sourceSha256]);
    if (seen.has(identity)) return false;
    seen.add(identity); return true;
  });
}

function describe(reference, result, contract = SNAPSHOT_CONTRACT) {
  if (![SNAPSHOT_CONTRACT, LEGACY_CONTRACT].includes(contract)) throw failure('The source review contract is unsupported.');
  if (result?.readerContract !== CONTRACT || result.messageId !== reference.messageId
    || result.threadId !== reference.threadId || result.sourceSha256 !== reference.sourceSha256
    || !Array.isArray(result.bodyRepresentations) || result.bodyRepresentations.length > 4096
    || !Number.isSafeInteger(result.attachmentCount) || result.attachmentCount < 0) {
    throw failure('The native archived source did not confirm its exact identity and reader contract.');
  }
  const indices = new Set();
  const parts = result.bodyRepresentations.map(part => {
    if (!Number.isSafeInteger(part.partIndex) || part.partIndex < 0 || part.partIndex >= 4096 || indices.has(part.partIndex)
      || typeof part.readable !== 'boolean' || !Number.isSafeInteger(part.totalChars) || part.totalChars < 0
      || (part.readable && !HASH.test(part.textSha256 || ''))) throw failure('The native text representation is incomplete.');
    indices.add(part.partIndex);
    return { partIndex: part.partIndex, mimeType: String(part.mimeType || '').slice(0, 100),
      readable: part.readable, totalChars: part.totalChars, textSha256: part.textSha256 || null,
      metadataHash: digest(part) };
  }).sort((a, b) => a.partIndex - b.partIndex);
  const gaps = [];
  let headers;
  if (contract === SNAPSHOT_CONTRACT) {
    if (!result.headers || typeof result.headers !== 'object' || Array.isArray(result.headers)
      || HEADER_NAMES.some(name => typeof result.headers[name] !== 'string' || Array.from(result.headers[name]).length > 2000)) {
      throw failure('The native archived source did not confirm its bounded original headers.');
    }
    headers = Object.fromEntries(HEADER_NAMES.map(name => [name, result.headers[name]]));
    if (HEADER_NAMES.some(name => Array.from(headers[name]).length === 2000)) gaps.push('original_header_length_limit');
  }
  if (!parts.some(part => part.readable)) gaps.push('no_readable_text');
  if (parts.some(part => !part.readable)) gaps.push('unreadable_text_representation');
  if (result.attachmentCount) gaps.push('attachments_not_reviewed');
  // Supplements and reader warnings vary with the selected part. The frozen
  // scope covers text representations only, not those per-part supplements.
  if (parts.some(part => part.mimeType === 'text/html')) gaps.push('html_supplement_not_reviewed');
  if (Object.keys(result.compoundAttachments || {}).length) gaps.push('compound_members_not_reviewed');
  if (result.bodyRepresentations.some(part => part.extractionGaps?.length || part.extraction)) gaps.push('extracted_text_limits');
  return { reference, status: 'available', readerContract: CONTRACT, parts, gaps,
    ...(headers ? { headers } : {}),
    metadataHash: digest([result.bodyRepresentations, result.attachmentCount, result.attachments,
      result.compoundAttachments]) };
}

async function collect(row, mail, contract = SNAPSHOT_CONTRACT) {
  if (![SNAPSHOT_CONTRACT, LEGACY_CONTRACT].includes(contract)) throw failure('The source review contract is unsupported.');
  const refs = references(row);
  if (!refs.length || refs.length > 19) throw failure('Choose an existing bounded historical source set.', 400);
  const sources = [];
  for (const reference of refs) {
    if (reference.system !== 'gmail') {
      sources.push({ reference, status: 'unavailable', code: 'SOURCE_READER_NOT_SUPPORTED' }); continue;
    }
    try {
      const value = await mail.archived({ messageId: reference.messageId, sha256: reference.sourceSha256, offset: 0 });
      sources.push(describe(reference, value, contract));
    } catch (error) {
      sources.push({ reference, status: 'unavailable', code: /^[A-Z0-9_]{1,80}$/.test(error.code || '')
        ? error.code : 'SOURCE_READER_UNAVAILABLE' });
    }
  }
  const snapshot = { contract, scope: 'readable-text-representations-only', sources };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_SNAPSHOT_BYTES) throw failure('The source snapshot exceeds its bounded capacity.', 413);
  return snapshot;
}

function initialCoverage(snapshot) {
  return snapshot.sources.flatMap((source, index) => (source.parts || []).filter(part => part.readable)
    .map(part => ({ source: index, part: part.partIndex, nextOffset: 0, served: false })));
}
function coverageOf(review) {
  const available = review.snapshot.sources.every(source => source.status === 'available');
  const complete = available && review.coverage.length > 0 && review.coverage.every(progress => {
    const part = review.snapshot.sources[progress.source].parts.find(part => part.partIndex === progress.part);
    return progress.served && progress.nextOffset === part.totalChars;
  }) && review.snapshot.sources.every(source => source.parts.some(part => part.readable));
  return { status: complete ? 'served_selected_text' : available ? 'partial' : 'unknown',
    parts: review.coverage.length, servedParts: review.coverage.filter(progress => progress.served).length,
    gaps: review.snapshot.sources.flatMap((source, index) => source.status === 'unavailable'
      ? [{ source: index, code: source.code }] : source.gaps.map(code => ({ source: index, code }))),
    meaning: 'Pages served, not comprehension, fact confirmation, complete semantic acceptance or cleanup permission.' };
}

module.exports = { CONTRACT, digest, failure, basis, references, collect, describe, initialCoverage, coverageOf };
