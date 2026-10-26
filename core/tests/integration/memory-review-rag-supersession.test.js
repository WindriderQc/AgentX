'use strict';

const { createHash: hashOf } = require('node:crypto');
// A faithful in-memory RAG boundary: reads expose a revision fingerprint, and
// validity writes refuse a changed document exactly like the RAG service.
function fakeRag(hits = []) {
  const docs = new Map(), calls = [];
  const notFound = () => Object.assign(new Error('RAG returned 404: Document not found'), { status: 404 });
  const fingerprint = doc => hashOf('sha256').update(JSON.stringify(doc)).digest('hex');
  const view = doc => ({ documentId: doc.documentId, source: doc.source,
    metadata: { ...doc.metadata, revisionFingerprint: fingerprint(doc) } });
  return { docs, calls,
    seed(documentId, text, metadata, source = 'nestor-memory') {
      docs.set(documentId, { documentId, source, text, metadata: { scope: 'owner', sensitivity: 'private', validFrom: null,
        sourceRefs: [], invalidatedAt: null, supersededBy: null, ...metadata } });
    },
    async getDocument(id) { calls.push(['get', id]); const doc = docs.get(id); if (!doc) throw notFound(); return view(doc); },
    async getDocumentChunks(id) { const doc = docs.get(id); if (!doc) throw notFound(); return { documentId: id, chunks: [{ chunkIndex: 0, text: doc.text }] }; },
    async upsertDocumentWithChunks(text, m) {
      calls.push(['upsert', m.documentId]);
      docs.set(m.documentId, { documentId: m.documentId, source: m.source, text, metadata: { scope: m.scope, sensitivity: m.sensitivity,
        validFrom: m.validFrom || null, sourceRefs: m.sourceRefs || [], invalidatedAt: null, supersededBy: null } });
      return { documentId: m.documentId, status: 'created' };
    },
    async setDocumentValidity(id, { invalidatedAt, supersededBy, expectedFingerprint }) {
      calls.push(['validity', id, supersededBy]);
      const doc = docs.get(id); if (!doc) throw notFound();
      if (fingerprint(doc) !== expectedFingerprint) throw Object.assign(new Error('RAG returned 409: The document changed after review'), { status: 409 });
      doc.metadata = { ...doc.metadata, invalidatedAt, supersededBy };
      return { documentId: id };
    },
    async deleteDocument(id) { calls.push(['delete', id]); if (!docs.delete(id)) throw notFound(); return { documentId: id }; },
    async searchSimilarChunks() { return hits; },
  };
}

const mockRag = fakeRag([{ text: 'Synthetic backup runs on host A', score: 0.99, metadata: { documentId: 'rag-backup-a', source: 'nestor-memory' } }]);
jest.mock('../../src/services/ragServiceClient', () => ({ getRagServiceClient: () => mockRag }));

const express = require('express');
const request = require('supertest');
const Run = require('../../models/MemoryReviewRun');
const dedup = require('../../src/services/memoryReview/dedupService');
const { ragReplacementSuccessorFor } = require('../../src/services/memoryReview/ragReplacement');
const app = express();
app.use(express.json());
app.use('/api/memory-review', require('../../routes/memory-review'));
const base = '/api/memory-review/runs/synthetic-rag-replacement-run';
let proposed;
const prior = { mode: process.env.MEMORY_REVIEW_MODE, automation: process.env.MEMORY_REVIEW_AUTOMATION_MODE };
afterAll(() => { for (const [key, name] of [['mode', 'MEMORY_REVIEW_MODE'], ['automation', 'MEMORY_REVIEW_AUTOMATION_MODE']]) {
  if (prior[key] === undefined) delete process.env[name]; else process.env[name] = prior[key]; } });

beforeEach(async () => {
  await Run.deleteMany({});
  mockRag.docs.clear(); mockRag.calls.length = 0;
  mockRag.seed('rag-backup-a', 'Synthetic backup runs on host A', { validFrom: '2026-01-05T00:00:00.000Z' });
  process.env.MEMORY_REVIEW_MODE = 'apply'; process.env.MEMORY_REVIEW_AUTOMATION_MODE = 'safe';
  const observations = [{ observationId: 'obs-synthetic', runtime: 'codex', host: 'synthetic', sessionId: 'synthetic-owner-session',
    trust: 'explicit_memory_request', text: 'Synthetic backup now runs on host B', contentHash: 'b'.repeat(64) }];
  const context = await dedup.buildRagDedupContext(observations, { ragClient: mockRag });
  await Run.create({ runId: 'synthetic-rag-replacement-run', runKey: 'synthetic-rag-replacement', status: 'synthesizing',
    observations, dedupContext: context });
  proposed = { type: 'supersedes', statement: 'Synthetic backup now runs on host B', rationale: 'The owner explicitly changed the host',
    target: { kind: 'shared_fact' }, evidenceRefs: ['obs-synthetic'], confidence: 1, scope: 'owner', sensitivity: 'private',
    supersedes: { authority: 'rag', ref: 'rag-backup-a' } };
});

async function submit(value = proposed) {
  const response = await request(app).post(base + '/candidates').send({ candidates: [value] }).expect(200);
  const candidate = (await Run.findOne({ runId: 'synthetic-rag-replacement-run' }).lean()).candidates[0];
  return { response, candidate, path: candidate ? `${base}/candidates/${candidate.candidateId}` : null };
}
async function reviewed() {
  const result = await submit();
  await request(app).post(result.path + '/review').send({ action: 'approve' }).expect(200);
  await request(app).post(base + '/authorize-apply').send({}).expect(200);
  return result;
}

test('an observed owner RAG fact binds with its revision fingerprint and still needs individual review', async () => {
  const { candidate, path } = await submit();
  expect(candidate).toMatchObject({ type: 'supersedes', status: 'proposed', automation: { disposition: 'review' },
    supersedes: { authority: 'rag', ref: 'rag-backup-a', fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  await request(app).post(path + '/apply').send({}).expect(403);
  expect(mockRag.calls.some(([op]) => op === 'upsert' || op === 'validity')).toBe(false);
});

test('an unobserved or malformed RAG reference is dropped', async () => {
  for (const value of [{ ...proposed, supersedes: { authority: 'rag', ref: 'invented-doc' } },
    { ...proposed, supersedes: { authority: 'rag', ref: ' padded ' } }, { ...proposed, scope: 'household' }]) {
    const { response } = await submit(value);
    expect(response.body.data.accepted).toBe(0);
    await Run.updateOne({ runId: 'synthetic-rag-replacement-run' }, { $set: { status: 'synthesizing' } });
  }
});

test('review, apply, replay, preview and restore work through the existing HTTP boundary', async () => {
  const { path } = await reviewed();
  const preview = (await request(app).get(base).expect(200)).body.data.candidates[0].supersessionPreview;
  expect(preview).toMatchObject({ text: 'Synthetic backup runs on host A' });
  const applied = await request(app).post(path + '/apply').send({}).expect(200);
  expect(applied.body.data.status).toBe('applied');
  const successor = ragReplacementSuccessorFor(`memory-review:synthetic-rag-replacement-run:${applied.body.data.candidateId}`);
  expect(mockRag.docs.get(successor)).toMatchObject({ source: 'nestor-memory', text: proposed.statement,
    metadata: { sourceRefs: [{ system: 'memory-review', id: `synthetic-rag-replacement-run:${applied.body.data.candidateId}` }] } });
  expect(mockRag.docs.get('rag-backup-a').metadata).toMatchObject({ supersededBy: successor, invalidatedAt: expect.any(String) });
  expect((await request(app).post(path + '/apply').send({}).expect(200)).body.data.alreadyApplied).toBe(true);
  expect((await request(app).post(path + '/rollback').send({}).expect(200)).body.data.status).toBe('rolled_back');
  expect(mockRag.docs.get('rag-backup-a').metadata).toMatchObject({ supersededBy: null, invalidatedAt: null });
  expect(mockRag.docs.has(successor)).toBe(false);
  expect((await request(app).post(path + '/rollback').send({}).expect(200)).body.data.alreadyRolledBack).toBe(true);
});

test('a RAG source edited after review fails application without a successor', async () => {
  const { path } = await reviewed();
  mockRag.docs.get('rag-backup-a').text = 'Synthetic changed after review';
  await request(app).post(path + '/apply').send({}).expect(502);
  expect((await Run.findOne({ runId: 'synthetic-rag-replacement-run' }).lean()).candidates[0].status).toBe('apply_failed');
  expect(mockRag.calls.some(([op]) => op === 'upsert')).toBe(false);
});
