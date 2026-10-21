/**
 * /api/rag/owner-mail: the owner's private recall corpus in its own collection,
 * reachable only with Core's token.
 */

jest.mock('mongoose', () => ({
  connection: { readyState: 1 },
  Schema: class { constructor() {} index() {} },
  model: jest.fn(() => ({}))
}));

// Deterministic word-hash embeddings: texts sharing words are close.
const embed = text => {
  const vector = new Array(32).fill(0);
  for (const word of String(text).toLowerCase().match(/[a-z]{3,}/g) || []) {
    let h = 0;
    for (const c of word) h = (h * 31 + c.charCodeAt(0)) % 32;
    vector[h] += 1;
  }
  return vector;
};
jest.mock('../../src/services/embeddings', () => ({
  getEmbeddingsService: jest.fn(() => ({
    embedBatch: jest.fn(async texts => texts.map(embed)),
    testConnection: jest.fn().mockResolvedValue(true),
    providerName: 'mock',
    model: 'mock-model'
  }))
}));
jest.mock('../../src/services/embeddingCache', () => ({ getEmbeddingCache: jest.fn(() => null) }));

const express = require('express');
const supertest = require('supertest');
const TOKEN = 't'.repeat(40);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/rag/owner-mail', require('../../routes/ownerMail.routes'));
  return app;
}

describe('owner recall corpus routes', () => {
  let request, ownerStore, sharedStore;
  beforeEach(() => {
    jest.resetModules();
    process.env.VECTOR_STORE_TYPE = 'memory';
    process.env.OWNER_MAIL_RAG_TOKEN = TOKEN;
    request = supertest(buildApp());
    ownerStore = require('../../src/services/ownerMailStore');
    sharedStore = require('../../src/services/ragStore');
  });
  afterEach(() => { delete process.env.OWNER_MAIL_RAG_TOKEN; });

  test('refuses every call without the configured token', async () => {
    await request.post('/api/rag/owner-mail/search').send({ query: 'lake' }).expect(403);
    await request.post('/api/rag/owner-mail/search').set('x-agentx-owner-mail-token', 'x'.repeat(40)).send({ query: 'lake' }).expect(403);
    delete process.env.OWNER_MAIL_RAG_TOKEN;
    const unconfigured = await request.post('/api/rag/owner-mail/search').set('x-agentx-owner-mail-token', TOKEN).send({ query: 'lake' }).expect(503);
    expect(unconfigured.body.code).toBe('OWNER_MAIL_RECALL_UNCONFIGURED');
  });

  test('indexes, finds by meaning and forgets, apart from the shared collection', async () => {
    const auth = req => req.set('x-agentx-owner-mail-token', TOKEN);
    await auth(request.post('/api/rag/owner-mail/documents')).send({ documents: [
      { documentId: 'mail:message0001', text: 'Synthetic canoe trip on the lake with a friend in summer' },
      { documentId: 'mail:message0002', text: 'Synthetic invoice for winter tires and an oil change' }] }).expect(200);
    const found = await auth(request.post('/api/rag/owner-mail/search')).send({ query: 'canoe lake trip', topK: 2 }).expect(200);
    expect(found.body.results[0]).toMatchObject({ documentId: 'mail:message0001' });
    expect(found.headers['cache-control']).toBe('no-store');
    expect((await sharedStore.getRagStore().getStats()).documentCount).toBe(0);
    expect((await ownerStore.getOwnerMailStore().getStats()).documentCount).toBe(2);
    await auth(request.delete('/api/rag/owner-mail/documents/mail:message0001')).expect(200);
    const after = await auth(request.post('/api/rag/owner-mail/search')).send({ query: 'canoe lake trip', topK: 5 }).expect(200);
    expect(after.body.results.map(r => r.documentId)).not.toContain('mail:message0001');
  });

  test('validates ids, sizes and queries', async () => {
    const auth = req => req.set('x-agentx-owner-mail-token', TOKEN);
    await auth(request.post('/api/rag/owner-mail/documents')).send({ documents: [{ documentId: '../etc', text: 'x' }] }).expect(400);
    await auth(request.post('/api/rag/owner-mail/documents')).send({ documents: [] }).expect(400);
    await auth(request.post('/api/rag/owner-mail/search')).send({ query: '' }).expect(400);
    await auth(request.delete('/api/rag/owner-mail/documents/bad')).expect(400);
  });

  test('the private corpus never shares the shared collection name', () => {
    expect(() => ownerStore.collectionName({ QDRANT_COLLECTION: 'same', QDRANT_OWNER_MAIL_COLLECTION: 'same' })).toThrow('own collection');
    expect(ownerStore.collectionName({})).toBe('agentx_owner_mail');
  });
});
