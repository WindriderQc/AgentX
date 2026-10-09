'use strict';

const request = require('supertest');

describe('Data service with its disposable MongoDB', () => {
  let runtime;
  let server;
  beforeAll(async () => {
    process.env.PORT = '0';
    process.env.HOST = '127.0.0.1';
    runtime = require('../../server');
    await request(runtime.app).get('/health').expect(503);
    server = await runtime.start();
  });
  afterAll(async () => { if (runtime) await runtime.shutdown(); });

  test('serves every read-only Toolbox capability from a clean database', async () => {
    for (const route of ['/health', '/api/v1/system/resources', '/api/v1/storage/summary',
      '/api/v1/network/devices', '/api/v1/hardware/latest', '/api/v1/livedata/feeds', '/api/v1/databases/collections',
      '/api/v1/janitor/profiles', '/api/v1/events', '/api/v1/exports', '/api/v1/storage/trends']) {
      const response = await request(server).get(route).expect(200);
      expect(response.body.ok).toBe(true);
    }
    expect(await runtime.app.locals.db.collection('janitor_runs').countDocuments()).toBe(0);
  });

  test('health reports the shared service identity with its revision', async () => {
    const previous = process.env.AGENTX_BUILD_REVISION;
    process.env.AGENTX_BUILD_REVISION = 'abc1234';
    try {
      const { body } = await request(server).get('/health').expect(200);
      expect(body).toMatchObject({ ok: true, service: 'agentx-data', revision: 'abc1234' });
      expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(['demo', 'full']).toContain(body.profile);
      expect(new Date(body.ts).toISOString()).toBe(body.ts);
    } finally {
      if (previous === undefined) delete process.env.AGENTX_BUILD_REVISION;
      else process.env.AGENTX_BUILD_REVISION = previous;
    }
  });

  test('a missing network target cannot start a scan', async () => {
    await request(server).post('/api/v1/network/scan').send({}).expect(400);
  });
});
