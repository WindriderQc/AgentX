'use strict';

jest.mock('../../src/services/embeddingReindex', () => ({
  status: jest.fn(async () => ({ profile: { active: { model: 'nomic-embed-text:v1.5' } }, build: null, request: null })),
  requestChange: jest.fn(async (body) => ({ id: 'req-1', state: 'reserved', executor: { model: body.model } })),
  cancelChange: jest.fn(async (id) => ({ id, state: 'cancelled' })),
  retirePrevious: jest.fn(async (body) => ({ collection: body.collection, deleted: true }))
}));
const express = require('express');
const request = require('supertest');
const reindex = require('../../src/services/embeddingReindex');
const { assertEditableTask } = require('../../src/services/routing/editableTasks');

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/nerve-center', require('../../routes/nerve-center-embeddings'));
  return instance;
}

describe('Nerve Center embeddings API', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a change needs the typed confirmation naming the model', async () => {
    const body = { model: 'qllama/bge-m3:f16', dimension: 1024 };
    const missing = await request(app()).post('/api/nerve-center/embeddings/change').send(body);
    expect(missing.status).toBe(400);
    expect(missing.body.confirmation.expected).toBe('CHANGE EMBEDDING MODEL TO qllama/bge-m3:f16');
    expect(reindex.requestChange).not.toHaveBeenCalled();
    const ok = await request(app()).post('/api/nerve-center/embeddings/change')
      .set('x-agentx-confirm', 'CHANGE EMBEDDING MODEL TO qllama/bge-m3:f16').send(body);
    expect(ok.status).toBe(202);
    expect(ok.body.data).toMatchObject({ state: 'reserved' });
  });

  test('a refusal keeps its status, code and details', async () => {
    reindex.requestChange.mockRejectedValueOnce(Object.assign(new Error('queued'), { statusCode: 409, code: 'EMBEDDING_REINDEX_PENDING', details: { requestId: 'req-0' } }));
    const res = await request(app()).post('/api/nerve-center/embeddings/change')
      .set('x-agentx-confirm', 'CHANGE EMBEDDING MODEL TO m-embed').send({ model: 'm-embed', dimension: 8 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'EMBEDDING_REINDEX_PENDING', details: { requestId: 'req-0' } });
  });

  test('reads the state and cancels a request', async () => {
    expect((await request(app()).get('/api/nerve-center/embeddings')).body.data.profile.active.model).toBe('nomic-embed-text:v1.5');
    const res = await request(app()).post('/api/nerve-center/embeddings/requests/req-1/cancel').send({ expectedRevision: 2 });
    expect(reindex.cancelChange).toHaveBeenCalledWith('req-1', { expectedRevision: 2 }, expect.any(String));
    expect(res.body.data.state).toBe('cancelled');
  });

  test('the generic router task editor refuses the embeddings task', () => {
    expect(() => assertEditableTask('embeddings')).toThrow(expect.objectContaining({ statusCode: 409, code: 'EMBEDDINGS_CHANGE_REQUIRES_REINDEX' }));
    expect(assertEditableTask('chat')).toBe('chat');
  });

  test('retiring the previous collection needs the typed confirmation naming it', async () => {
    const body = { collection: 'docs', expectedRevision: 1 };
    const missing = await request(app()).post('/api/nerve-center/embeddings/previous/retire').send(body);
    expect(missing.status).toBe(400);
    expect(missing.body.confirmation.expected).toBe('DELETE EMBEDDING COLLECTION docs');
    expect(reindex.retirePrevious).not.toHaveBeenCalled();
    const ok = await request(app()).post('/api/nerve-center/embeddings/previous/retire')
      .set('x-agentx-confirm', 'DELETE EMBEDDING COLLECTION docs').send(body);
    expect(ok.body.data).toEqual({ collection: 'docs', deleted: true });
  });
});
