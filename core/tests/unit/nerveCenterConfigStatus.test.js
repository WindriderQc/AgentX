'use strict';

jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const express = require('express');
const request = require('supertest');
const configRouter = require('../../routes/nerve-center-config');

function app() {
  const a = express();
  a.use('/api/nerve-center', configRouter);
  return a;
}

describe('GET /api/nerve-center/config-status', () => {
  const originalFetch = global.fetch;
  const saved = {};
  const setEnv = (name, value) => {
    if (!(name in saved)) saved[name] = process.env[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  };

  afterEach(() => {
    global.fetch = originalFetch;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
      delete saved[name];
    }
  });

  it('reports core from its environment and lists every service', async () => {
    setEnv('OPENCLAW_CONVERSATION_FALLBACK_TASK', 'nestor_answer_light');
    setEnv('OPENCLAW_GATEWAY_TOKEN', 'super-secret-token-value');
    setEnv('OPENCLAW_CONVERSATION_HOSTS', undefined);
    global.fetch = jest.fn(async () => ({ ok: false, status: 503 }));

    const res = await request(app()).get('/api/nerve-center/config-status').expect(200);
    const services = res.body.data.services;
    expect(services.map((s) => s.service)).toEqual(['core', 'benchmark', 'rag', 'data']);

    const core = Object.fromEntries(services[0].variables.map((v) => [v.name, v]));
    expect(core.OPENCLAW_CONVERSATION_FALLBACK_TASK).toMatchObject({ state: 'custom', value: 'nestor_answer_light' });
    expect(core.OPENCLAW_CONVERSATION_HOSTS.state).toBe('off');
    expect(core.OPENCLAW_GATEWAY_TOKEN).toMatchObject({ secret: true, set: true, value: null });
    expect(JSON.stringify(res.body)).not.toContain('super-secret-token-value');

    expect(services[1]).toMatchObject({ service: 'benchmark', reported: false });
    expect(services[2].variables.every((v) => v.state === 'unknown')).toBe(true);
  });

  it('uses Benchmark\'s own report when it answers', async () => {
    setEnv('BENCHMARK_SERVICE_URL', 'http://benchmark.test:3081/');
    const report = { schema: 'agentx.env-status/v1', service: 'benchmark', reported: true, summary: { total: 1 }, variables: [{ name: 'X', state: 'custom' }] };
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => report }));

    const res = await request(app()).get('/api/nerve-center/config-status').expect(200);
    expect(global.fetch).toHaveBeenCalledWith('http://benchmark.test:3081/api/config/status', expect.any(Object));
    expect(res.body.data.services[1]).toEqual(report);
  });
});
