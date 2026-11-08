'use strict';

jest.mock('../../src/services/ollamaHealthProbe', () => ({ refreshOllamaHealth: jest.fn() }));

const request = require('supertest');
const { app } = require('../../src/app');
const systemHealth = require('../../src/systemHealth');
const { refreshOllamaHealth } = require('../../src/services/ollamaHealthProbe');
const nerveCenter = require('../../routes/nerve-center');
const { fleetSummary } = require('../../surfaces/household/panel-sources');

describe('built-in panel Core composition', () => {
  const snapshot = {
    health: { status: 'ok', configuredHosts: 1, onlineHosts: 1, observedModels: 1 },
    cluster: [{ hostKey: 'primary', status: 'online', models: ['synthetic'], hostUrl: 'PRIVATE_HOST' }],
    operationalAttention: { issues: [] }, recentRouting: [{ prompt: 'PRIVATE_PROMPT' }]
  };
  let previousEnv, previousMongo, previousEvidence, ecosystem;

  beforeEach(() => {
    previousEnv = Object.fromEntries(['CORE_INTERNAL_URL', 'VOIX_BASE_URL', 'DATAAPI_BASE_URL'].map(key => [key, process.env[key]]));
    delete process.env.CORE_INTERNAL_URL;
    delete process.env.DATAAPI_BASE_URL;
    process.env.VOIX_BASE_URL = 'http://voix.example.test';
    previousMongo = systemHealth.mongodb;
    systemHealth.mongodb = { status: 'connected' };
    previousEvidence = app.locals.aioOpsRuntimeEvidence;
    delete app.locals.aioOpsRuntimeEvidence;
    refreshOllamaHealth.mockResolvedValue({ status: 'connected' });
    ecosystem = jest.spyOn(nerveCenter, 'buildEcosystemSnapshot').mockResolvedValue(snapshot);
    jest.spyOn(global, 'fetch').mockImplementation(async url => {
      if (new URL(String(url)).hostname === '127.0.0.1') throw new Error('self transport unavailable');
      return new Response(JSON.stringify(String(url).endsWith('/api/voices') ? { voices: [] } : { status: 'ok' }));
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    refreshOllamaHealth.mockReset();
    systemHealth.mongodb = previousMongo;
    app.locals.aioOpsRuntimeEvidence = previousEvidence;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('reads native producers with self transport unavailable and keeps the private projection', async () => {
    const { data } = (await request(app).get('/api/panel/status').expect(200)).body;
    expect(refreshOllamaHealth).toHaveBeenCalledWith(systemHealth);
    expect(ecosystem).toHaveBeenCalledTimes(1);
    expect(data.services.find(service => service.id === 'core')).toMatchObject({ status: 'ok' });
    expect(data.fleet).toEqual({ ...fleetSummary(snapshot), latencyMs: expect.any(Number) });
    expect(data.crew.find(member => member.id === 'openclaw').status).toBe('unknown');
    expect(data.status).toBe('ok');
    expect(JSON.stringify(data)).not.toMatch(/PRIVATE_HOST|PRIVATE_PROMPT/);
    for (const [url] of global.fetch.mock.calls) {
      expect(String(url)).not.toMatch(/127\.0\.0\.1|\/api\/nerve-center\/ecosystem/);
    }
  });

  test.each(['error', 'checking', undefined])('serving the panel does not prove Mongo is connected (%s)', async status => {
    systemHealth.mongodb = { status };
    const health = await request(app).get('/health').expect(503);
    expect(health.body.ok).toBe(false);
    const { data } = (await request(app).get('/api/panel/status').expect(200)).body;
    expect(data.services.find(service => service.id === 'core').status).toBe('down');
    expect(data.fleet.status).toBe('ok');
    expect(data.status).toBe('degraded');
  });

  test('Ollama failure retains the basic health semantics without claiming a healthy fleet', async () => {
    refreshOllamaHealth.mockResolvedValue({ status: 'error' });
    ecosystem.mockResolvedValue({ health: { status: 'degraded', configuredHosts: 1 },
      cluster: [{ hostKey: 'primary', status: 'offline', models: [] }] });
    const health = await request(app).get('/health').expect(200);
    expect(health.body.details).toEqual({ mongodb: 'connected', ollama: 'error' });
    const { data } = (await request(app).get('/api/panel/status').expect(200)).body;
    expect(data.services.find(service => service.id === 'core').status).toBe('ok');
    expect(data.fleet.status).toBe('degraded');
    expect(data.status).toBe('degraded');
  });

  test('a failed ecosystem collector does not hide successful service reads or private errors', async () => {
    ecosystem.mockRejectedValue(new Error('PRIVATE_COLLECTOR_ERROR'));
    const { data } = (await request(app).get('/api/panel/status').expect(200)).body;
    expect(data.services.every(service => service.status === 'ok')).toBe(true);
    expect(data.fleet).toMatchObject({ status: 'degraded', error: 'Ecosystem snapshot is unavailable.' });
    expect(data.status).toBe('degraded');
    expect(JSON.stringify(data)).not.toContain('PRIVATE_COLLECTOR_ERROR');
  });
});
