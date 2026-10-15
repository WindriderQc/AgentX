'use strict';

const { createHash } = require('node:crypto');
const Entry = require('../../models/PersonalHistoryEntry');
const { sealText } = require('./identifierVault');
const privacy = require('./personalHistoryPrivacy');

const KINDS = ['action', 'fact', 'deliverable', 'invoice', 'calendar', 'contact'];
const STATES = ['candidate', 'retained', 'resolved', 'dismissed', 'forgotten'];
const ASSERTIONS = ['unknown', 'reported', 'planned', 'confirmed', 'cancelled', 'disputed'];
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9_-]{8,256}$/;
const digest = text => createHash('sha256').update(text).digest('hex');
const failure = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode, code: 'PERSONAL_HISTORY_INVALID' });
const text = (value, maximum, required = false) => {
  if (value === undefined || value === null || value === '') {
    if (required) throw failure('Text is required');
    return '';
  }
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0')) throw failure(`Text exceeds ${maximum} characters or is invalid`);
  const clean = value.trim();
  if (required && !clean) throw failure('Text is required');
  return clean;
};
const enumValue = (value, values, fallback) => {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!values.includes(value)) throw failure(`Choose ${values.join(', ')}`);
  return value;
};

function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      || !Number.isFinite(Date.parse(value))) throw failure('An ISO timestamp with timezone is required');
  const day = value.slice(0, 10);
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) throw failure('The calendar date is invalid');
  return new Date(value);
}

function eventDate(value, precision) {
  if (precision === 'unknown') {
    if (value) throw failure('An unknown event date must remain empty');
    return '';
  }
  if (precision === 'instant') return date(value).toISOString();
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
      || date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw failure('A day must be YYYY-MM-DD');
  return value;
}

function normalize(input = {}) {
  const source = input.source || {};
  const system = enumValue(source.system, ['gmail', 'outlook-export']);
  for (const key of ['sourceSha256', 'findingId']) if (!HASH.test(source[key] || '')) throw failure(`source.${key} must be a SHA-256`);
  for (const key of ['evidenceHash', 'reviewSha256']) if (source[key] && !HASH.test(source[key])) throw failure(`source.${key} must be a SHA-256`);
  if (system === 'gmail' && (!ID.test(source.messageId || '') || !ID.test(source.threadId || ''))) throw failure('Exact Gmail message and thread IDs are required');
  if (source.personalNoteId && !/^[a-f0-9]{24}$/.test(source.personalNoteId)) throw failure('source.personalNoteId is invalid');
  const kind = enumValue(input.kind, KINDS);
  const precision = enumValue(input.eventDatePrecision, ['unknown', 'day', 'instant'], 'unknown');
  const normalized = {
    scope: 'owner', sensitivity: input.sensitivity === 'highly_private' ? 'highly_private' : 'private',
    kind, text: text(input.text, 4000, true), actor: text(input.actor, 300),
    sourceDate: date(input.sourceDate), eventDateAsWritten: text(input.eventDateAsWritten, 200),
    eventDate: eventDate(input.eventDate || '', precision), eventDatePrecision: precision,
    // An importer records assertions, never independently confirms them.
    assertionState: 'unknown', sourceStatus: text(input.sourceStatus, 1000),
    source: { system, sourceSha256: source.sourceSha256, findingId: source.findingId,
      threadId: text(source.threadId, 256), messageId: text(source.messageId, 256),
      evidenceHash: source.evidenceHash || '', reviewSha256: source.reviewSha256 || '',
      personalNoteId: source.personalNoteId || '', direction: enumValue(source.direction, ['received', 'sent', 'draft', 'unknown'], 'unknown') }
  };
  normalized.key = digest([system, normalized.source.threadId, normalized.source.messageId,
    source.sourceSha256, kind, source.findingId].join('\n'));
  return normalized;
}

function project(row) {
  const forgotten = row.reviewState === 'forgotten';
  return { id: String(row._id), kind: row.kind, text: forgotten ? '' : row.text, actor: forgotten ? '' : row.actor,
    sourceDate: row.sourceDate, eventDate: forgotten ? '' : row.eventDate,
    eventDateAsWritten: forgotten ? '' : row.eventDateAsWritten, eventDatePrecision: row.eventDatePrecision,
    assertionState: row.assertionState, sourceStatus: forgotten ? '' : row.sourceStatus,
    reviewState: row.reviewState, revision: row.revision, sensitivity: row.sensitivity,
    source: forgotten ? null : row.source,
    gmailUrl: !forgotten && row.source?.system === 'gmail'
      ? `https://mail.google.com/mail/#all/${encodeURIComponent(row.source.threadId)}` : null,
    archiveUrl: !forgotten && row.source?.system === 'gmail'
      ? `/api/secretary/archive/${encodeURIComponent(row.source.messageId)}?sha256=${row.source.sourceSha256}` : null,
    decision: forgotten ? null : row.decision, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

async function record(input) {
  const value = normalize(input);
  let existing = await Entry.findOne({ key: value.key, scope: 'owner' }).lean();
  if (existing) {
    if (existing.reviewState !== 'forgotten' && await privacy.forgottenSource({
      noteId: existing.source.personalNoteId, contentHash: existing.contentHash
    })) {
      await privacy.suppress({ key: value.key });
      existing = await Entry.findOne({ key: value.key, scope: 'owner' }).lean();
    }
    return { created: false, sourceKey: value.key, entry: project(existing) };
  }
  value.text = (await sealText(value.text, { seenIn: 'personal-history' })).text;
  value.actor = (await sealText(value.actor, { seenIn: 'personal-history' })).text;
  value.sourceStatus = (await sealText(value.sourceStatus, { seenIn: 'personal-history' })).text;
  value.eventDateAsWritten = (await sealText(value.eventDateAsWritten, { seenIn: 'personal-history' })).text;
  value.contentHash = digest(value.text.toLowerCase());
  const forgottenQuery = { noteId: value.source.personalNoteId, contentHash: value.contentHash };
  let suppressed = await privacy.forgottenSource(forgottenQuery);
  const insert = { ...value, reviewState: suppressed ? 'forgotten' : 'candidate', revision: 0,
    ...(suppressed ? { text: '', actor: '', sourceStatus: '', eventDateAsWritten: '',
      forgottenAt: new Date(), decision: { reason: '', at: new Date() } } : {}) };
  let row, created = false;
  try {
    const result = await Entry.findOneAndUpdate({ key: value.key, scope: 'owner' }, { $setOnInsert: insert },
      { new: true, upsert: true, runValidators: true, includeResultMetadata: true });
    row = result.value.toObject();
    created = Boolean(result.lastErrorObject?.upserted);
  } catch (error) {
    if (error.code !== 11000) throw error;
    row = await Entry.findOne({ key: value.key, scope: 'owner' }).lean();
    if (!row) throw error;
  }
  // Close the race where forgetting runs after the first check but before the
  // insert: the forget owner also suppresses entries already inserted.
  if (!suppressed && await privacy.forgottenSource(forgottenQuery)) {
    await privacy.suppress({ key: value.key });
    row = await Entry.findOne({ key: value.key, scope: 'owner' }).lean();
    suppressed = true;
  }
  return { created, suppressed, sourceKey: value.key, entry: project(row) };
}

async function list(input = {}) {
  const filter = { scope: 'owner' };
  if (input.state === 'pending') filter.$and = [{ $or: [
    { reviewState: 'candidate' }, { reviewState: 'retained', kind: { $in: ['action', 'deliverable'] } }
  ] }];
  else filter.reviewState = input.state ? enumValue(input.state, STATES) : { $ne: 'forgotten' };
  if (input.kind) filter.kind = enumValue(input.kind, KINDS);
  if (input.source) filter['source.system'] = enumValue(input.source, ['gmail', 'outlook-export']);
  if (input.before || input.since) filter.sourceDate = {
    ...(input.before ? { $lt: date(input.before) } : {}), ...(input.since ? { $gte: date(input.since) } : {})
  };
  if (input.query) {
    const escaped = text(input.query, 300, true).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [{ text: { $regex: escaped, $options: 'i' } }, { actor: { $regex: escaped, $options: 'i' } }];
  }
  const limit = Math.max(1, Math.min(100, Math.trunc(Number(input.limit)) || 30));
  const offset = Math.max(0, Math.trunc(Number(input.offset)) || 0);
  const [rows, total] = await Promise.all([
    Entry.find(filter).sort({ sourceDate: 1, _id: 1 }).skip(offset).limit(limit).lean(), Entry.countDocuments(filter)
  ]);
  return { authority: 'agentx.core', entries: rows.map(project), total, nextOffset: offset + rows.length < total ? offset + rows.length : null,
    ordering: 'source-date-oldest-first', eventDateCoverage: 'event-dates-are-independent-of-source-dates' };
}

async function review(id, input = {}) {
  if (!/^[a-f0-9]{24}$/.test(id)) throw failure('Choose an existing history entry');
  const state = enumValue(input.state, STATES.filter(s => s !== 'candidate'));
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw failure('The current entry revision is required');
  const reason = (await sealText(text(input.reason, 2000, state !== 'forgotten'), { seenIn: 'personal-history' })).text;
  const entry = await Entry.findOne({ _id: id, scope: 'owner' }).lean();
  if (!entry || entry.reviewState === 'forgotten') throw failure('History entry is unavailable', 404);
  if ((entry.reviewHistory || []).length >= 1000) throw failure('History decision capacity reached; retain the existing audit before continuing', 409);
  if (state === 'resolved' && !['action', 'deliverable'].includes(entry.kind)) throw failure('Only an action or deliverable can be resolved');
  const assertion = input.assertionState === undefined ? entry.assertionState : enumValue(input.assertionState, ASSERTIONS);
  const precision = input.eventDatePrecision === undefined ? entry.eventDatePrecision
    : enumValue(input.eventDatePrecision, ['unknown', 'day', 'instant']);
  const when = eventDate(input.eventDate === undefined ? entry.eventDate : input.eventDate, precision);
  const changes = { reviewState: state, assertionState: assertion, eventDate: when,
    eventDatePrecision: precision, decision: { reason, at: new Date() } };
  if (state === 'forgotten') Object.assign(changes, { text: '', actor: '', sourceStatus: '', eventDate: '',
    eventDateAsWritten: '', eventDatePrecision: 'unknown', reviewHistory: [], forgottenAt: new Date(), decision: { reason: '', at: new Date() } });
  const decision = { revision: input.revision + 1, state, assertionState: assertion, eventDate: when,
    eventDatePrecision: precision, reason, at: changes.decision.at };
  const row = await Entry.findOneAndUpdate({ _id: id, scope: 'owner', revision: input.revision, reviewState: { $ne: 'forgotten' } },
    { $set: changes, $inc: { revision: 1 }, ...(state === 'forgotten' ? {} : { $push: { reviewHistory: decision } }) },
    { new: true, runValidators: true }).lean();
  if (!row) throw failure('History changed; reload before reviewing it', 409);
  return { authority: 'agentx.core', entry: project(row) };
}

module.exports = { normalize, record, list, review, project };
