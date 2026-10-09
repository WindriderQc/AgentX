'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../src/services/dataServiceClient', () => ({ fetchData: jest.fn() }));

const { fetchData } = require('../../src/services/dataServiceClient');
const { getGpuOccupancy, joinOccupancy, readTopology } = require('../../src/services/gpuOccupancyService');

// Data's occupancy for two collector hosts (#365): a dual-GPU host behind one
// Ollama endpoint and a single-GPU host shared by Ollama and a voice runtime.
const gpu = (index, uuid, busId, extra = {}) => ({
  index, uuid, busId, name: 'Synthetic GPU', samples: 120, observedMs: 3_600_000, missingMs: 0, coverage: 1,
  busy: { ms: 1_800_000, share: 0.5 }, ...extra,
});
const occupancy = {
  from: '2026-10-01T00:00:00.000Z', to: '2026-10-01T01:00:00.000Z', windowMs: 3_600_000, busyAtPct: 10,
  hosts: [
    { hostId: 'dual', name: 'Dual', ollamaUrl: 'http://dual.lan:11434', intervalMs: 30_000,
      gpus: [gpu(0, 'GPU-aaaa', '00000000:01:00.0'), gpu(1, 'GPU-bbbb', '00000000:02:00.0')] },
    { hostId: 'single', name: 'Single', ollamaUrl: 'http://single.lan:11434', intervalMs: 30_000,
      gpus: [gpu(0, 'GPU-cccc', '00000000:03:00.0')] },
  ],
};
const topology = resources => readTopology(JSON.stringify(resources));
const configuredHosts = [
  { id: 'primary', url: 'http://dual.lan:11434' },
  { id: 'secondary', url: 'http://single.lan:11434/' },
];

describe('GPU occupancy join', () => {
  test('hosts match configured Ollama hosts; GPUs match resources by UUID, bus id or a single-GPU endpoint', () => {
    const joined = joinOccupancy(occupancy, {
      configuredHosts,
      topology: topology([
        { id: 'gpu-aaaa', endpoints: ['http://dual.lan:11434', 'http://dual.lan:7860'] },
        { id: '00000000:02:00.0', endpoints: ['http://dual.lan:11434'] },
        { id: 'frank-gpu', endpoints: ['http://single.lan:11434', 'http://single.lan:9000'] },
        { id: 'retired-gpu', endpoints: ['http://old.lan:11434'] },
      ]),
    });
    expect(joined).toMatchObject({ windowMs: 3_600_000, busyAtPct: 10, topology: 'configured', unlinkedResources: ['retired-gpu'] });
    const [dual, single] = joined.hosts;
    expect(dual).toMatchObject({ collectorHostId: 'dual', ollamaHostIds: ['primary'], intervalMs: 30_000 });
    expect(dual.gpus.map(item => [item.index, item.resource?.id, item.resource?.link])).toEqual([
      [0, 'gpu-aaaa', 'uuid'], [1, '00000000:02:00.0', 'bus_id'],
    ]);
    expect(dual.gpus[0].resource.endpoints).toEqual(['http://dual.lan:11434', 'http://dual.lan:7860']);
    expect(dual.gpus[0]).toMatchObject({ samples: 120, coverage: 1, busy: { share: 0.5 } });
    expect(single).toMatchObject({ ollamaHostIds: ['secondary'] });
    expect(single.gpus[0].resource).toMatchObject({ id: 'frank-gpu', link: 'single_gpu_host',
      endpoints: ['http://single.lan:11434', 'http://single.lan:9000'] });
  });

  test('an endpoint alone does not pick one GPU of several, nor one of two resources', () => {
    const joined = joinOccupancy(occupancy, {
      topology: topology([
        { id: 'pool-0', endpoints: ['http://dual.lan:11434'] },
        { id: 'one', endpoints: ['http://single.lan:11434'] },
        { id: 'two', endpoints: ['http://single.lan:11434'] },
      ]),
    });
    expect(joined.hosts.flatMap(host => host.gpus.map(item => item.resource))).toEqual([null, null, null]);
    expect(joined.unlinkedResources).toEqual(['one', 'pool-0', 'two']);
  });

  test('an unset or invalid map links nothing and says so', () => {
    expect(joinOccupancy(occupancy, { topology: readTopology('') })).toMatchObject({ topology: 'unset', unlinkedResources: [] });
    const invalid = joinOccupancy(occupancy, { topology: readTopology('{nope') });
    expect(invalid.topology).toBe('invalid');
    expect(invalid.hosts[0].gpus[0].resource).toBeNull();
  });
});

describe('GET /api/nerve-center/inference/gpu-occupancy', () => {
  const saved = process.env.AGENTX_RUNTIME_RESOURCES_JSON;
  let server;
  beforeAll((done) => {
    const app = express();
    app.use('/api/nerve-center', require('../../routes/nerve-center-gpu-occupancy'));
    server = app.listen(0, '127.0.0.1', done);
  });
  afterAll((done) => {
    if (saved === undefined) delete process.env.AGENTX_RUNTIME_RESOURCES_JSON;
    else process.env.AGENTX_RUNTIME_RESOURCES_JSON = saved;
    server.close(done);
  });
  beforeEach(() => {
    fetchData.mockReset();
    process.env.AGENTX_RUNTIME_RESOURCES_JSON = JSON.stringify([{ id: 'GPU-cccc', endpoints: ['http://single.lan:11434'] }]);
  });

  test('asks Data for the window and returns the joined occupancy', async () => {
    fetchData.mockResolvedValue({ response: { ok: true, status: 200 }, body: { ok: true, data: occupancy } });
    const res = await request(server).get('/api/nerve-center/inference/gpu-occupancy').query({ window: '7d', busyAtPct: 25 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ window: '7d', topology: 'configured', unlinkedResources: [] });
    expect(res.body.data.hosts[1].gpus[0].resource).toMatchObject({ id: 'GPU-cccc', link: 'uuid' });
    const [path, { query }] = fetchData.mock.calls[0];
    expect(path).toBe('/api/v1/hardware/occupancy');
    const params = new URLSearchParams(query);
    expect(Date.parse(params.get('to')) - Date.parse(params.get('from'))).toBe(7 * 24 * 3600_000);
    expect(params.get('busyAtPct')).toBe('25');
  });

  test('an unknown window reads 24 hours; Data refusals and failures are reported', async () => {
    fetchData.mockResolvedValueOnce({ response: { ok: false, status: 400 }, body: { status: 'error', message: 'busyAtPct must be in (0, 100]' } });
    let res = await request(server).get('/api/nerve-center/inference/gpu-occupancy').query({ window: 'forever', busyAtPct: 0 });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('busyAtPct must be in (0, 100]');
    const params = new URLSearchParams(fetchData.mock.calls[0][1].query);
    expect(Date.parse(params.get('to')) - Date.parse(params.get('from'))).toBe(24 * 3600_000);

    fetchData.mockRejectedValueOnce(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    res = await request(server).get('/api/nerve-center/inference/gpu-occupancy');
    expect(res.status).toBe(502);
    expect(res.body.message).toBe('Data request timed out');
  });
});

describe('getGpuOccupancy', () => {
  test('passes no threshold when none is asked', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ response: { ok: true, status: 200 }, body: { ok: true, data: { hosts: [] } } });
    await expect(getGpuOccupancy({}, { fetchImpl, now: Date.parse('2026-10-01T01:00:00Z') })).resolves.toMatchObject({
      ok: true, data: { window: '24h', hosts: [] },
    });
    expect(new URLSearchParams(fetchImpl.mock.calls[0][1].query).has('busyAtPct')).toBe(false);
  });
});
