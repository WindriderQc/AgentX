'use strict';

const { createHash } = require('node:crypto');
const { PRECISIONS, eventDate, timestamp } = require('./personalHistoryTemporal');
const HASH = /^[a-f0-9]{64}$/;
const LIMITS = Object.freeze({ batch: 10, sources: 100, quotes: 100, relations: 100, media: 100,
  sourceBytes: 1024 * 1024, contextBytes: 3 * 1024 * 1024, metadataBytes: 65536 });
const SOURCE_SYSTEMS = Object.freeze(['gmail', 'outlook-export', 'document', 'media', 'ledger', 'testimony', 'conversation', 'calendar']);
const KINDS = ['mail', 'document', 'media', 'ledger', 'testimony', 'conversation', 'calendar', 'unknown'];
const OCCURRENCES = ['unknown', 'reported', 'planned', 'documented', 'occurred', 'cancelled'];
const fail = (message, statusCode = 400, code = 'PERSONAL_HISTORY_CONTEXT_INVALID') => Object.assign(new Error(message), { statusCode, code });
const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
function object(value, name, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw fail(`${name}.${key} is not supported`);
  return value;
}
function text(value, max, name, required = false) {
  if (value === undefined || value === null) { if (required) throw fail(`${name} is required`); return ''; }
  if (typeof value !== 'string' || value.length > max || /[\0\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw fail(`${name} is invalid or too long`);
  if (required && !value.trim()) throw fail(`${name} is required`);
  return value;
}
function id(value, name) { return text(value, 256, name, true); }
function choice(value, values, name, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!values.includes(value)) throw fail(`${name} is invalid`);
  return value;
}
function array(value, max, name, mapper) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) throw fail(`${name} must contain at most ${max} items`);
  return value.map(mapper);
}
const ids = (value, name, max = 100) => [...new Set(array(value, max, name, v => id(v, name)))];
function bool(value, name, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw fail(`${name} must be boolean`);
  return value;
}
// Descriptive imported annotations only. These values never select a model,
// command, file reader, approval policy or memory scope.
function metadata(value, name) {
  if (value === undefined || value === null) return null;
  let nodes = 0;
  const visit = (item, depth) => {
    if (++nodes > 2000 || depth > 8) throw fail(`${name} is too complex`);
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item === 'string') return text(item, 16000, name);
    if (Array.isArray(item)) { if (item.length > 200) throw fail(`${name} is too large`); return item.map(v => visit(v, depth + 1)); }
    if (!item || typeof item !== 'object') throw fail(`${name} contains an unsupported value`);
    const entries = Object.entries(item);
    if (entries.length > 100) throw fail(`${name} has too many fields`);
    return Object.fromEntries(entries.map(([key, v]) => {
      if (['__proto__', 'prototype', 'constructor'].includes(key) || key.startsWith('$') || key.includes('.') || key.length > 120) throw fail(`${name} has an unsafe key`);
      return [key, visit(v, depth + 1)];
    }));
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(canonical(result)) > LIMITS.metadataBytes) throw fail(`${name} is too large`);
  return result;
}
function quotes(value, name = 'claimsWithExactQuotes') {
  return array(value, LIMITS.quotes, name, q => {
    object(q, name, ['sourceId', 'quote', 'match', 'claimAuthor', 'label']);
    if (typeof q.quote !== 'string' || !q.quote.trim() || q.quote.length > 32000) throw fail('quote is invalid or too long');
    return { sourceId: id(q.sourceId, 'sourceId'), quote: q.quote,
      ...(q.label ? { label: text(q.label, 500, 'quote.label') } : {}),
      match: choice(q.match, ['exact', 'whitespace'], 'quote.match', 'exact'),
      ...(q.claimAuthor ? { claimAuthor: text(q.claimAuthor, 500, 'claimAuthor') } : {}) };
  });
}
function windowOf(value, name) {
  if (value === undefined || value === null) return null;
  object(value, name, ['start', 'end']);
  const result = { start: eventDate(value.start, 'day', fail), end: eventDate(value.end, 'day', fail) };
  if (result.start > result.end) throw fail(`${name} must be ordered`);
  return result;
}
function anchoredDate(value, precision, name) {
  if (value === undefined || value === null || value === '') return null;
  if (precision === 'unknown') throw fail(`${name} with unknown precision must remain empty`);
  // An imported display anchor can retain its ISO day while precision stays
  // year/month. It is never upgraded into an exact occurrence date.
  if (precision !== 'instant' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return eventDate(value, 'day', fail);
  return eventDate(value, precision, fail);
}
function bounds(value, precision) {
  if (precision === 'instant') return [value, value];
  const year = value.slice(0, 4);
  if (precision === 'year') return [`${year}-01-01T00:00:00.000Z`, `${year}-12-31T23:59:59.999Z`];
  if (precision === 'month') {
    const month = value.slice(0, 7);
    const last = new Date(`${month}-01T00:00:00Z`);
    last.setUTCMonth(last.getUTCMonth() + 1, 0);
    return [`${month}-01T00:00:00.000Z`, `${last.toISOString().slice(0, 10)}T23:59:59.999Z`];
  }
  return [`${value}T00:00:00.000Z`, `${value}T23:59:59.999Z`];
}
const TL_TEXT = ['legacyId', 'title', 'description', 'originalDate', 'originalEndDate', 'ownerTimeLabel', 'ageDateNote', 'dateEstimateNote',
  'timeCaveat', 'place', 'subjectPerson', 'status', 'rationale', 'notes', 'occurrenceStatusReason', 'calendarStatus', 'recurrenceRule', 'timezone'];
const TL_ANNOTATIONS = ['occurrenceHistory', 'enrichments', 'proposedRelations', 'ownerNarrative', 'eventTime', 'metadata'];
function timeline(value) {
  object(value, 'timeline', [...TL_TEXT, ...TL_ANNOTATIONS, 'category', 'importance', 'date', 'precision', 'endDate', 'endPrecision', 'ongoing',
    'dateWindow', 'ageStartWindow', 'ageEndWindow', 'tentativeDate', 'hypothesis', 'claimType', 'reviewState', 'occurrenceStatus', 'confirmationBasis',
    'sourceIds', 'claimsWithExactQuotes', 'legacyIds', 'flags', 'reviewQuestions', 'contradictions', 'relatedEventIds', 'sourceIndependence', 'narrative', 'calendarStart', 'calendarEnd', 'links']);
  const result = {};
  for (const key of TL_TEXT) if (value[key] !== undefined) result[key] = text(value[key], key === 'description' ? 16000 : key === 'rationale' ? 8000 : 2000, `timeline.${key}`);
  result.legacyId = id(value.legacyId, 'timeline.legacyId');
  result.title = text(value.title, 500, 'timeline.title', true);
  result.category = choice(value.category, ['home', 'people', 'work', 'travel', 'health', 'daily'], 'timeline.category', 'daily');
  result.precision = choice(value.precision, PRECISIONS, 'timeline.precision', 'unknown');
  result.date = anchoredDate(value.date, result.precision, 'timeline.date');
  result.endPrecision = choice(value.endPrecision, PRECISIONS, 'timeline.endPrecision', value.endDate ? result.precision : 'unknown');
  result.endDate = anchoredDate(value.endDate, result.endPrecision, 'timeline.endDate');
  if (result.date && result.endDate && bounds(result.date, result.precision)[0] > bounds(result.endDate, result.endPrecision)[1]) throw fail('timeline dates must be ordered');
  result.ongoing = bool(value.ongoing, 'timeline.ongoing');
  for (const key of ['dateWindow', 'ageStartWindow', 'ageEndWindow']) result[key] = windowOf(value[key], `timeline.${key}`);
  result.hypothesis = bool(value.hypothesis, 'timeline.hypothesis', value.claimType === 'hypothesis' || value.reviewState === 'hypothesis');
  result.claimType = choice(value.claimType, ['assertion', 'hypothesis'], 'timeline.claimType', result.hypothesis ? 'hypothesis' : 'assertion');
  result.reviewState = choice(value.reviewState, ['unreviewed', 'hypothesis', 'confirmed', 'dismissed', 'candidate'], 'timeline.reviewState', 'unreviewed');
  result.occurrenceStatus = choice(value.occurrenceStatus, OCCURRENCES, 'timeline.occurrenceStatus', 'unknown');
  result.confirmationBasis = choice(value.confirmationBasis, ['owner-testimony', 'owner-tentative', 'source-record', 'none'], 'timeline.confirmationBasis', 'none');
  result.sourceIndependence = choice(value.sourceIndependence, ['not-established', 'same-declaration', 'distinct-records'], 'sourceIndependence', 'not-established');
  result.sourceIds = ids(value.sourceIds, 'timeline.sourceIds');
  result.legacyIds = ids(value.legacyIds, 'timeline.legacyIds', 500);
  result.relatedEventIds = ids(value.relatedEventIds, 'timeline.relatedEventIds');
  result.links = array(value.links, 30, 'timeline.links', link => {
    object(link, 'timeline.link', ['label', 'href']);
    const href = text(link.href, 2048, 'link.href', true);
    let parsed;
    try { parsed = new URL(href); } catch (_) { throw fail('link.href must be an absolute HTTP URL'); }
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw fail('link.href must be an HTTP URL without credentials');
    return { label: text(link.label, 500, 'link.label', true), href };
  });
  result.claimsWithExactQuotes = quotes(value.claimsWithExactQuotes);
  for (const key of ['flags', 'reviewQuestions']) result[key] = array(value[key], 100, `timeline.${key}`, v => text(v, 4000, key, true));
  result.contradictions = array(value.contradictions, 100, 'timeline.contradictions', v => {
    if (typeof v === 'string') return text(v, 4000, 'contradiction', true);
    object(v, 'contradiction', ['description', 'sourceId']);
    return { description: text(v.description, 4000, 'contradiction.description', true), sourceId: id(v.sourceId, 'contradiction.sourceId') };
  });
  for (const key of TL_ANNOTATIONS) if (value[key] !== undefined) result[key] = metadata(value[key], `timeline.${key}`);
  if (value.tentativeDate !== undefined) result.tentativeDate = bool(value.tentativeDate, 'timeline.tentativeDate');
  if (value.importance !== undefined) {
    if (!Number.isFinite(value.importance) || value.importance < 0 || value.importance > 100) throw fail('timeline.importance must be 0-100');
    result.importance = value.importance;
  }
  for (const key of ['calendarStart', 'calendarEnd']) if (value[key]) result[key] = timestamp(value[key], fail).toISOString();
  if (value.narrative !== undefined && value.narrative !== null) {
    const n = object(value.narrative, 'timeline.narrative', ['chapterId', 'title', 'summary', 'pathId', 'pathLabel', 'order', 'label', 'context', 'pendingDate']);
    result.narrative = {};
    for (const key of ['chapterId', 'title', 'summary', 'pathId', 'pathLabel', 'label', 'context']) if (n[key] !== undefined) result.narrative[key] = text(n[key], 4000, `narrative.${key}`);
    if (n.order !== undefined && (!Number.isSafeInteger(n.order) || n.order < 0 || n.order > 10000)) throw fail('narrative.order is invalid');
    if (n.order !== undefined) result.narrative.order = n.order;
    result.narrative.pendingDate = bool(n.pendingDate, 'narrative.pendingDate');
  }
  return result;
}
function sourceRecord(value) {
  object(value, 'sourceRecord', ['id', 'kind', 'subject', 'body', 'bodySha256', 'nativePath', 'date', 'contentSha256', 'authority',
    'nativeRef', 'nativeSourceRefs', 'provenance', 'metadataOnly', 'rfc822MessageId', 'statementSha256', 'statementPath', 'hashKind']);
  // Preserve exact archive text, including PDF page separators. It is data,
  // never a path to open or an instruction to execute.
  const body = value.body === undefined ? '' : value.body;
  if (typeof body !== 'string') throw fail('sourceRecord.body must be text');
  if (Buffer.byteLength(body) > LIMITS.sourceBytes) throw fail('sourceRecord.body exceeds the byte limit');
  if (!HASH.test(value.bodySha256 || '') || digest(body) !== value.bodySha256) throw fail('sourceRecord.bodySha256 does not match the exact body');
  const result = { id: id(value.id, 'sourceRecord.id'), kind: choice(value.kind, KINDS, 'sourceRecord.kind', 'unknown'),
    subject: text(value.subject, 2000, 'sourceRecord.subject'), body, bodySha256: value.bodySha256,
    nativePath: text(value.nativePath, 4096, 'sourceRecord.nativePath'), date: value.date ? timestamp(value.date, fail).toISOString() : null,
    authority: choice(value.authority, ['source-record', 'direct-owner-statement', 'inferred'], 'sourceRecord.authority', 'source-record'),
    metadataOnly: bool(value.metadataOnly, 'sourceRecord.metadataOnly') };
  for (const key of ['contentSha256', 'statementSha256']) if (value[key]) {
    if (!HASH.test(value[key])) throw fail(`sourceRecord.${key} must be SHA-256`); result[key] = value[key];
  }
  for (const key of ['rfc822MessageId', 'statementPath', 'hashKind']) if (value[key]) result[key] = text(value[key], 4096, `sourceRecord.${key}`);
  for (const key of ['nativeRef', 'nativeSourceRefs', 'provenance']) if (value[key] !== undefined) result[key] = metadata(value[key], `sourceRecord.${key}`);
  return result;
}
function relation(value) {
  object(value, 'relation', ['id', 'title', 'kind', 'eventIds', 'summary', 'rationale', 'limits', 'sourceIndependence', 'claimsWithExactQuotes',
    'contextLegacyEventRefs', 'contextSourceIds', 'unresolvedLegacyEventIds', 'provenance']);
  const result = { id: id(value.id, 'relation.id'), title: text(value.title, 2000, 'relation.title', true),
    kind: choice(value.kind, ['agreement', 'sequence', 'conflict', 'hypothesis'], 'relation.kind'),
    eventIds: ids(value.eventIds, 'relation.eventIds'), sourceIndependence: choice(value.sourceIndependence,
      ['not-established', 'same-declaration', 'distinct-records'], 'sourceIndependence', 'not-established'),
    claimsWithExactQuotes: quotes(value.claimsWithExactQuotes) };
  for (const key of ['summary', 'rationale', 'limits']) result[key] = text(value[key], 8000, `relation.${key}`);
  result.contextSourceIds = ids(value.contextSourceIds, 'relation.contextSourceIds');
  result.unresolvedLegacyEventIds = ids(value.unresolvedLegacyEventIds, 'relation.unresolvedLegacyEventIds');
  result.contextLegacyEventRefs = metadata(value.contextLegacyEventRefs, 'relation.contextLegacyEventRefs');
  result.provenance = metadata(value.provenance, 'relation.provenance');
  return result;
}
function mediaRecord(value) {
  const stringKeys = ['id', 'sourceId', 'filename', 'thumbnailFilename', 'originalPath', 'caption', 'dateBasis', 'dateNote', 'associationBasis', 'album', 'associationStatus'];
  object(value, 'media', [...stringKeys, 'hash', 'sha256', 'sourceContentSha256', 'candidateEventIds', 'date', 'datePrecision', 'cover', 'provenance']);
  const result = {};
  for (const key of stringKeys) result[key] = text(value[key], key === 'id' || key === 'sourceId' ? 256 : 4096, `media.${key}`, key === 'id');
  for (const key of ['filename', 'thumbnailFilename']) if (result[key] && (result[key].startsWith('/') || result[key].includes('..') || !/^[a-zA-Z0-9_./-]+$/.test(result[key]))) throw fail(`media.${key} must be a relative asset key`);
  for (const key of ['hash', 'sha256', 'sourceContentSha256']) if (value[key]) {
    if (!HASH.test(value[key])) throw fail(`media.${key} must be SHA-256`); result[key] = value[key];
  }
  result.candidateEventIds = ids(value.candidateEventIds, 'media.candidateEventIds');
  result.datePrecision = choice(value.datePrecision, PRECISIONS, 'media.datePrecision', 'unknown');
  result.date = anchoredDate(value.date, result.datePrecision, 'media.date'); result.cover = bool(value.cover, 'media.cover');
  result.provenance = metadata(value.provenance, 'media.provenance');
  return result;
}
function normalize(input) {
  object(input, 'entry', ['entryId', 'sourceKey', 'expectedContextRevision', 'importId', 'entry', 'timeline', 'sourceRecords', 'relations', 'media']);
  const importId = id(input.importId, 'importId');
  if (!/^[a-zA-Z0-9_.:-]+$/.test(importId)) throw fail('importId must be a namespaced stable identity');
  if (!Number.isSafeInteger(input.expectedContextRevision) || input.expectedContextRevision < 0) throw fail('expectedContextRevision is required');
  if (input.entryId !== undefined && (!/^[a-f0-9]{24}$/.test(input.entryId || '') || !HASH.test(input.sourceKey || ''))) throw fail('Existing entries require entryId and exact sourceKey');
  if (input.sourceKey !== undefined && !HASH.test(input.sourceKey || '')) throw fail('sourceKey must be SHA-256');
  if (!input.entryId && !input.entry) throw fail('A new entry requires native history provenance');
  const context = { importId, reviewAuthority: 'imported-source-metadata', timeline: timeline(input.timeline),
    sources: array(input.sourceRecords, LIMITS.sources, 'sourceRecords', sourceRecord),
    relations: array(input.relations, LIMITS.relations, 'relations', relation), media: array(input.media, LIMITS.media, 'media', mediaRecord) };
  if (!context.sources.length || !context.timeline.sourceIds.length || !context.timeline.claimsWithExactQuotes.length) throw fail('A moment needs sources and at least one quoted claim');
  const map = new Map();
  for (const source of context.sources) { if (map.has(source.id)) throw fail('Duplicate sourceRecord.id'); map.set(source.id, source); }
  for (const sid of context.timeline.sourceIds) if (!map.has(sid)) throw fail(`Missing sourceRecord: ${sid}`);
  for (const claim of [...context.timeline.claimsWithExactQuotes, ...context.relations.flatMap(r => r.claimsWithExactQuotes)]) {
    const source = map.get(claim.sourceId);
    if (!source) throw fail(`Missing quoted source: ${claim.sourceId}`);
    const fold = s => s.replace(/\s+/gu, ' ').trim();
    if (!(claim.match === 'whitespace' ? fold(source.body).includes(fold(claim.quote)) : source.body.includes(claim.quote))) throw fail(`Quote does not match source: ${claim.sourceId}`);
  }
  for (const relation of context.relations) {
    for (const sid of relation.contextSourceIds) if (!map.has(sid)) throw fail(`Missing relation source: ${sid}`);
    if (relation.kind === 'agreement' && new Set(relation.claimsWithExactQuotes.map(q => map.get(q.sourceId).bodySha256)).size < 2) throw fail('Agreement requires at least two distinct source bodies');
  }
  if (Buffer.byteLength(canonical(context)) > LIMITS.contextBytes) throw fail('Context exceeds the byte limit');
  return { entryId: input.entryId, sourceKey: input.sourceKey, expectedContextRevision: input.expectedContextRevision, entry: input.entry,
    context: { ...context, inputHash: digest(canonical(context)) }, importKey: digest(importId) };
}

module.exports = { LIMITS, SOURCE_SYSTEMS, normalize, timeline, sourceRecord, digest, fail };
