'use strict';

jest.mock('../../src/helpers/crossServiceClient', () => ({ requestJson: jest.fn(), CrossServiceClientError: class extends Error {} }));
jest.mock('../../src/services/modelRouter', () => ({ getTargetForModel: () => 'http://127.0.0.1:11434', resolveHostKey: () => null }));
const { requestJson } = require('../../src/helpers/crossServiceClient');
const Queue = require('../../models/HeavyWorkQueue');
const Archive = require('../../models/HeavyWorkQueueArchive');
const Runtime = require('../../models/RuntimeCoordination');
const queue = require('../../src/services/heavyWorkQueueService');
const launcher = require('../../src/services/heavyWorkQueueLauncher');
const evidence = require('../../src/services/heavyWorkQueueEvidence');

const A = 'http://127.0.0.1:11434';
const at = minutes => new Date(Date.now() + minutes * 60000).toISOString();
const change = (key, executor = { model: 'qllama/bge-m3:f16', dimension: 1024 }) => ({
  key, title: 'Rebuild RAG embeddings', kind: 'embedding-reindex', hosts: [A], estimatedMinutes: 60, executor
});

// RAG answers: its serving profile, the build start and the build receipt.
function ragAnswers({ servedModel = 'nomic-embed-text:v1.5', servedDimension = 768, start, builds = {} } = {}) {
  requestJson.mockImplementation(async ({ path, method, body }) => {
    if (method === 'GET' && path === '/api/rag/embedding-profile') {
      return { ok: true, data: { profile: { active: { model: servedModel, dimension: servedDimension, collection: 'docs' } }, build: null } };
    }
    if (method === 'POST' && path === '/api/rag/embedding-builds') {
      if (start instanceof Error) throw start;
      builds[body.buildId] = { id: body.buildId, model: body.model, dimension: body.dimension, status: 'copying', progress: { total: 3, documents: 0 } };
      return { ok: true, data: builds[body.buildId] };
    }
    const match = path.match(/^\/api\/rag\/embedding-builds\/([^/]+)$/);
    if (method === 'GET' && match) {
      if (!builds[match[1]]) throw Object.assign(new Error('not found'), { status: 404 });
      return { ok: true, data: builds[match[1]] };
    }
    throw new Error(`Unexpected ${method} ${path}`);
  });
  return builds;
}
const posts = () => requestJson.mock.calls.filter(([options]) => options.method === 'POST');

beforeEach(async () => {
  await Queue.deleteMany({}); await Archive.deleteMany({}); await Runtime.deleteMany({});
  requestJson.mockReset();
});

it('validates the model and dimension and accepts the owner opt-in to start at its slot', async () => {
  await expect(queue.submit(change('bad', { model: 'qllama/bge-m3:f16', dimension: 0 }), 'test')).rejects.toMatchObject({ statusCode: 400 });
  await expect(queue.submit(change('extra', { model: 'm', dimension: 8, collection: 'x' }), 'test')).rejects.toMatchObject({ statusCode: 400 });
  const job = await queue.submit(change('ok'), 'test');
  const booked = await queue.reserve(job.id, { expectedRevision: job.revision, start: at(10), autoStart: true }, 'owner');
  expect(booked.reservation.autoStart).toBe(true);
});

it('starts the RAG build once at its slot with the request id as build id', async () => {
  ragAnswers();
  const job = await queue.submit(change('due'), 'test');
  await queue.reserve(job.id, { expectedRevision: job.revision, start: at(-1), autoStart: true }, 'owner');
  await launcher.dispatchDue();
  expect(await queue.get(job.id)).toMatchObject({ state: 'running', operation: { id: job.id } });
  expect(posts()).toHaveLength(1);
  expect(posts()[0][0].body).toEqual({ buildId: job.id, model: 'qllama/bge-m3:f16', dimension: 1024 });
  await launcher.dispatchDue();
  expect(posts()).toHaveLength(1);
});

it('does not cross the dispatch fence when RAG already serves the model', async () => {
  ragAnswers({ servedModel: 'qllama/bge-m3:f16', servedDimension: 1024 });
  const job = await queue.submit(change('same'), 'test');
  await queue.reserve(job.id, { expectedRevision: job.revision, start: at(-1), autoStart: true }, 'owner');
  await launcher.dispatchDue();
  expect((await queue.get(job.id)).state).toBe('reserved');
  expect(posts()).toHaveLength(0);
});

it('a lost start answer is reconciled from the build RAG holds, never started again', async () => {
  const builds = ragAnswers({ start: new Error('Synthetic socket hang up') });
  const job = await queue.submit(change('lost'), 'test');
  await queue.reserve(job.id, { expectedRevision: job.revision, start: at(-1), autoStart: true }, 'owner');
  await launcher.dispatchDue();
  expect((await queue.get(job.id)).state).toBe('uncertain');
  // RAG did receive it before the answer was lost.
  builds[job.id] = { id: job.id, model: 'qllama/bge-m3:f16', dimension: 1024, status: 'copying', progress: { total: 3, documents: 1 } };
  const observed = await evidence.reconcile(job.id, 'core-queue-observer');
  expect(observed).toMatchObject({ state: 'running', observation: { terminal: false, progress: { documents: 1 } } });
  await launcher.dispatchDue();
  expect(posts()).toHaveLength(1);

  builds[job.id] = { ...builds[job.id], status: 'activated', targetCollection: 'docs__qllama_bge_m3_f16_x', sourceCollection: 'docs' };
  const settled = await evidence.reconcile(job.id, 'core-queue-observer');
  expect(settled).toMatchObject({ state: 'completed', releaseReceipt: { authority: 'rag.embedding-build', collection: 'docs__qllama_bge_m3_f16_x', previousCollection: 'docs' } });
});

it('a failed or cancelled build settles the request with RAG\'s reason', async () => {
  const builds = ragAnswers();
  const job = await queue.submit(change('fails'), 'test');
  await queue.reserve(job.id, { expectedRevision: job.revision, start: at(-1), autoStart: true }, 'owner');
  await launcher.dispatchDue();
  builds[job.id] = { ...builds[job.id], status: 'failed', error: '2 documents could not be copied; the previous index keeps serving' };
  expect(await evidence.reconcile(job.id, 'core-queue-observer')).toMatchObject({
    state: 'failed', releaseReceipt: { error: expect.stringContaining('previous index keeps serving') }
  });
});
