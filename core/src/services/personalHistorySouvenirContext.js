'use strict';
const contract = require('./personalHistoryContextContract');
const FIELDS = ['date', 'precision', 'endDate', 'endPrecision', 'ongoing', 'dateWindow', 'ageStartWindow', 'ageEndWindow',
  'ownerTimeLabel', 'ageDateNote', 'dateEstimateNote'];
function normalize(value) {
  if (value === undefined || value === null) return null;
  const keys = ['entryId', 'contextRevision', 'contextHash', 'temporal', 'claimsWithExactQuotes', 'sources'];
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k)) ||
    !/^[a-f0-9]{24}$/.test(value.entryId || '') || !/^[a-f0-9]{64}$/.test(value.contextHash || '') ||
    !Number.isSafeInteger(value.contextRevision) || value.contextRevision < 1) throw contract.fail('Invalid kept history context');
  if (!value.temporal || Object.keys(value.temporal).some(k => !FIELDS.includes(k))) throw contract.fail('Invalid kept temporal context');
  if (!Array.isArray(value.sources) || value.sources.length > contract.LIMITS.sources) throw contract.fail('Invalid kept context sources');
  const sources = value.sources.map(s => {
    if (!s || typeof s.id !== 'string' || !s.id || s.id.length > 256 || !/^[a-f0-9]{64}$/.test(s.bodySha256 || '') ||
      !['mail', 'document', 'media', 'ledger', 'testimony', 'conversation', 'calendar', 'unknown'].includes(s.kind) ||
      Object.keys(s).some(k => !['id', 'kind', 'bodySha256'].includes(k))) throw contract.fail('Invalid kept context source');
    return { id: s.id, kind: s.kind, bodySha256: s.bodySha256 };
  });
  const normalized = contract.timeline({ ...value.temporal, legacyId: value.entryId, title: 'Kept temporal context',
    sourceIds: sources.map(s => s.id), claimsWithExactQuotes: value.claimsWithExactQuotes });
  if (normalized.claimsWithExactQuotes.some(q => !sources.some(s => s.id === q.sourceId))) throw contract.fail('Missing kept quoted source');
  return { entryId: value.entryId, contextRevision: value.contextRevision, contextHash: value.contextHash,
    temporal: Object.fromEntries(FIELDS.filter(k => normalized[k] !== undefined).map(k => [k, normalized[k]])),
    claimsWithExactQuotes: normalized.claimsWithExactQuotes, sources };
}
function snapshot(entry, timeline) {
  if (!entry.context) return null;
  return normalize({ entryId: String(entry._id), contextRevision: entry.context.revision, contextHash: entry.context.inputHash,
    temporal: Object.fromEntries(FIELDS.filter(k => timeline[k] !== undefined).map(k => [k, timeline[k]])),
    claimsWithExactQuotes: timeline.claimsWithExactQuotes,
    sources: entry.context.sources.map(s => ({ id: s.id, kind: s.kind, bodySha256: s.bodySha256 })) });
}
module.exports = { normalize, snapshot };
