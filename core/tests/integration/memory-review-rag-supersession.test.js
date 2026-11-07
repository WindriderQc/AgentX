'use strict';

const { fakeRag } = require('../helpers/fakeReplacementRag');

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

test('restore reports reconciliation and preserves an edited successor under the original candidate', async () => {
  const { path } = await reviewed();
  const applied = await request(app).post(path + '/apply').send({}).expect(200);
  const successor = ragReplacementSuccessorFor(`memory-review:synthetic-rag-replacement-run:${applied.body.data.candidateId}`);
  mockRag.docs.get(successor).text = 'Synthetic independently edited successor';
  const result = await request(app).post(path + '/rollback').send({}).expect(200);
  expect(result.body.data).toMatchObject({ status: 'rollback_failed', result: expect.stringMatching(/reconcile/) });
  expect((await Run.findOne({ runId: 'synthetic-rag-replacement-run' }).lean()).candidates[0]).toMatchObject({
    status: 'rollback_failed', rollback: { result: expect.stringMatching(/reconcile/) }
  });
  expect(mockRag.docs.get(successor).text).toBe('Synthetic independently edited successor');
  expect(mockRag.docs.get('rag-backup-a').metadata.supersededBy).toBe(successor);
});
