'use strict';

process.env.OLLAMA_HOST = 'http://192.168.50.99:11434';

jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const express = require('express');
const { startTestHttpHarness } = require('../helpers/testHttpServer');
const InferenceHost = require('../../models/InferenceHost');
const HostPreference = require('../../models/HostPreference');
const RouterTaskConfig = require('../../models/RouterTaskConfig');
const hostConfig = require('../../src/helpers/ollamaHostConfig');
const { HOSTS } = require('../../src/services/modelRouterDefaults');
const registry = require('../../src/services/inferenceHostRegistry');

const app = express();
app.use(express.json());
app.use('/api/nerve-center', require('../../routes/nerve-center-inference-hosts'));

describe('inference host registry API', () => {
  const originalFetch = global.fetch;
  let http;
  beforeAll(async () => { http = await startTestHttpHarness(app, { transport: process.platform === 'win32' ? 'pipe' : 'tcp' }); });
  afterAll(async () => { await http.close(); });
  beforeEach(async () => {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ version: '0.30.10' }) }));
    await Promise.all([InferenceHost.deleteMany({}), HostPreference.deleteMany({}), RouterTaskConfig.deleteMany({})]);
    await registry.load();
  });
  afterEach(async () => {
    global.fetch = originalFetch;
    await InferenceHost.deleteMany({});
    await registry.load();
  });

  it('registers a CPU instance beside the GPU instance of the same machine', async () => {
    const created = await http.request.post('/api/nerve-center/inference-hosts')
      .send({ id: 'frank-cpu', name: 'Frank CPU', url: 'http://192.168.50.99:11435', residency: 'cpu' });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      host: { id: 'frank-cpu', residency: 'cpu', maxInflight: 1 },
      reachability: { reachable: true, version: '0.30.10' }
    });
    expect(global.fetch).toHaveBeenCalledWith('http://192.168.50.99:11435/api/version', expect.any(Object));

    const listed = await http.request.get('/api/nerve-center/inference-hosts');
    const rows = listed.body.data.hosts.map(host => [host.id, host.residency, host.source]);
    expect(rows[0]).toEqual(['primary', 'gpu', 'env']);
    expect(rows[rows.length - 1]).toEqual(['frank-cpu', 'cpu', 'registry']);
    expect(hostConfig.validateHostUrl('http://192.168.50.99:11435').valid).toBe(true);
    expect(HOSTS['frank-cpu']).toBe('http://192.168.50.99:11435');
    expect(await HostPreference.findOne({ hostUrl: 'http://192.168.50.99:11435' }).lean())
      .toMatchObject({ hostKey: 'frank-cpu', displayName: 'Frank CPU', status: 'idle' });
  });

  it('still registers an unreachable host and says so', async () => {
    global.fetch = jest.fn(async () => { throw new Error('connect ECONNREFUSED'); });
    const created = await http.request.post('/api/nerve-center/inference-hosts')
      .send({ id: 'later', url: '192.168.50.12:11434' });
    expect(created.status).toBe(201);
    expect(created.body.data.reachability).toMatchObject({ reachable: false });
  });

  it.each([
    [{ id: 'web', url: 'http://8.8.8.8:11434' }, 'HOST_URL_NOT_LAN'],
    [{ id: 'web', url: 'https://ollama.example.com' }, 'HOST_URL_NOT_LAN'],
    [{ id: 'path', url: 'http://192.168.50.5:11434/api' }, 'HOST_URL_INVALID'],
    [{ id: 'Bad Id', url: 'http://192.168.50.5:11434' }, 'HOST_ID_INVALID'],
    [{ id: 'secondary', url: 'http://192.168.50.5:11434' }, 'HOST_ID_RESERVED'],
    [{ id: 'dup', url: 'http://192.168.50.99:11434' }, 'HOST_ALREADY_CONFIGURED'],
    [{ id: 'x', url: 'http://192.168.50.5:11434', residency: 'tpu' }, 'HOST_RESIDENCY_INVALID']
  ])('refuses %j', async (body, code) => {
    const response = await http.request.post('/api/nerve-center/inference-hosts').send(body);
    expect(response.body.code).toBe(code);
    expect(await InferenceHost.countDocuments()).toBe(0);
  });

  it('annotates an env host and edits a registered one', async () => {
    const env = await http.request.patch('/api/nerve-center/inference-hosts/primary').send({ name: 'Frank GPU' });
    expect(env.status).toBe(200);
    expect(hostConfig.getConfiguredHosts()[0]).toMatchObject({ id: 'primary', name: 'Frank GPU', source: 'env' });

    await registry.create({ id: 'alien-cpu', url: 'http://192.168.50.199:11435', residency: 'cpu' });
    const edited = await http.request.patch('/api/nerve-center/inference-hosts/alien-cpu').send({ maxInflight: 2 });
    expect(edited.body.data.host).toMatchObject({ residency: 'cpu', maxInflight: 2 });
    const moved = await http.request.patch('/api/nerve-center/inference-hosts/alien-cpu').send({ url: 'http://192.168.50.2:1' });
    expect(moved.body.code).toBe('HOST_URL_IMMUTABLE');
  });

  it('lists the CPU threads pinned per model, for Benchmark probes', async () => {
    await registry.create({ id: 'cpu-a', url: 'http://192.168.50.99:11435', residency: 'cpu' });
    await HostPreference.updateOne({ hostUrl: 'http://192.168.50.99:11435' },
      { $set: { pinnedModels: [{ model: 'example:26b', numThread: 6 }, { model: 'other:1b' }] } });
    const listed = await http.request.get('/api/nerve-center/inference-hosts');
    const byId = Object.fromEntries(listed.body.data.hosts.map(host => [host.id, host.pinThreads]));
    expect(byId['cpu-a']).toEqual({ 'example:26b': 6 });
    expect(byId.primary).toEqual({});
  });

  it('removes a host only with confirmation and once nothing depends on it', async () => {
    await registry.create({ id: 'frank-cpu', url: 'http://192.168.50.99:11435', residency: 'cpu' });
    const url = '/api/nerve-center/inference-hosts/frank-cpu';
    expect((await http.request.delete(url)).body.code).toBe('CONFIRMATION_REQUIRED');

    await HostPreference.updateOne({ hostUrl: 'http://192.168.50.99:11435' },
      { $set: { pinnedModels: [{ model: 'gemma4:26b-a4b-it-qat', numThread: 6 }] } });
    expect((await http.request.delete(url).set('X-AgentX-Confirm', 'REMOVE HOST frank-cpu')).body.code).toBe('HOST_HAS_PINS');
    await HostPreference.updateOne({ hostUrl: 'http://192.168.50.99:11435' }, { $set: { pinnedModels: [] } });

    await RouterTaskConfig.create({ taskType: 'janitor_ai', model: 'gemma4:26b-a4b-it-qat', host: 'frank-cpu' });
    expect((await http.request.delete(url).set('X-AgentX-Confirm', 'REMOVE HOST frank-cpu')).body.code).toBe('HOST_IN_ROUTING');
    await RouterTaskConfig.deleteMany({});

    const removed = await http.request.delete(url).set('X-AgentX-Confirm', 'REMOVE HOST frank-cpu');
    expect(removed.status).toBe(200);
    expect(hostConfig.validateHostUrl('http://192.168.50.99:11435').valid).toBe(false);
    expect(await HostPreference.countDocuments({ hostUrl: 'http://192.168.50.99:11435' })).toBe(0);
    expect(HOSTS['frank-cpu']).toBeUndefined();
  });
});
