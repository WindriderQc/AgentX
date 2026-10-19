'use strict';

jest.mock('../../src/helpers/crossServiceClient', () => ({ requestJson: jest.fn(), CrossServiceClientError: class extends Error {} }));
jest.mock('../../src/services/modelRouter', () => ({ getTargetForModel: jest.fn(() => 'http://127.0.0.1:11434'), resolveHostKey: () => null }));
const { getTargetForModel } = require('../../src/services/modelRouter');
const { requestJson } = require('../../src/helpers/crossServiceClient');
const Queue = require('../../models/HeavyWorkQueue');
const Archive = require('../../models/HeavyWorkQueueArchive');
const queue = require('../../src/services/heavyWorkQueueService');
const reindex = require('../../src/services/embeddingReindex');

const at = minutes => new Date(Date.now() + minutes * 60000).toISOString();
const KEY = '0f0e0d0c-0b0a-4908-8706-050403020100';
const OTHER_KEY = '1f0e0d0c-0b0a-4908-8706-050403020100';
const change = (over = {}) => ({ model: 'qllama/bge-m3:f16', dimension: 1024, expectedModel: 'nomic-embed-text:v1.5', start: at(30), requestKey: KEY, ...over });

let stopped;
beforeEach(async () => {
  await Queue.deleteMany({}); await Archive.deleteMany({});
  stopped = [];
  requestJson.mockReset();
  requestJson.mockImplementation(async ({ path, method }) => {
    if (method === 'GET' && path === '/api/rag/embedding-profile') {
      return { ok: true, data: { profile: { revision: 0, active: { model: 'nomic-embed-text:v1.5', dimension: 768, collection: 'docs' } }, build: null } };
    }
    const cancel = path.match(/^\/api\/rag\/embedding-builds\/([^/]+)\/cancel$/);
    if (method === 'POST' && cancel) { stopped.push(cancel[1]); return { ok: true, data: { id: cancel[1], status: 'copying', cancelRequested: true } }; }
    throw new Error(`Unexpected ${method} ${path}`);
  });
});

it('queues the rebuild with its slot and automatic start, and embeds nothing now', async () => {
  const job = await reindex.requestChange(change(), 'owner');
  expect(job).toMatchObject({
    kind: 'embedding-reindex', state: 'reserved', executor: { model: 'qllama/bge-m3:f16', dimension: 1024 },
    hosts: ['http://localhost:11434'], reservation: { autoStart: true }
  });
  expect(requestJson.mock.calls.every(([options]) => options.method === 'GET')).toBe(true);
  // The same click replayed after a lost answer finds the same request.
  expect((await reindex.requestChange(change(), 'owner')).id).toBe(job.id);
  expect((await queue.list()).jobs).toHaveLength(1);
});

it('refuses a second change while one is queued, a stale view, the served model and a chat model', async () => {
  const first = await reindex.requestChange(change(), 'owner');
  await expect(reindex.requestChange(change({ requestKey: OTHER_KEY, model: 'mxbai-embed-large', dimension: 1024 }), 'owner'))
    .rejects.toMatchObject({ statusCode: 409, code: 'EMBEDDING_REINDEX_PENDING', details: { requestId: first.id } });
  await queue.cancel(first.id, { expectedRevision: first.revision }, 'owner');
  await expect(reindex.requestChange(change({ requestKey: OTHER_KEY, expectedModel: 'other' }), 'owner')).rejects.toMatchObject({ code: 'EMBEDDING_PROFILE_CHANGED' });
  await expect(reindex.requestChange(change({ requestKey: OTHER_KEY, model: 'nomic-embed-text:v1.5', dimension: 768 }), 'owner')).rejects.toMatchObject({ code: 'EMBEDDING_MODEL_UNCHANGED' });
  await expect(reindex.requestChange(change({ requestKey: OTHER_KEY, model: 'llama3.2:1b' }), 'owner')).rejects.toMatchObject({ statusCode: 400 });
  await expect(reindex.requestChange(change({ requestKey: 'not-a-key' }), 'owner')).rejects.toMatchObject({ statusCode: 400 });
});

it('refuses clearly when no Ollama host serves the model', async () => {
  getTargetForModel.mockReturnValueOnce(null);
  await expect(reindex.requestChange(change(), 'owner')).rejects.toMatchObject({ statusCode: 409, code: 'EMBEDDING_HOST_UNAVAILABLE' });
  expect((await queue.list())?.jobs || []).toHaveLength(0);
});

it('cancels before the launch in the queue, and during the copy through RAG', async () => {
  const job = await reindex.requestChange(change(), 'owner');
  expect(await reindex.cancelChange(job.id, { expectedRevision: job.revision }, 'owner')).toMatchObject({ state: 'cancelled' });
  expect(stopped).toEqual([]);

  const running = await reindex.requestChange(change({ requestKey: OTHER_KEY, start: at(-1) }), 'owner');
  // Simulate the launch crossing its dispatch fence.
  const begun = await queue.begin(running.id, { expectedRevision: running.revision }, 'core-auto-start');
  await queue.record(running.id, { dispatchId: begun.dispatchId, state: 'running', operationId: running.id }, 'core-auto-start');
  const result = await reindex.cancelChange(running.id, {}, 'owner');
  expect(stopped).toEqual([running.id]);
  expect(result).toMatchObject({ state: 'running', build: { cancelRequested: true } });
});

it('reports the serving profile, the latest build and the open request', async () => {
  const job = await reindex.requestChange(change(), 'owner');
  expect(await reindex.status()).toMatchObject({ profile: { active: { model: 'nomic-embed-text:v1.5' } }, build: null, request: { id: job.id, state: 'reserved' } });
});
