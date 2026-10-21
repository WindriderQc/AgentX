'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Recall = require('../../models/OwnerRecallDocument');
const MemoryNote = require('../../models/MemoryNote');
const Person = require('../../models/PersonContact');
const Observation = require('../../models/PersonObservation');
const Proposal = require('../../models/PersonMergeProposal');
const recall = require('../../src/services/ownerRecallService');
const people = require('../../src/services/peopleRegistryService');
const { personal } = require('../../src/services/memoryNoteService');

const env = { OWNER_MAIL_RAG_TOKEN: 'k'.repeat(40), RAG_SERVICE_URL: 'http://rag.test' };
const sha = n => String(n).repeat(64);

// A fake owner corpus: word overlap scoring, and a log of every call and token.
function fakeRag() {
  const docs = new Map(), calls = [];
  const words = value => new Set(String(value).toLowerCase().match(/[a-zà-ÿ]{3,}/g) || []);
  const send = async ({ path: route, method, body, headers }) => {
    calls.push({ method, route, token: headers['x-agentx-owner-mail-token'], body });
    if (method === 'POST' && route.endsWith('/documents')) {
      body.documents.forEach(d => docs.set(d.documentId, d.text));
      return { ok: true, results: body.documents.map(d => ({ documentId: d.documentId, chunkCount: 1 })) };
    }
    if (method === 'POST' && route.endsWith('/search')) {
      const q = words(body.query);
      const results = [...docs].map(([documentId, text]) => ({ documentId, text, score: [...words(text)].filter(w => q.has(w)).length / q.size }))
        .filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, body.topK);
      return { ok: true, results };
    }
    if (method === 'DELETE') { docs.delete(decodeURIComponent(route.split('/').pop())); return { ok: true }; }
    throw new Error(`unexpected ${method} ${route}`);
  };
  return { docs, calls, deps: { send, env } };
}

const mail = (n, text, extra = {}) => ({ documentId: `mail:message000${n}`, kind: 'mail', text, title: `Synthetic subject ${n}`,
  occurredAt: '2016-07-20T12:00:00Z', people: ['Synthetic Friend'], source: { messageId: `message000${n}`, threadId: `thread000${n}`, sourceSha256: sha(n) }, ...extra });

describe('owner private recall corpus', () => {
  beforeAll(async () => {
    for (const model of [Recall, MemoryNote, Person, Observation, Proposal]) { await model.createCollection(); await model.createIndexes(); }
  });
  beforeEach(async () => { for (const model of [Recall, MemoryNote, Person, Observation, Proposal]) await model.deleteMany({}); });

  test('without its token configured, recall refuses before calling RAG', async () => {
    const { calls } = fakeRag();
    await expect(recall.search('lake', {}, { send: async () => { calls.push(1); }, env: {} })).rejects.toMatchObject({ statusCode: 503 });
    expect(calls).toEqual([]);
  });

  test('indexes mail once, keeps provenance without the text, and finds it by meaning', async () => {
    const rag = fakeRag();
    expect(await recall.index([mail(1, 'Synthetic canoe trip on the lake planned for Saturday')], rag.deps)).toMatchObject({ indexed: 1 });
    expect(await recall.index([mail(1, 'Synthetic canoe trip on the lake planned for Saturday')], rag.deps)).toMatchObject({ indexed: 0, unchanged: 1 });
    expect(rag.calls.filter(c => c.route.endsWith('/documents'))).toHaveLength(1);
    expect(rag.calls.every(c => c.token === env.OWNER_MAIL_RAG_TOKEN && c.route.startsWith('/api/rag/owner-mail'))).toBe(true);
    const row = await Recall.findOne({ documentId: 'mail:message0001' }).lean();
    expect(row).toMatchObject({ kind: 'mail', state: 'indexed', people: ['Synthetic Friend'] });
    expect(row.text).toBeUndefined();
    const { results } = await recall.search('canoe lake', {}, rag.deps);
    expect(results[0]).toMatchObject({ documentId: 'mail:message0001', kind: 'mail', people: ['Synthetic Friend'],
      source: { messageId: 'message0001', archiveUrl: `/api/secretary/archive/message0001?sha256=${sha(1)}` } });
    expect(new Date(results[0].occurredAt).toISOString()).toBe('2016-07-20T12:00:00.000Z');
  });

  test('souvenirs and people are synced; a forgotten souvenir is never returned and leaves the index', async () => {
    const rag = fakeRag();
    const kept = await personal().keepSouvenir({ text: 'Synthetic canoe trip on the lake', eventDate: '2016-07-30', eventDatePrecision: 'day',
      people: ['Synthetic Friend'], places: ['Synthetic Lake'], sourceRefs: [{ system: 'gmail', id: sha(1) }] });
    await people.observe([{ source: 'gmail-header', role: 'from', direction: 'received', name: 'Synthetic Friend', email: 'friend@example.test',
      occurredAt: '2016-07-20T12:00:00Z', ref: { threadId: 'thread0001', messageId: 'message0001', sourceSha256: sha(1) } }]);
    expect(await recall.sync({}, rag.deps)).toMatchObject({ indexed: 2, removed: 0, remaining: 0 });
    let { results } = await recall.search('canoe lake friend', {}, rag.deps);
    expect(results.map(r => r.kind).sort()).toEqual(['person', 'souvenir']);
    expect(results.find(r => r.kind === 'souvenir')).toMatchObject({ souvenirNoteId: kept.id, people: ['Synthetic Friend'] });
    await personal().forget(kept.id);
    ({ results } = await recall.search('canoe lake friend', {}, rag.deps));
    expect(results.map(r => r.kind)).toEqual(['person']);
    expect(await recall.sync({}, rag.deps)).toMatchObject({ removed: 1 });
    expect(rag.docs.has(`souvenir:${kept.id}`)).toBe(false);
  });

  test('a document the owner forgets leaves the index and is never indexed again', async () => {
    const rag = fakeRag();
    await recall.index([mail(2, 'Synthetic note about a private matter')], rag.deps);
    await recall.forget('mail:message0002', rag.deps);
    expect(rag.docs.has('mail:message0002')).toBe(false);
    expect(await recall.index([mail(2, 'Synthetic note about a private matter')], rag.deps)).toMatchObject({ indexed: 0, refusedForgotten: 1 });
    expect((await recall.search('private matter', {}, rag.deps)).results).toEqual([]);
  });

  test('only mail or file documents with a preserved source are accepted from the importer', async () => {
    const rag = fakeRag();
    for (const bad of [{ ...mail(3, 'x'), documentId: 'souvenir:abcdefgh1', kind: 'souvenir' }, { ...mail(3, 'x'), kind: 'file' },
      { ...mail(3, 'x'), source: { messageId: 'message0003', sourceSha256: 'short' } }, mail(3, '')]) {
      await expect(recall.index([bad], rag.deps)).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(rag.calls).toEqual([]);
  });

  test('only the Nestor owner contract selects the private audience; MCP and Family never reach the corpus', () => {
    const core = path.resolve(__dirname, '../..');
    const files = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
      ? (entry.name === 'node_modules' || entry.name === 'public' ? [] : files(path.join(dir, entry.name)))
      : entry.name.endsWith('.js') ? [path.join(dir, entry.name)] : []);
    const users = (pattern) => ['src', 'routes', 'surfaces'].flatMap(dir => files(path.join(core, dir)))
      .filter(file => !file.includes(`${path.sep}test${path.sep}`) && pattern.test(fs.readFileSync(file, 'utf8')))
      .map(file => path.relative(core, file).split(path.sep).join('/')).sort();
    expect(users(/'owner-private'/)).toEqual(['routes/nestor-consumer-v1.js', 'src/services/memoryReadService.js']);
    expect(users(/ownerRecallService/)).toEqual(['src/services/memoryReadService.js', 'surfaces/household/secretary-recall.js']);
    expect(users(/owner-mail|OWNER_MAIL_RAG_TOKEN/)).toEqual(['src/services/ownerRecallService.js']);
  });

  test('the owner-private audience ranks shared owner results and private recall together', async () => {
    const { forAudience } = require('../../src/services/memoryReadService');
    const ragClient = { searchSimilarChunks: async () => [{ text: 'Synthetic vault note', score: 0.7, metadata: { scope: 'owner' } }] };
    const recall = { search: async (_q, options) => ({ results: [{ documentId: 'mail:message0001', kind: 'mail', score: 0.9,
      excerpt: 'Synthetic canoe trip', people: ['Synthetic Friend'], occurredAt: '2016-07-20T12:00:00Z',
      source: { messageId: 'message0001' }, limit: options.limit }] }) };
    const results = await forAudience('owner-private', { ragClient, recall, minScore: 0.5 }).search('canoe', { topK: 5 });
    expect(results.map(r => r.text)).toEqual(['Synthetic canoe trip', 'Synthetic vault note']);
    expect(results[0].metadata).toMatchObject({ source: 'owner-recall', sensitivity: 'private', kind: 'mail',
      people: ['Synthetic Friend'], provenance: { messageId: 'message0001' } });
    expect(() => forAudience('family-private')).toThrow('server-selected');
  });
});
