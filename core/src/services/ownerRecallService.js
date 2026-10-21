'use strict';

const { createHash } = require('node:crypto');
const Recall = require('../../models/OwnerRecallDocument');
const { requestJson } = require('../helpers/crossServiceClient');

// The owner's private recall corpus: mail bodies and read attachments from the
// archive importer, plus souvenirs and people that Core indexes itself. Text
// and vectors live in RAG's owner collection behind Core's token; Core keeps
// provenance and what the owner forgot. Only owner callers reach this service:
// it is never offered to /mcp, the Family surface or children.
const DOCUMENT_ID = /^(mail|file|souvenir|person):[a-zA-Z0-9_-]{8,160}$/;
const HASH = /^[a-f0-9]{64}$/;
const BATCH = 50;
const digest = value => createHash('sha256').update(value).digest('hex');
const failure = (message, statusCode = 400, code = 'OWNER_RECALL_INVALID') => Object.assign(new Error(message), { statusCode, code });
const text = (value, maximum) => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0')) throw failure(`Text exceeds ${maximum} characters or is invalid`);
  return value.trim();
};

async function rag(method, path, body, { send = requestJson, env = process.env } = {}) {
  const token = env.OWNER_MAIL_RAG_TOKEN || '';
  if (token.length < 32) throw failure('Owner recall is not configured', 503, 'OWNER_RECALL_UNCONFIGURED');
  return send({ baseUrl: env.RAG_SERVICE_URL || 'http://localhost:3082', path: `/api/rag/owner-mail${path}`, method, body,
    headers: { 'x-agentx-owner-mail-token': token }, timeoutMs: 900000, serviceName: 'RAG', errorCode: 'OWNER_RECALL_RAG_FAILED' });
}

// A mail body or read attachment prepared by the archive importer.
function normalize(input = {}) {
  const documentId = text(input.documentId, 200);
  const kind = documentId.split(':')[0];
  if (!DOCUMENT_ID.test(documentId) || !['mail', 'file'].includes(kind) || input.kind !== kind) throw failure('Choose a mail or file recall id');
  const source = input.source || {};
  const value = { documentId, kind, text: text(input.text, 200000), title: text(input.title, 300),
    occurredAt: input.occurredAt ? new Date(input.occurredAt) : null,
    people: (Array.isArray(input.people) ? input.people : []).slice(0, 20).map(p => text(p, 200)).filter(Boolean),
    source: { messageId: text(source.messageId, 256), threadId: text(source.threadId, 256),
      sourceSha256: text(source.sourceSha256, 64), filename: text(source.filename, 300) } };
  if (!value.text) throw failure('A recall document needs text');
  if (value.occurredAt && !Number.isFinite(value.occurredAt.getTime())) throw failure('occurredAt is invalid');
  if (!HASH.test(value.source.sourceSha256) || !value.source.messageId) throw failure('A recall document needs its message and preserved source');
  value.contentHash = digest(JSON.stringify([value.text, value.title]));
  return value;
}

async function store(values, deps) {
  const known = new Map((await Recall.find({ documentId: { $in: values.map(v => v.documentId) } }).lean()).map(r => [r.documentId, r]));
  const fresh = values.filter(v => known.get(v.documentId)?.state !== 'forgotten'
    && known.get(v.documentId)?.contentHash !== v.contentHash);
  const result = { indexed: 0, unchanged: values.length - fresh.length, refusedForgotten: values.filter(v => known.get(v.documentId)?.state === 'forgotten').length };
  result.unchanged -= result.refusedForgotten;
  for (let start = 0; start < fresh.length; start += BATCH) {
    const batch = fresh.slice(start, start + BATCH);
    const reply = await rag('POST', '/documents', { documents: batch.map(v => ({ documentId: v.documentId,
      text: [v.title, v.people.length ? `Personnes : ${v.people.join(', ')}` : '', v.text].filter(Boolean).join('\n'), forceReindex: known.has(v.documentId) })) }, deps);
    const counts = new Map((reply?.results || []).map(r => [r.documentId, r.chunkCount]));
    for (const value of batch) {
      if (!counts.has(value.documentId)) throw failure('RAG returned an incomplete recall receipt', 502, 'OWNER_RECALL_RAG_FAILED');
      const { text: _omitted, ...record } = value;
      await Recall.updateOne({ documentId: value.documentId }, { $set: { ...record, scope: 'owner', state: 'indexed',
        chunkCount: counts.get(value.documentId) || 0, indexedAt: new Date() } }, { upsert: true });
    }
    result.indexed += batch.length;
  }
  return result;
}

async function index(inputs, deps) {
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > BATCH) throw failure(`Index 1-${BATCH} documents`);
  return { authority: 'agentx.core', ...(await store(inputs.map(normalize), deps)) };
}

// Souvenirs and people come from Core itself; what is no longer active leaves the index.
async function sync({ limit = 200 } = {}, deps) {
  const MemoryNote = require('../../models/MemoryNote');
  const Person = require('../../models/PersonContact');
  const [notes, people] = await Promise.all([
    MemoryNote.find({ scope: 'owner', kind: 'souvenir', status: 'active' }).lean(),
    Person.find({ scope: 'owner', state: 'active' }).lean()]);
  const wanted = [
    ...notes.map(note => ({ documentId: `souvenir:${note._id}`, kind: 'souvenir', noteId: String(note._id),
      title: note.eventDate ? `Souvenir du ${note.eventDate}` : 'Souvenir', occurredAt: note.eventDate ? new Date(note.eventDate) : null,
      people: (note.people || []).slice(0, 20), text: [note.text, note.places?.length ? `Lieux : ${note.places.join(', ')}` : ''].filter(Boolean).join('\n') })),
    ...people.filter(p => p.names.length || p.emails.length).map(person => ({ documentId: `person:${person._id}`, kind: 'person', personId: String(person._id),
      title: person.displayName, occurredAt: person.lastSeen, people: person.names.slice(0, 20),
      text: [`Personne : ${person.names.join(', ') || person.displayName}`, person.emails.length ? `Adresses : ${person.emails.join(', ')}` : '',
        person.organizations.length ? `Organisations : ${person.organizations.join(', ')}` : '',
        person.exchanges ? `${person.exchanges} échange(s) de ${person.firstSeen?.toISOString().slice(0, 10)} à ${person.lastSeen?.toISOString().slice(0, 10)}` : '']
        .filter(Boolean).join('\n') }))
  ].map(value => ({ ...value, source: {}, contentHash: digest(JSON.stringify([value.text, value.title, value.people])) }));
  const ids = new Set(wanted.map(v => v.documentId));
  const stale = await Recall.find({ scope: 'owner', kind: { $in: ['souvenir', 'person'] }, documentId: { $nin: [...ids] } }).lean();
  for (const row of stale) {
    await rag('DELETE', `/documents/${encodeURIComponent(row.documentId)}`, undefined, deps);
    await Recall.deleteOne({ documentId: row.documentId });
  }
  const known = new Map((await Recall.find({ documentId: { $in: [...ids] } }, { documentId: 1, contentHash: 1 }).lean()).map(r => [r.documentId, r.contentHash]));
  const changed = wanted.filter(v => known.get(v.documentId) !== v.contentHash);
  const bounded = Math.max(1, Math.min(2000, Math.trunc(Number(limit)) || 200));
  const result = await store(changed.slice(0, bounded), deps);
  return { authority: 'agentx.core', ...result, removed: stale.length, remaining: Math.max(0, changed.length - bounded) };
}

async function search(query, { limit = 8, minScore } = {}, deps) {
  const clean = text(query, 2000);
  if (!clean) throw failure('A query is required');
  const topK = Math.max(1, Math.min(20, Math.trunc(Number(limit)) || 8));
  const reply = await rag('POST', '/search', { query: clean, topK: Math.min(20, topK * 2),
    ...(Number.isFinite(Number(minScore)) ? { minScore: Number(minScore) } : {}) }, deps);
  const hits = (reply?.results || []).filter(hit => DOCUMENT_ID.test(hit.documentId || ''));
  const records = new Map((await Recall.find({ documentId: { $in: hits.map(h => h.documentId) }, state: 'indexed' }).lean()).map(r => [r.documentId, r]));
  // A souvenir or person forgotten since the last sync is never returned.
  const MemoryNote = require('../../models/MemoryNote');
  const Person = require('../../models/PersonContact');
  const live = new Set([
    ...(await MemoryNote.find({ _id: { $in: [...records.values()].filter(r => r.noteId).map(r => r.noteId) }, status: 'active' }, { _id: 1 }).lean()).map(n => `souvenir:${n._id}`),
    ...(await Person.find({ _id: { $in: [...records.values()].filter(r => r.personId).map(r => r.personId) }, state: 'active' }, { _id: 1 }).lean()).map(p => `person:${p._id}`)]);
  const results = [];
  for (const hit of hits) {
    const record = records.get(hit.documentId);
    if (!record || (['souvenir', 'person'].includes(record.kind) && !live.has(record.documentId))) continue;
    results.push({ documentId: record.documentId, kind: record.kind, score: hit.score, excerpt: String(hit.text || '').slice(0, 1200),
      title: record.title, occurredAt: record.occurredAt, people: record.people,
      source: record.source?.messageId ? { messageId: record.source.messageId, threadId: record.source.threadId,
        sourceSha256: record.source.sourceSha256, filename: record.source.filename,
        archiveUrl: `/api/secretary/archive/${encodeURIComponent(record.source.messageId)}?sha256=${record.source.sourceSha256}` } : null,
      ...(record.noteId ? { souvenirNoteId: record.noteId } : {}), ...(record.personId ? { personId: record.personId } : {}) });
    if (results.length >= topK) break;
  }
  return { authority: 'agentx.core', query: clean, results };
}

// The owner forgets one document: it leaves the index and is never indexed again.
async function forget(documentId, deps) {
  if (!DOCUMENT_ID.test(documentId || '')) throw failure('Choose a recall document');
  await rag('DELETE', `/documents/${encodeURIComponent(documentId)}`, undefined, deps);
  const kind = documentId.split(':')[0];
  await Recall.updateOne({ documentId }, { $set: { scope: 'owner', kind, state: 'forgotten', title: '', people: [], occurredAt: null,
    source: {}, chunkCount: 0 } }, { upsert: true });
  return { authority: 'agentx.core', documentId, forgotten: true };
}

async function status() {
  const rows = await Recall.aggregate([{ $match: { scope: 'owner' } }, { $group: { _id: { kind: '$kind', state: '$state' }, documents: { $sum: 1 }, chunks: { $sum: '$chunkCount' } } }]);
  return { authority: 'agentx.core', configured: (process.env.OWNER_MAIL_RAG_TOKEN || '').length >= 32,
    documents: rows.map(r => ({ kind: r._id.kind, state: r._id.state, documents: r.documents, chunks: r.chunks })) };
}

module.exports = { normalize, index, sync, search, forget, status };
