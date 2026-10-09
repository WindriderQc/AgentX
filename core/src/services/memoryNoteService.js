'use strict';

const { createHash } = require('node:crypto');
const MemoryNote = require('../../models/MemoryNote');
const { sealText } = require('./identifierVault');
const { createIndex } = require('./memoryNoteIndex');

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
    updatedAt: row.updatedAt, expiresAt: row.expiresAt || null };
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
  const active = () => ({ ...boundary, status: { $ne: 'forgotten' },
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] });
  // The note is saved first and stays valid without its vector: an embedding
  // host that is busy or down delays the index, never the memory.
  const indexLater = row => { index.indexNote(row._id, row.text).catch(() => {}); };

  async function list({ limit, offset = 0, query, kind } = {}) {
    const filter = active();
    if (kind !== undefined) {
      if (!['fact', 'preference', 'decision'].includes(kind)) throw error('Choose fact, preference or decision');
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
    if (input.kind !== undefined && !['fact', 'preference', 'decision'].includes(input.kind)) throw error('Choose fact, preference or decision');
    if (input.id !== undefined) noteId(input.id);
    const { text, sealed } = await seal(raw);
    const id = input.id === undefined ? digest([scopeId, packs[0], text].join('\n')).slice(0, 24) : noteId(input.id);
    const existing = await MemoryNote.findOne({ ...boundary, _id: id }).lean();
    if (input.id !== undefined && (!existing || existing.status === 'forgotten')) throw error('The selected note no longer exists', 404);
    const expiresAt = Object.hasOwn(input, 'expiresAt') ? input.expiresAt ? new Date(input.expiresAt) : null : existing?.expiresAt || null;
    if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date())) throw error('Expiry must be a future ISO date');
    const kind = input.kind || existing?.kind || 'fact';
    const changed = !existing || existing.status === 'forgotten' || existing.text !== text || existing.kind !== kind
      || String(existing.expiresAt || '') !== String(expiresAt || '');
    if (!changed) return { ok: true, authority: 'agentx.core', id, text, kind, sealed, created: false, changed: false, updatedAt: existing.updatedAt };
    // An explicit correction keeps an existing classification. In particular it
    // cannot downgrade a highly-private note by using a different presentation.
    const labels = existing?.scope && existing?.sensitivity
      ? { scope: existing.scope, sensitivity: existing.sensitivity } : classification;
    const filter = { ...boundary, _id: id, ...(input.id === undefined ? {} : { status: { $ne: 'forgotten' } }) };
    const update = { $set: {
      text, kind, ...labels, expiresAt, status: 'active', forgottenAt: null,
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
    const { text } = await seal(cleanText(input.text));
    const values = { packId: packs[0], scopeId, ...classification, text,
      topic: typeof input.topic === 'string' ? input.topic.slice(0, 80) : 'general',
      type: input.type === 'summary' ? 'summary' : 'fact', source: input.source || 'explicit-ui',
      contentHash: digest(text.toLowerCase()), status: 'active' };
    if (!input.sourceTraceId) { const created = await MemoryNote.create(values); indexLater(created); return project(created); }
    const sourceTraceId = cleanText(input.sourceTraceId, 300);
    const row = await MemoryNote.findOneAndUpdate({ ...boundary, sourceTraceId },
      { $setOnInsert: { ...values, sourceTraceId } }, { new: true, upsert: true, runValidators: true });
    if (!row.embeddedHash) indexLater(row);
    return project(row);
  }

  async function forget(id) {
    noteId(id);
    const row = await MemoryNote.findOneAndUpdate({ ...boundary, _id: id, status: { $ne: 'forgotten' } },
      { $set: { status: 'forgotten', forgottenAt: new Date() } }, { new: true });
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
    return { ok: true, authority: 'agentx.core', notes: best.map(entry => entry.note), total: page.total };
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

  return Object.freeze({ list, remember, record, forget, search, similar, reindex, count: () => MemoryNote.countDocuments(active()) });
}

const personal = () => forSpace({ audience: 'owner', scopeId: 'personal', packIds: ['personal_operator'] });
async function operatePersonal(input = {}) {
  const notes = personal();
  const operation = input.operation || input.action;
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
