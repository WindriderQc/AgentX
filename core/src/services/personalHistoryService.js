'use strict';

const { createHash } = require('node:crypto');
const Entry = require('../../models/PersonalHistoryEntry');
const { sealText } = require('./identifierVault');
const privacy = require('./personalHistoryPrivacy');
const temporal = require('./personalHistoryTemporal');
const { SOURCE_SYSTEMS } = require('./personalHistoryContextContract');
const { projectContext } = require('./personalHistoryContextProjection');

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

const date = value => temporal.timestamp(value, failure);
const eventDate = (value, precision) => temporal.eventDate(value, precision, failure);

function sourceOf(source = {}) {
  const system = enumValue(source.system, SOURCE_SYSTEMS);
  for (const key of ['sourceSha256', 'findingId']) if (!HASH.test(source[key] || '')) throw failure(`source.${key} must be a SHA-256`);
  if (system === 'gmail' && (!ID.test(source.messageId || '') || !ID.test(source.threadId || ''))) throw failure('Exact Gmail message and thread IDs are required');
  if (!['gmail', 'outlook-export'].includes(system)) text(source.id, 256, true);
  return system;
}
// A consolidated assertion names its people and places and cites every other
// source it merges. A souvenir holds at most 20 sources: this entry, its source
// and 18 more.
const labels = (value = []) => {
  if (!Array.isArray(value) || value.length > 20) throw failure('List at most 20 people or places');
  return [...new Set(value.map(item => text(item, 120, true)))];
};
function relatedSources(value = []) {
  if (!Array.isArray(value) || value.length > 18) throw failure('Cite at most 18 related sources');
  return value.map(source => ({ system: sourceOf(source), id: text(source.id, 256), threadId: text(source.threadId, 256),
    messageId: text(source.messageId, 256), sourceSha256: source.sourceSha256, findingId: source.findingId }));
}

function normalize(input = {}) {
  const source = input.source || {};
  const system = sourceOf(source);
  for (const key of ['evidenceHash', 'reviewSha256']) if (source[key] && !HASH.test(source[key])) throw failure(`source.${key} must be a SHA-256`);
  if (source.personalNoteId && !/^[a-f0-9]{24}$/.test(source.personalNoteId)) throw failure('source.personalNoteId is invalid');
  const kind = enumValue(input.kind, KINDS);
  const precision = enumValue(input.eventDatePrecision, temporal.PRECISIONS, 'unknown');
  const normalized = {
    scope: 'owner', sensitivity: input.sensitivity === 'highly_private' ? 'highly_private' : 'private',
    kind, text: text(input.text, 4000, true), actor: text(input.actor, 300),
    sourceDate: input.sourceDate === null ? null : date(input.sourceDate), eventDateAsWritten: text(input.eventDateAsWritten, 200),
    eventDate: eventDate(input.eventDate || '', precision), eventDatePrecision: precision,
    // An importer records assertions, never independently confirms them.
    assertionState: 'unknown', sourceStatus: text(input.sourceStatus, 1000),
    people: labels(input.people), places: labels(input.places), relatedSources: relatedSources(input.relatedSources),
    source: { system, id: text(source.id, 256), sourceSha256: source.sourceSha256, findingId: source.findingId,
      threadId: text(source.threadId, 256), messageId: text(source.messageId, 256),
      evidenceHash: source.evidenceHash || '', reviewSha256: source.reviewSha256 || '',
      personalNoteId: source.personalNoteId || '', direction: enumValue(source.direction, ['received', 'sent', 'draft', 'unknown'], 'unknown') }
  };
  normalized.key = digest([system, normalized.source.threadId, normalized.source.messageId,
    source.sourceSha256, kind, source.findingId, ...(!['gmail', 'outlook-export'].includes(system) ? [normalized.source.id] : [])].join('\n'));
  return normalized;
}

function project(row, options) {
  const forgotten = row.reviewState === 'forgotten';
  const confirmationCurrent = !forgotten && row.assertionState === 'confirmed' && (!row.context ||
    (row.confirmation?.contextRevision === row.context.revision && row.confirmation?.contextHash === row.context.inputHash));
  return { id: String(row._id), kind: row.kind, text: forgotten ? '' : row.text, actor: forgotten ? '' : row.actor,
    sourceDate: row.sourceDate, eventDate: forgotten ? '' : row.eventDate,
    eventDateAsWritten: forgotten ? '' : row.eventDateAsWritten, eventDatePrecision: row.eventDatePrecision,
    assertionState: row.assertionState === 'confirmed' && !confirmationCurrent ? 'unknown' : row.assertionState,
    recordedAssertionState: row.assertionState, confirmationCurrent, confirmation: forgotten ? null : row.confirmation || null,
    sourceStatus: forgotten ? '' : row.sourceStatus,
    people: forgotten ? [] : row.people || [], places: forgotten ? [] : row.places || [],
    relatedSources: forgotten ? [] : row.relatedSources || [],
    reviewState: row.reviewState, revision: row.revision, sensitivity: row.sensitivity,
    source: forgotten ? null : row.source,
    gmailUrl: !forgotten && row.source?.system === 'gmail'
      ? `https://mail.google.com/mail/#all/${encodeURIComponent(row.source.threadId)}` : null,
    archiveUrl: !forgotten && row.source?.system === 'gmail'
      ? `/api/secretary/archive/${encodeURIComponent(row.source.messageId)}?sha256=${row.source.sourceSha256}` : null,
    decision: forgotten ? null : row.decision, souvenirNoteId: forgotten ? '' : row.souvenirNoteId || '', createdAt: row.createdAt, updatedAt: row.updatedAt,
    ...projectContext(row, options) };
}

async function record(input, { context, importKey } = {}) {
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
  for (const list of ['people', 'places']) {
    value[list] = await Promise.all(value[list].map(async item => (await sealText(item, { seenIn: 'personal-history' })).text));
  }
  value.contentHash = digest(value.text.toLowerCase());
  const forgottenQuery = { noteId: value.source.personalNoteId, contentHash: value.contentHash };
  let suppressed = await privacy.forgottenSource(forgottenQuery);
  const insert = { ...value, reviewState: suppressed ? 'forgotten' : 'candidate', revision: 0,
    ...(context ? { contextImportKey: importKey, ...(!suppressed ? { context: { ...context, revision: 1 } } : {}) } : {}),
    ...(suppressed ? { text: '', actor: '', sourceStatus: '', eventDateAsWritten: '', people: [], places: [], relatedSources: [],
      context: null, forgottenAt: new Date(), decision: { reason: '', at: new Date() } } : {}) };
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
  if (input.source) filter['source.system'] = enumValue(input.source, SOURCE_SYSTEMS);
  if (input.sourceKey) {
    if (!HASH.test(input.sourceKey)) throw failure('sourceKey must be SHA-256');
    filter.key = input.sourceKey;
  }
  if (input.importId) filter.contextImportKey = digest(text(input.importId, 256, true));
  if (input.souvenir) filter.souvenirNoteId = enumValue(input.souvenir, ['kept', 'not-kept']) === 'kept'
    ? { $nin: ['', null] } : { $in: ['', null] };
  if (input.before || input.since) filter.sourceDate = {
    ...(input.before ? { $lt: date(input.before) } : {}), ...(input.since ? { $gte: date(input.since) } : {})
  };
  if (input.query) {
    const escaped = text(input.query, 300, true).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = ['text', 'actor', 'people', 'places'].map(field => ({ [field]: { $regex: escaped, $options: 'i' } }));
  }
  const limit = Math.max(1, Math.min(100, Math.trunc(Number(input.limit)) || 30));
  const offset = Math.max(0, Math.trunc(Number(input.offset)) || 0);
  const [rows, total] = await Promise.all([
    Entry.find(filter).select('-context.sources.body').sort({ sourceDate: 1, _id: 1 }).skip(offset).limit(limit).lean(), Entry.countDocuments(filter)
  ]);
  // A kept entry shows its souvenir as it is now, with the owner's corrections.
  const kept = new Map((await notes().souvenirs(rows.map(row => row.souvenirNoteId).filter(Boolean))).map(note => [note.id, note]));
  const entries = rows.map(row => {
    const note = row.souvenirNoteId && row.reviewState !== 'forgotten' ? kept.get(String(row.souvenirNoteId)) : null;
    return { ...project(row), ...(note ? { souvenir: { id: note.id, revision: note.revision, text: note.text, eventDate: note.eventDate,
      eventDatePrecision: note.eventDatePrecision, people: note.people, places: note.places, historyContext: note.historyContext || null } } : {}) };
  });
  return { authority: 'agentx.core', entries, total, nextOffset: offset + rows.length < total ? offset + rows.length : null,
    ordering: 'source-date-oldest-first', eventDateCoverage: 'event-dates-are-independent-of-source-dates' };
}

// Every entry the owner has not forgotten, in one read, for a timeline view
// (Life Atlas). Same projection as the list, without source bodies.
const TIMELINE_MAXIMUM = 20000;
async function timeline() {
  const rows = await Entry.find({ scope: 'owner', reviewState: { $ne: 'forgotten' } })
    .select('-context.sources.body -reviewHistory').sort({ sourceDate: 1, _id: 1 }).limit(TIMELINE_MAXIMUM + 1).lean();
  const truncated = rows.length > TIMELINE_MAXIMUM;
  const page = rows.slice(0, TIMELINE_MAXIMUM);
  const kept = new Map((await notes().souvenirs(page.map(row => row.souvenirNoteId).filter(Boolean))).map(note => [note.id, note]));
  const entries = page.map(row => {
    const note = row.souvenirNoteId ? kept.get(String(row.souvenirNoteId)) : null;
    return { ...project(row), ...(note ? { souvenir: { id: note.id, revision: note.revision, text: note.text, eventDate: note.eventDate,
      eventDatePrecision: note.eventDatePrecision, people: note.people, places: note.places, historyContext: note.historyContext || null } } : {}) };
  });
  return { authority: 'agentx.core', entries, total: entries.length, truncated, readAt: new Date().toISOString() };
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
  const confirmsContext = state !== 'forgotten' && input.assertionState === 'confirmed' && Boolean(entry.context);
  if (confirmsContext && (!Number.isSafeInteger(input.contextRevision) || input.contextRevision < 1)) throw failure('The displayed contextRevision is required to confirm this assertion');
  if (confirmsContext && input.contextRevision !== entry.context.revision) throw failure('History context changed; reload before confirming it', 409);
  const precision = input.eventDatePrecision === undefined ? entry.eventDatePrecision
    : enumValue(input.eventDatePrecision, temporal.PRECISIONS);
  const when = eventDate(input.eventDate === undefined ? entry.eventDate : input.eventDate, precision);
  const changes = { reviewState: state, assertionState: assertion, eventDate: when,
    eventDatePrecision: precision, decision: { reason, at: new Date() } };
  if (input.assertionState === 'confirmed') changes.confirmation = { revision: input.revision + 1,
    contextRevision: entry.context?.revision || null, contextHash: entry.context?.inputHash || '', reason, at: changes.decision.at };
  else if (input.assertionState !== undefined) changes.confirmation = null;
  if (state === 'forgotten') Object.assign(changes, { text: '', actor: '', sourceStatus: '', eventDate: '', people: [], places: [], relatedSources: [],
    context: null, confirmation: null, eventDateAsWritten: '', eventDatePrecision: 'unknown', reviewHistory: [], forgottenAt: new Date(), decision: { reason: '', at: new Date() } });
  const decision = { revision: input.revision + 1, state, assertionState: assertion, eventDate: when,
    eventDatePrecision: precision, reason, at: changes.decision.at,
    ...(confirmsContext ? { contextRevision: entry.context.revision, contextHash: entry.context.inputHash } : {}) };
  const row = await Entry.findOneAndUpdate({ _id: id, scope: 'owner', revision: input.revision, reviewState: { $ne: 'forgotten' },
    ...(confirmsContext ? { 'context.revision': input.contextRevision } : {}) },
    { $set: changes, $inc: { revision: 1 }, ...(state === 'forgotten' ? {} : { $push: { reviewHistory: decision } }) },
    { new: true, runValidators: true }).lean();
  if (!row) throw failure('History changed; reload before reviewing it', 409);
  // Forgetting the source also forgets the souvenir kept from it.
  if (state === 'forgotten' && entry.souvenirNoteId) await notes().forget(entry.souvenirNoteId);
  return { authority: 'agentx.core', entry: project(row) };
}

const notes = () => require('./memoryNoteService').personal();
const souvenirText = (entry, input) => {
  if (input.text !== undefined) return text(input.text, 4000, true);
  return entry.eventDate && !entry.text.includes(entry.eventDate.slice(0, 10))
    ? `${entry.eventDate.slice(0, 10)} : ${entry.text}` : entry.text;
};

// The owner keeps an assertion as a souvenir: a lasting owner memory with its
// date, people, places and sources. Keeping it again returns the same note.
async function keepAsSouvenir(id, input = {}) {
  if (!/^[a-f0-9]{24}$/.test(id)) throw failure('Choose an existing history entry');
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw failure('The current entry revision is required');
  const entry = await Entry.findOne({ _id: id, scope: 'owner' }).lean();
  if (!entry || entry.reviewState === 'forgotten') throw failure('History entry is unavailable', 404);
  if (entry.kind === 'action') throw failure('An action is resolved, not kept as a souvenir');
  if (entry.souvenirNoteId) {
    const souvenir = await notes().finalizeSouvenir(entry.souvenirNoteId);
    return { authority: 'agentx.core', created: false, entry: project(entry), souvenirNoteId: entry.souvenirNoteId, souvenir };
  }
  if (entry.revision !== input.revision) throw failure('History changed; reload before reviewing it', 409);
  if (entry.context && (!Number.isSafeInteger(input.contextRevision) || input.contextRevision < 1)) throw failure('The displayed contextRevision is required to keep this assertion');
  if (entry.context && input.contextRevision !== entry.context.revision) throw failure('History context changed; reload before keeping it', 409);
  const current = entry.context ? { ...entry.context.timeline, ...(entry.context.overrides || {}) } : null;
  let defaultDate = current?.date || entry.eventDate;
  const defaultPrecision = current ? current.precision : entry.eventDatePrecision;
  if (current && !current.date) defaultDate = '';
  // Display anchors at year/month precision are not exact days in a souvenir.
  if (defaultPrecision === 'year') defaultDate = defaultDate?.slice(0, 4);
  if (defaultPrecision === 'month') defaultDate = defaultDate?.slice(0, 7);
  const precision = input.eventDatePrecision === undefined ? defaultPrecision : enumValue(input.eventDatePrecision, temporal.PRECISIONS);
  const when = eventDate(input.eventDate === undefined ? defaultDate : input.eventDate, precision);
  const cited = [entry.source, ...(entry.relatedSources || [])];
  const contextSources = (entry.context?.sources || []).map(source => {
    if (digest(source.body) !== source.bodySha256) throw failure('Stored source integrity check failed', 409);
    return { system: ['media', 'ledger', 'testimony', 'conversation', 'calendar'].includes(source.kind) ? source.kind : 'document', sourceSha256: source.bodySha256 };
  });
  const sources = [{ system: 'personal-history', id: String(entry._id) },
    ...[...new Map([...cited, ...contextSources].map(source => [`${source.system}:${source.sourceSha256}`,
      { system: source.system, id: source.sourceSha256 }])).values()]];
  const people = entry.people?.length ? entry.people : entry.actor ? [entry.actor] : [];
  const content = current ? [...new Set([current.title, current.description].filter(Boolean))].join('\n\n') : entry.text;
  const note = await notes().keepSouvenir({ text: souvenirText({ text: content, eventDate: when }, input),
    eventDate: when, eventDatePrecision: precision, people: input.people ?? people,
    places: input.places ?? (current?.place ? [current.place] : entry.places), sourceRefs: sources, source: 'secretary-history',
    historyContext: require('./personalHistorySouvenirContext').snapshot(entry, current) }, { pending: true });
  const at = new Date();
  const reason = 'Kept as a souvenir';
  const state = entry.reviewState === 'resolved' ? 'resolved' : 'retained';
  const row = await Entry.findOneAndUpdate({ _id: id, scope: 'owner', revision: input.revision, reviewState: { $ne: 'forgotten' },
    ...(entry.context ? { 'context.revision': input.contextRevision } : {}) },
    { $set: { reviewState: state, souvenirNoteId: note.id, eventDate: when, eventDatePrecision: precision, decision: { reason, at } },
      $inc: { revision: 1 }, $push: { reviewHistory: { revision: input.revision + 1, state,
        assertionState: entry.assertionState, eventDate: when, eventDatePrecision: precision, reason, at } } },
    { new: true, runValidators: true }).lean();
  // An interrupted link leaves a hidden pending note. A fresh owner request
  // can prepare it again, or resume activation after a lost link response.
  if (!row) {
    const latest = await Entry.findById(id).lean();
    if (latest?.reviewState === 'forgotten') await notes().forget(note.id);
    throw failure('History changed; reload before keeping it', 409);
  }
  const souvenir = await notes().finalizeSouvenir(note.id);
  return { authority: 'agentx.core', created: note.created, entry: project(row), souvenirNoteId: note.id, souvenir };
}

module.exports = { normalize, record, list, timeline, review, keepAsSouvenir, project };
