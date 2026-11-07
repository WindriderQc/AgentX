'use strict';

jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockState = {};
jest.mock('../../src/services/ragStore', () => {
  const actual = jest.requireActual('../../src/services/ragStore');
  return { ...actual, getRagStore: () => mockState.store };
});
const express = require('express');
const request = require('supertest');
const { createHash } = require('node:crypto');
const { RagStore } = require('../../src/services/ragStore');
const app = express(); app.use(express.json()); app.use('/api/rag', require('../../routes/document.routes'));

beforeEach(async () => {
  mockState.store = new RagStore({ type: 'memory' });
  mockState.store.embeddingsService = { embedBatch: async (texts) => texts.map(() => [0.1, 0.2, 0.3]) };
  await mockState.store.upsertDocumentWithChunks('Synthetic fact A', { documentId: 'fact-a', source: 'nestor-memory', scope: 'owner', sensitivity: 'private' });
});

test('the document read exposes a revision fingerprint and the validity route is conditional on it', async () => {
  const read = await request(app).get('/api/rag/documents/fact-a').expect(200);
  const fingerprint = read.body.data.metadata.revisionFingerprint;
  expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(read.body.data.metadata).toMatchObject({
    contentHash: createHash('sha256').update('Synthetic fact A').digest('hex'), mixedRevision: false,
  });
  const body = { invalidatedAt: '2026-10-25T00:00:00.000Z', supersededBy: 'fact-b', expectedFingerprint: fingerprint };
  const done = await request(app).post('/api/rag/documents/fact-a/validity').send(body).expect(200);
  expect(done.body.data).toMatchObject({ invalidatedAt: '2026-10-25T00:00:00.000Z', supersededBy: 'fact-b' });
  expect(done.body.data.revisionFingerprint).not.toBe(fingerprint);
  expect((await request(app).post('/api/rag/documents/fact-a/validity').send(body)).status).toBe(409);
  expect((await request(app).post('/api/rag/documents/missing/validity').send(body)).status).toBe(404);
  expect((await request(app).post('/api/rag/documents/fact-a/validity').send({ supersededBy: 'x' })).status).toBe(400);
});

test('the document read reports an incomplete native revision instead of confirming it', async () => {
  const original = mockState.store.getDocument.bind(mockState.store);
  mockState.store.getDocument = async id => ({ ...await original(id), mixedRevision: true });
  const read = await request(app).get('/api/rag/documents/fact-a').expect(200);
  expect(read.body.data.metadata.mixedRevision).toBe(true);
});

test('the replacement routes resume the initial write and refuse removal after an edit', async () => {
  const body = { key: 'memory-review:synthetic:one', text: 'Synthetic successor', source: 'nestor-memory',
    scope: 'owner', sensitivity: 'private', validFrom: null, sourceRefs: [] };
  const path = '/api/rag/documents/fact-b/replacement';
  await request(app).post(path).send(body).expect(200);
  const read = await request(app).get('/api/rag/documents/fact-b').expect(200);
  expect(read.body.data.metadata).toMatchObject({ replacementWrite: { key: body.key,
    fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), revision: expect.any(String) }, replacementUnchanged: true });
  expect((await request(app).post(path).send(body).expect(200)).body.data.status).toBe('unchanged');
  await request(app).delete(path).send({ key: 'wrong' }).expect(409);
  await mockState.store.upsertDocumentWithChunks('Synthetic edited successor', { documentId: 'fact-b', source: 'nestor-memory' });
  await request(app).post(path).send(body).expect(409);
  await request(app).delete(path).send({ key: body.key }).expect(409);
  expect((await request(app).get('/api/rag/documents/fact-b').expect(200)).body.data.metadata.replacementUnchanged).toBe(false);
  await request(app).delete(path).send({}).expect(400);
  await request(app).post(path).send({ ...body, scope: 'household' }).expect(400);
});

test('conditional removal is idempotent after an absent result', async () => {
  const body = { key: 'memory-review:synthetic:two', text: 'Synthetic successor', source: 'nestor-memory',
    scope: 'owner', sensitivity: 'private', validFrom: null, sourceRefs: [] };
  const path = '/api/rag/documents/fact-b/replacement';
  await request(app).post(path).send(body).expect(200);
  expect((await request(app).delete(path).send({ key: body.key }).expect(200)).body.data.status).toBe('removed');
  expect((await request(app).delete(path).send({ key: body.key }).expect(200)).body.data.status).toBe('absent');
});
