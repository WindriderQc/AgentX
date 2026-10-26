'use strict';

const { createHash } = require('node:crypto');
const MemoryNote = require('../../models/MemoryNote');
const { sealText } = require('./identifierVault');
const { createIndex } = require('./memoryNoteIndex');
const { currentFactFilter } = require('./memoryNoteValidity');
const { scoreFloor } = require('../helpers/scoreFloor');
const { memoryFactInput, memoryFactProjection, mergeMemoryFactMetadata } = require('../../../shared/memoryFactMetadata');
const temporal = require('./personalHistoryTemporal');
const historyContext = require('./personalHistorySouvenirContext');

// A note is recalled by meaning when its similarity to the request reaches
// this floor. Measured with qllama/bge-m3:f16 on 24 owner questions
// (2026-10-12): the right note scored 0.47 to 0.67, the closest note to an
// off-topic request 0.47 at most. Another embedding model needs its own
// value; 1 switches recall by meaning off.
const DEFAULT_MEANING_FLOOR = 0.5;
const meaningFloor = () => scoreFloor(process.env.MEMORY_NOTE_MEANING_MIN_SCORE, DEFAULT_MEANING_FLOOR);
// A conversation waits for this answer: a slow embedding host costs the
// recall by meaning, never the turn.
const MEANING_TIMEOUT_MS = 1500;

const error = (message, statusCode = 400) => Object.assign(new Error(message), {
  statusCode, code: 'MEMORY_NOTE_INVALID'
});
const digest = value => createHash('sha256').update(value).digest('hex');
const noteId = value => {
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/.test(value)) throw error('Choose an existing note');
  return value;
};
const cleanText = (value, max = 4000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw error(`A note must contain 1-${max} characters`);
  }
  return value.trim();
};
// Provenance of a new note; a trusted caller may name its channel.
const sourceOf = value => (typeof value === 'string' && /^[a-z0-9-]{1,40}$/.test(value) ? value : 'explicit-ui');
// Where an agent-written note came from (ADR 0003, #207/#208). Only these
// values are accepted from the Nestor consumer; anything else is not a note
// the owner dictated, but it is never relabelled as one either.
const AGENT_PROVENANCE = Object.freeze({ conversation: 'nestor-conversation', 'mail-review': 'nestor-mail-review', scheduled: 'nestor-scheduled' });
const SOUVENIR_REF_SYSTEMS = ['personal-history', 'gmail', 'outlook-export', 'document', 'media', 'ledger', 'testimony', 'conversation', 'calendar'];
function souvenirRefs(value) {
  if (!Array.isArray(value) || !value.length || value.length > 125) throw error('A souvenir needs 1-125 sources');
  return value.map(ref => {
    if (!SOUVENIR_REF_SYSTEMS.includes(ref?.system) || typeof ref.id !== 'string'
        || !/^[a-zA-Z0-9_-]{8,128}$/.test(ref.id)) throw error('A souvenir source is invalid');
    return { system: ref.system, id: ref.id };
  });
}
function souvenirDate(value = '', precision = 'unknown') {
  return { eventDate: temporal.eventDate(value, precision, error), eventDatePrecision: precision };
}
const labels = (value = []) => {
  if (!Array.isArray(value) || value.length > 20) throw error('List at most 20 people or places');
  return [...new Set(value.map(item => cleanText(item, 120)))];
};
const limitOf = (value, fallback = 25) => Math.max(1, Math.min(100, Math.trunc(Number(value)) || fallback));
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stopWords = new Set(['les', 'des', 'une', 'que', 'qui', 'pour', 'dans', 'avec', 'mon', 'mes', 'moi', 'est', 'this', 'that', 'the', 'and', 'you', 'what', 'remember', 'retiens',
  'quel', 'quelle', 'quels', 'quelles', 'quoi', 'cette', 'cela', 'quil', 'cest', 'bonne',
  'question', 'questions', 'suggestion', 'suggestions', 'idee', 'idees', 'idea', 'ideas',
  'sur', 'about', 'raconte', 'histoire', 'tell', 'story',
  'pas', 'non', 'pourquoi', 'comment', 'avoir', 'avais', 'avait', 'aura', 'aurais',
  'dire', 'dis', 'dit', 'peux', 'peut', 'veux', 'veut', 'sais', 'sait', 'fais', 'fait', 'faire',
  'son', 'sa', 'ses', 'leur', 'leurs', 'notre', 'nos', 'votre', 'vos', 'eux', 'elle', 'elles',
  'ils', 'lui', 'nous', 'vous', 'quand', 'puis', 'encore', 'aussi', 'juste', 'bien',
  'deja', 'tout', 'tous', 'toute', 'toutes', 'mais', 'pendant', 'etre', 'etais', 'etait',
  'etaient', 'ete', 'toi', 'vraiment', 'tres', 'plus', 'moins',
  'prochain', 'prochaine', 'prochains', 'prochaines', 'hier', 'demain', 'aujourdhui',
  'maintenant', 'actuel', 'actuelle', 'actuels', 'actuelles',
  'bonjour', 'salut', 'hello', 'merci', 'thanks', 'please']);
const words = value => [...new Set(String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z0-9]{3,}/g) || [])].filter(word => !stopWords.has(word));
// Broad child queries can match individual son/daughter facts. Specific relation queries stay exact.
const childQueryTerms = new Set(['enfant', 'enfants', 'child', 'children']);
const childNoteTerms = ['fils', 'fille', 'filles', 'garcon', 'garcons', 'daughter', 'daughters'];

function project(row) {
  return { id: String(row._id), text: row.text, kind: row.kind || 'fact', type: row.type,
    topic: row.topic, packId: row.packId, scopeId: row.scopeId, scope: row.scope,
    sensitivity: row.sensitivity, source: row.source, createdAt: row.createdAt,
    updatedAt: row.updatedAt, expiresAt: row.expiresAt || null,
    invalidatedAt: row.invalidatedAt || null, supersededBy: row.supersededBy || null,
    ...(row.replaces && { replaces: row.replaces }),
    ...memoryFactProjection(row),
    ...(row.kind === 'souvenir' ? { eventDate: row.eventDate || '', eventDatePrecision: row.eventDatePrecision || 'unknown',
      people: row.people || [], places: row.places || [], revision: row.revision || 0, sourceRefs: row.sourceRefs || [], historyContext: row.historyContext || null } : {}) };
}

// Bind once in trusted server code. Request bodies and personas cannot widen
// either the information audience or the family space.
function forSpace({ audience, scopeId, packIds, index = createIndex() } = {}) {
  if (!['owner', 'household'].includes(audience) || typeof scopeId !== 'string'
      || !/^[a-zA-Z0-9_.:-]{1,120}$/.test(scopeId) || !Array.isArray(packIds)
      || !packIds.length || packIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id))) {
    throw error('A server-selected memory space is required');
  }
  const packs = [...packIds];
  const classification = audience === 'owner'
    ? { scope: 'owner', sensitivity: 'private' } : { scope: 'household', sensitivity: 'normal' };
  const boundary = { scopeId, packId: { $in: packs }, ...(audience === 'household' ? classification : {}) };
  const active = (includeHistory = false) => {
    if (typeof includeHistory !== 'boolean') throw error('includeHistory must be a boolean');
    if (includeHistory && audience !== 'owner') throw error('Memory history belongs to the owner', 403);
    const now = new Date();
    return { ...boundary, status: { $nin: ['forgotten', 'pending'] }, $and: [
      { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
      ...(!includeHistory ? [currentFactFilter(now)] : [])
    ] };
  };
  // The note is saved first and stays valid without its vector: an embedding
  // host that is busy or down delays the index, never the memory.
  const indexLater = row => { index.indexNote(row._id, row.text).catch(() => {}); };

  async function list({ limit, offset = 0, query, kind, id, includeHistory = false } = {}) {
    const filter = active(includeHistory);
    if (id !== undefined) filter._id = noteId(id);
    if (kind !== undefined) {
      if (!['fact', 'preference', 'decision', 'souvenir'].includes(kind)) throw error('Choose fact, preference, decision or souvenir');
      filter.kind = kind;
    }
    if (query !== undefined && query !== '') filter.text = { $regex: escapeRegex(cleanText(query, 2000)), $options: 'i' };
    const maximum = limitOf(limit, 100);
    const skip = Math.max(0, Math.trunc(Number(offset)) || 0);
    const [rows, total] = await Promise.all([
      MemoryNote.find(filter).sort({ updatedAt: -1, _id: -1 }).skip(skip).limit(maximum).lean(),
      MemoryNote.countDocuments(filter)
    ]);
    return { ok: true, authority: 'agentx.core', notes: rows.map(project), total,
      truncated: skip + rows.length < total, nextOffset: skip + rows.length < total ? skip + rows.length : null };
  }

  // Owner notes only: a family space has no way to reveal a sealed value.
  const seal = value => (audience === 'owner' ? sealText(value, { seenIn: 'memory-note' }) : { text: value, sealed: [] });

  async function remember(input = {}) {
    const raw = cleanText(input.text);
    memoryFactInput(input);
    if (input.kind !== undefined && !['fact', 'preference', 'decision'].includes(input.kind)) throw error('Choose fact, preference or decision');
    if (input.id !== undefined) noteId(input.id);
    const { text, sealed } = await seal(raw);
    const id = input.id === undefined ? digest([scopeId, packs[0], text].join('\n')).slice(0, 24) : noteId(input.id);
    const existing = await MemoryNote.findOne({ ...boundary, _id: id }).lean();
    if (existing?.invalidatedAt || existing?.supersededBy) throw error('A replaced fact cannot be rewritten through the general note editor', 409);
    if (existing?.status === 'pending' || ['preparing', 'linked', 'undoing'].includes(existing?.replacement?.phase)) throw error('This fact has an unfinished replacement', 409);
    // A kept souvenir retains its original sources, including through the
    // general note editor. Only ordinary facts accumulate review references.
    const fact = mergeMemoryFactMetadata(existing?.kind === 'souvenir' ? { validFrom: input.validFrom } : input, existing || {});
    if (input.id !== undefined && (!existing || existing.status === 'forgotten')) throw error('The selected note no longer exists', 404);
    // A souvenir is kept for good: a correction cannot give it an expiry.
    const expiresAt = existing?.kind === 'souvenir' ? null
      : Object.hasOwn(input, 'expiresAt') ? input.expiresAt ? new Date(input.expiresAt) : null : existing?.expiresAt || null;
    if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date())) throw error('Expiry must be a future ISO date');
    const kind = input.kind || existing?.kind || 'fact';
    const changed = !existing || existing.status === 'forgotten' || existing.text !== text || existing.kind !== kind
      || String(existing.expiresAt || '') !== String(expiresAt || '')
      || String(existing.validFrom ? new Date(existing.validFrom).toISOString() : '') !== String(fact.validFrom || '')
      || JSON.stringify(memoryFactProjection(existing).sourceRefs) !== JSON.stringify(fact.sourceRefs);
    if (!changed) return { ok: true, authority: 'agentx.core', ...project(existing), sealed, created: false, changed: false };
    // An explicit correction keeps an existing classification. In particular it
    // cannot downgrade a highly-private note by using a different presentation.
    // A trusted server caller may ask for the stricter owner label on a new
    // note; nothing can ask for a weaker one.
    const stricter = audience === 'owner' && input.sensitivity === 'highly_private'
      ? { ...classification, sensitivity: 'highly_private' } : classification;
    const labels = existing?.scope && existing?.sensitivity
      ? { scope: existing.scope, sensitivity: existing.sensitivity } : stricter;
    const filter = { ...boundary, _id: id, invalidatedAt: null, supersededBy: null,
      'replacement.phase': { $nin: ['preparing', 'linked', 'undoing'] },
      ...(input.id === undefined ? {} : { status: { $ne: 'forgotten' } }) };
    const update = { $set: {
      text, kind, ...labels, ...fact, expiresAt, status: 'active', forgottenAt: null,
      contentHash: digest(text.toLowerCase())
    }, $setOnInsert: { packId: packs[0], scopeId, topic: 'general', type: 'fact', source: sourceOf(input.source) } };
    let result;
    try {
      result = await MemoryNote.findOneAndUpdate(filter, update,
        { new: true, upsert: input.id === undefined, runValidators: true, includeResultMetadata: true });
    } catch (failure) {
      if (failure.code !== 11000 || input.id !== undefined) throw failure;
      // Concurrent identical first writes share the deterministic identity.
      // Retry only that exact DB update, never an external/native action.
      result = await MemoryNote.findOneAndUpdate(filter, update,
        { new: true, upsert: false, runValidators: true, includeResultMetadata: true });
    }
    const row = result.value;
    if (!row) throw error('The selected note no longer exists', 404);
    indexLater(row);
    return { ok: true, authority: 'agentx.core', ...project(row), sealed, created: Boolean(result.lastErrorObject?.upserted), changed: true };
  }

  async function record(input = {}) {
    const fact = memoryFactInput(input);
    const { text } = await seal(cleanText(input.text));
    const values = { packId: packs[0], scopeId, ...classification, text,
      topic: typeof input.topic === 'string' ? input.topic.slice(0, 80) : 'general',
      type: input.type === 'summary' ? 'summary' : 'fact', source: input.source || 'explicit-ui',
      contentHash: digest(text.toLowerCase()), status: 'active', ...fact };
    if (!input.sourceTraceId) { const created = await MemoryNote.create(values); indexLater(created); return project(created); }
    const sourceTraceId = cleanText(input.sourceTraceId, 300);
    const row = await MemoryNote.findOneAndUpdate({ ...boundary, sourceTraceId },
      { $setOnInsert: { ...values, sourceTraceId } }, { new: true, upsert: true, runValidators: true });
    if (!row.embeddedHash) indexLater(row);
    return project(row);
  }

  // A souvenir kept from reviewed sources. The first keep for a source creates
  // it; keeping the same source again returns the same note.
  async function keepSouvenir(input = {}, { pending = false } = {}) {
    if (audience !== 'owner') throw error('Souvenirs belong to the owner space', 403);
    const refs = souvenirRefs(input.sourceRefs);
    const { eventDate, eventDatePrecision } = souvenirDate(input.eventDate, input.eventDatePrecision);
    const sealAll = async values => Promise.all(labels(values).map(async value => (await seal(value)).text));
    const { text } = await seal(cleanText(input.text));
    const sourceTraceId = `souvenir:${refs[0].system}:${refs[0].id}`;
    const values = { packId: packs[0], scopeId, ...classification, text, topic: 'souvenir', type: 'fact',
      kind: 'souvenir', eventDate, eventDatePrecision, people: await sealAll(input.people),
      places: await sealAll(input.places), sourceRefs: refs, source: sourceOf(input.source),
      contentHash: digest(text.toLowerCase()), status: pending ? 'pending' : 'active', expiresAt: null, historyContext: historyContext.normalize(input.historyContext) };
    const result = await MemoryNote.findOneAndUpdate({ ...boundary, sourceTraceId },
      { $setOnInsert: { ...values, sourceTraceId } },
      { new: true, upsert: true, runValidators: true, includeResultMetadata: true });
    let row = result.value;
    if (row.status === 'forgotten') throw error('This souvenir was forgotten', 409);
    if (row.invalidatedAt || row.supersededBy) throw error('This souvenir was replaced', 409);
    if (pending && row.status === 'active' && JSON.stringify(row.historyContext?.toObject?.() || row.historyContext || null) !== JSON.stringify(values.historyContext)) {
      throw error('An active souvenir already keeps another source context; review that souvenir explicitly', 409);
    }
    if (pending && row.status === 'pending') {
      row = await MemoryNote.findOneAndUpdate({ ...boundary, _id: row._id, status: 'pending' }, { $set: values }, { new: true, runValidators: true });
      if (!row) throw error('This pending souvenir changed', 409);
    }
    if (!pending && row.status === 'active' && !row.embeddedHash) indexLater(row);
    return { ok: true, authority: 'agentx.core', ...project(row), created: Boolean(result.lastErrorObject?.upserted) };
  }

  // The history owner publishes a prepared note only after linking it with
  // both native and context revision fences. A lost reply resumes this step.
  async function finalizeSouvenir(id) {
    if (audience !== 'owner') throw error('Souvenirs belong to the owner space', 403);
    noteId(id);
    let row = await MemoryNote.findOneAndUpdate({ ...boundary, _id: id, kind: 'souvenir', status: 'pending' },
      { $set: { status: 'active' } }, { new: true });
    const activated = Boolean(row);
    if (!row) row = await MemoryNote.findOne({ ...boundary, _id: id, kind: 'souvenir', status: 'active' });
    if (!row) throw error('This souvenir is unavailable', 409);
    if (activated && !row.embeddedHash) indexLater(row);
    return project(row);
  }

  // The owner corrects a kept souvenir: its date, people, places or text. The
  // sources it was kept from never change. Values are sealed like a keep, and
  // the revision on screen must still be the current one.
  async function editSouvenir(id, input = {}) {
    if (audience !== 'owner') throw error('Souvenirs belong to the owner space', 403);
    noteId(id);
    if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw error('The current souvenir revision is required');
    const existing = await MemoryNote.findOne({ ...boundary, _id: id, kind: 'souvenir', status: 'active' }).lean();
    if (!existing || existing.status === 'forgotten') throw error('The selected souvenir no longer exists', 404);
    if (existing.invalidatedAt || existing.supersededBy) throw error('This souvenir was replaced', 409);
    const current = existing.revision || 0;
    if (input.revision !== current) throw error('Souvenir changed; reload before correcting it', 409);
    const sealAll = async values => Promise.all(labels(values).map(async value => (await seal(value)).text));
    const set = {};
    if (input.eventDate !== undefined || input.eventDatePrecision !== undefined) {
      const precision = input.eventDatePrecision ?? (input.eventDate ? 'day' : 'unknown');
      Object.assign(set, souvenirDate(input.eventDate || '', precision));
    }
    if (input.people !== undefined) set.people = await sealAll(input.people);
    if (input.places !== undefined) set.places = await sealAll(input.places);
    if (input.text !== undefined) {
      set.text = (await seal(cleanText(input.text))).text;
      set.contentHash = digest(set.text.toLowerCase());
    }
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const changes = Object.fromEntries(Object.entries(set).filter(([key, value]) =>
      ['people', 'places'].includes(key) ? !same(value, existing[key] || []) : !same(value, existing[key])));
    if (!Object.keys(changes).length) return { ok: true, authority: 'agentx.core', ...project(existing), changed: false };
    // A note without a revision yet matches revision 0 (null also matches a missing field).
    const fence = current === 0 ? { revision: { $in: [0, null] } } : { revision: current };
    const row = await MemoryNote.findOneAndUpdate({ ...boundary, _id: id, kind: 'souvenir', status: 'active',
      invalidatedAt: null, supersededBy: null, ...fence },
      { $set: { ...changes, revision: current + 1 } }, { new: true, runValidators: true }).lean();
    if (!row) throw error('Souvenir changed; reload before correcting it', 409);
    if (changes.text) indexLater(row);
    return { ok: true, authority: 'agentx.core', ...project(row), changed: true };
  }

  // Active souvenirs of this space by id, for views that show them beside their source.
  async function souvenirs(ids = []) {
    const wanted = [...new Set(ids)].filter(id => typeof id === 'string' && /^[a-f0-9]{24}$/.test(id)).slice(0, 500);
    if (!wanted.length) return [];
    const rows = await MemoryNote.find({ ...active(), _id: { $in: wanted }, kind: 'souvenir', status: 'active' }).lean();
    return rows.map(project);
  }

  async function forget(id) {
    noteId(id);
    const row = await MemoryNote.findOneAndUpdate({ ...boundary, _id: id, status: { $ne: 'forgotten' } },
      { $set: { status: 'forgotten', forgottenAt: new Date() } }, { new: true });
    if (audience === 'owner') {
      // Retry a failed derivative cleanup without reviving the selected note.
      const forgotten = row || await MemoryNote.findOne({ ...boundary, _id: id, status: 'forgotten' }).lean();
      if (forgotten) await require('./personalHistoryPrivacy').forgetSourceNote(forgotten);
    }
    return { ok: true, authority: 'agentx.core', id, removed: Boolean(row) };
  }

  async function search(query, { limit = 8, minMatchedTerms = 1 } = {}) {
    cleanText(query, 4000);
    const terms = words(query);
    const matchingTerms = new Set(terms);
    if (terms.some(term => childQueryTerms.has(term))) childNoteTerms.forEach(term => matchingTerms.add(term));
    const minimum = minMatchedTerms === 2 ? 2 : 1;
    // A greeting or vague request has no recall topic. It must not turn into
    // an implicit list of every note; explicit list/filter remains available.
    if (!terms.length) return { ok: true, authority: 'agentx.core', notes: [], total: await MemoryNote.countDocuments(active()) };
    // Read pages so old relevant notes cannot disappear behind the UI's first
    // hundred entries. Keep only the bounded best matches in memory.
    let best = [], offset = 0, page;
    do {
      page = await list({ offset, limit: 100 });
      best = [...best, ...page.notes.map(note => ({ note, score: words(note.text).filter(term => matchingTerms.has(term)).length }))]
        .filter(entry => entry.score >= minimum)
        .sort((a, b) => b.score - a.score || new Date(b.note.updatedAt) - new Date(a.note.updatedAt))
        .slice(0, limitOf(limit, 8));
      offset = page.nextOffset;
    } while (offset !== null);
    // Words find what is named; meaning finds what is asked another way
    // ("is the Canadien playing tonight" and a note about following the
    // Canadiens share no word). Notes close in meaning come first, the word
    // matches follow, and without an index or an embedding host the result is
    // the word matches alone, as before.
    const cap = limitOf(limit, 8);
    const floor = meaningFloor();
    let byMeaning = [];
    if (floor < 1) {
      try {
        const found = await index.nearest(active(), [query],
          { limit: cap, minScore: floor, embedOptions: { timeoutMs: MEANING_TIMEOUT_MS } });
        byMeaning = found.results[0].hits.map(hit => project(hit.note));
      } catch { byMeaning = []; }
    }
    const seen = new Set(byMeaning.map(note => note.id));
    const notes = [...byMeaning, ...best.map(entry => entry.note).filter(note => !seen.has(note.id))].slice(0, cap);
    return { ok: true, authority: 'agentx.core', notes, total: page.total };
  }

  // Notes of this space closest in meaning to each text. Same boundary as
  // every other read here; notes not indexed yet are counted, not guessed.
  async function similar(queries, { limit = 3, minScore = 0 } = {}) {
    const texts = (Array.isArray(queries) ? queries : [queries]).map(query => cleanText(query, 4000));
    const found = await index.nearest(active(), texts, { limit: limitOf(limit, 3), minScore });
    return { ok: true, authority: 'agentx.core', indexed: found.indexed, unindexed: found.unindexed,
      results: found.results.map(entry => ({ query: entry.query, ...(entry.error ? { error: entry.error } : {}),
        notes: entry.hits.map(hit => ({ ...project(hit.note), score: Math.round(hit.score * 1000) / 1000 })) })) };
  }
  const reindex = () => index.rebuild(boundary);

  const replacements = require('./memoryNoteReplacement').forNotes({ audience, boundary, seal, indexLater, forget });
  return Object.freeze({ list, remember, record, keepSouvenir, finalizeSouvenir, editSouvenir, souvenirs, forget, search, similar, reindex,
    ...replacements, count: () => MemoryNote.countDocuments(active()) });
}

const personal = () => forSpace({ audience: 'owner', scopeId: 'personal', packIds: ['personal_operator'] });
async function operatePersonal(input = {}) {
  const notes = personal();
  const operation = input.operation || input.action;
  if (input.includeHistory !== undefined && (typeof input.includeHistory !== 'boolean'
      || input.includeHistory && operation !== 'list')) throw error('History requires an explicit owner list');
  let result;
  if (operation === 'list') result = await notes.list(input);
  else if (operation === 'search') result = await notes.search(input.query, input);
  else if (operation === 'context') {
    const matched = await notes.search(input.query, input);
    const preferences = await notes.list({ kind: 'preference', limit: input.limit || 4 });
    result = { ...matched, notes: [...matched.notes, ...preferences.notes.filter(note => !matched.notes.some(hit => hit.id === note.id))]
      .slice(0, limitOf(input.limit, 4)) };
  }
  // Provenance is set by trusted server callers (MCP), never by a request body.
  else if (operation === 'remember') result = await notes.remember({ ...input,
    source: input.provenance === undefined ? undefined : AGENT_PROVENANCE[input.provenance] || 'nestor-conversation' });
  else if (operation === 'forget') result = await notes.forget(input.id);
  else throw error('Choose list, search, remember or forget');
  return { ...result, operation };
}

module.exports = { forSpace, personal, operatePersonal, AGENT_PROVENANCE };
