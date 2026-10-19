jest.mock('../../src/utils/fetchWithTimeout', () => jest.fn());
jest.mock('../../src/services/embeddingProfile', () => ({
  getProfileService: () => ({ read: async () => ({ revision: 3, active: { model: 'model-a', dimension: 4, collection: 'docs' } }) })
}));

const express = require('express');
const request = require('supertest');
const fetchWithTimeout = require('../../src/utils/fetchWithTimeout');
const embeddingBuild = require('../../src/services/embeddingBuild');

const ID = '11111111-2222-4333-8444-555555555555';
const answer = (status, body) => ({ ok: status < 400, status, json: async () => body });

describe('Core queue check before a build', () => {
  const { verifyCoreQueueRequest } = embeddingBuild;
  const job = (over = {}) => ({ ok: true, data: { id: ID, kind: 'embedding-reindex', state: 'dispatching', executor: { model: 'model-b', dimension: 8 }, ...over } });

  test('accepts the dispatched request for the same model', async () => {
    fetchWithTimeout.mockResolvedValueOnce(answer(200, job()));
    await expect(verifyCoreQueueRequest(ID, { model: 'model-b', dimension: 8 })).resolves.toBeUndefined();
    expect(fetchWithTimeout.mock.calls[0][0]).toMatch(new RegExp(`/api/cluster/schedule/work-queue/${ID}$`));
    expect(fetchWithTimeout.mock.calls[0][3]).toMatchObject({ operationId: 'rag.core-queue.read' });
  });

  test.each([
    ['a reserved request', job({ state: 'reserved' })],
    ['another kind', job({ kind: 'profiler' })],
    ['another model', job({ executor: { model: 'model-c', dimension: 8 } })]
  ])('refuses %s', async (_label, body) => {
    fetchWithTimeout.mockResolvedValueOnce(answer(200, body));
    await expect(verifyCoreQueueRequest(ID, { model: 'model-b', dimension: 8 })).rejects.toMatchObject({ code: 'EMBEDDING_BUILD_NOT_QUEUED' });
  });

  test('refuses when Core does not know the request', async () => {
    fetchWithTimeout.mockResolvedValueOnce(answer(404, { ok: false }));
    await expect(verifyCoreQueueRequest(ID, { model: 'model-b', dimension: 8 })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('embedding build routes', () => {
  function app(service) {
    jest.spyOn(embeddingBuild, 'getBuildService').mockReturnValue(service);
    const instance = express();
    instance.use(express.json());
    instance.use('/api/rag', require('../../routes/migration.routes'));
    return instance;
  }

  test('reads the profile with the latest build, starts, reads and cancels a build', async () => {
    const service = {
      latest: async () => ({ id: ID, status: 'copying' }),
      start: jest.fn(async (input) => ({ id: input.buildId, status: 'copying' })),
      get: async (id) => (id === ID ? { id, status: 'copying' } : null),
      cancel: async (id) => ({ id, status: 'copying', cancelRequested: true })
    };
    const server = app(service);
    const profile = await request(server).get('/api/rag/embedding-profile');
    expect(profile.body.data).toMatchObject({ profile: { revision: 3 }, build: { id: ID } });
    const started = await request(server).post('/api/rag/embedding-builds').send({ buildId: ID, model: 'model-b', dimension: 8, extra: 'ignored' });
    expect(started.status).toBe(202);
    expect(service.start).toHaveBeenCalledWith({ buildId: ID, model: 'model-b', dimension: 8 });
    expect((await request(server).get(`/api/rag/embedding-builds/${ID}`)).body.data.status).toBe('copying');
    expect((await request(server).get('/api/rag/embedding-builds/other')).status).toBe(404);
    expect((await request(server).post(`/api/rag/embedding-builds/${ID}/cancel`)).body.data.cancelRequested).toBe(true);
  });

  test('passes a refusal through with its status and code', async () => {
    const service = { start: async () => { throw Object.assign(new Error('busy'), { statusCode: 409, code: 'EMBEDDING_BUILD_ACTIVE' }); } };
    const res = await request(app(service)).post('/api/rag/embedding-builds').send({ buildId: ID, model: 'model-b', dimension: 8 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ok: false, error: 'EMBEDDING_BUILD_ACTIVE' });
  });
});
