'use strict';

jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockState = {};
jest.mock('../../src/services/ragStore', () => {
  const actual = jest.requireActual('../../src/services/ragStore');
  return { ...actual, getRagStore: () => mockState.store };
});
const express = require('express');
const request = require('supertest');
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
  const body = { invalidatedAt: '2026-10-25T00:00:00.000Z', supersededBy: 'fact-b', expectedFingerprint: fingerprint };
  const done = await request(app).post('/api/rag/documents/fact-a/validity').send(body).expect(200);
  expect(done.body.data).toMatchObject({ invalidatedAt: '2026-10-25T00:00:00.000Z', supersededBy: 'fact-b' });
  expect(done.body.data.revisionFingerprint).not.toBe(fingerprint);
  expect((await request(app).post('/api/rag/documents/fact-a/validity').send(body)).status).toBe(409);
  expect((await request(app).post('/api/rag/documents/missing/validity').send(body)).status).toBe(404);
  expect((await request(app).post('/api/rag/documents/fact-a/validity').send({ supersededBy: 'x' })).status).toBe(400);
});
