'use strict';

const express = require('express');
const request = require('supertest');
const mockHosts = [
  { id: 'lane-a', name: 'Lane A', url: 'http://synthetic-gpu:11437', vramMb: 100 },
  { id: 'lane-b', name: 'Lane B', url: 'http://synthetic-gpu:11438', vramMb: 100 },
  { id: 'pool', name: 'Pool', url: 'http://synthetic-gpu:11434', vramMb: 200 }
];
jest.mock('../../src/helpers/ollamaHostConfig', () => ({
  ...jest.requireActual('../../src/helpers/ollamaHostConfig'),
  getConfiguredHosts: () => mockHosts,
  validateHostUrl: host => ({ valid: mockHosts.some(entry => entry.url === host), host })
}));
jest.mock('../../src/services/modelAggregator', () => ({}));
jest.mock('../../src/services/runtimeTopologyParking', () => {
  const actual = jest.requireActual('../../src/services/runtimeTopologyParking');
  return { ...actual, defaultParking: actual.createParking() };
});

const HostPreference = require('../../models/HostPreference');
const { defaultParking } = require('../../src/services/runtimeTopologyParking');
const { describeTopology } = require('../../src/services/runtimeTopologyService');
const app = express();
app.use('/api/models', require('../../routes/models-unified'));
const originalFetch = global.fetch;
const inventory = models => ({ ok: true, json: async () => ({ models }) });
const topology = JSON.stringify({ groups: [{ id: 'synthetic', modes: [
  { id: 'lanes', endpoints: [
    { url: mockHosts[0].url, role: 'conversation' }, { url: mockHosts[1].url, role: 'background' }
  ] },
  { id: 'pool', endpoints: [{ url: mockHosts[2].url, role: 'pooled' }] }
] }] });

beforeEach(async () => {
  await HostPreference.deleteMany({});
  defaultParking.endSwitch('synthetic');
  defaultParking._setDescription(null);
  global.fetch = jest.fn(async () => inventory([]));
});
afterAll(() => { global.fetch = originalFetch; defaultParking._setDescription(null); });

async function record(index = 0, extra = {}) {
  return HostPreference.create({ hostKey: mockHosts[index].id, hostUrl: mockHosts[index].url,
    status: 'ready', loadedModel: 'saved-resident', loadedModels: ['saved-resident'],
    pinnedModels: [{ model: 'desired-resident', contextSize: 1024, keepAlive: -1 }], ...extra });
}
async function read() {
  return (await request(app).get('/api/models/cluster-summary').expect(200)).body;
}

test('inactive topology lanes never expose saved ready/resident state as current', async () => {
  await Promise.all(mockHosts.map((_, index) => record(index)));
  global.fetch.mockImplementation(async url => {
    if (url === `${mockHosts[2].url}/api/ps`) return inventory([{ name: 'desired-resident' }]);
    throw new Error('Unreachable inactive lane');
  });
  // Use the same topology observer as Nerve Center, and the existing parking authority.
  defaultParking._setDescription(await describeTopology({ raw: topology }));
  global.fetch.mockClear();
  const body = await read();
  for (const host of body.hosts.filter(row => row.hostKey.startsWith('lane-'))) {
    expect(host).toMatchObject({ online: false, status: 'inactive', loadedModel: null, loadedModels: [],
      pinnedModels: [{ model: 'desired-resident', contextSize: 1024, keepAlive: -1 }],
      topology: { reason: 'inactive_topology_mode', intendedMode: 'pool' },
      observation: { source: 'runtime_topology_parking', status: 'not_applicable', observedAt: null },
      persistedState: { status: 'ready', loadedModels: ['saved-resident'], freshness: 'unverified', observedAt: null }
    });
  }
  expect(body.hosts.find(row => row.hostKey === 'pool')).toMatchObject({ online: true, status: 'ready',
    loadedModels: ['desired-resident'], observation: { status: 'fresh', source: 'ollama_api_ps' } });
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect((await HostPreference.findOne({ hostKey: 'lane-a' }).lean()).loadedModels).toEqual(['saved-resident']);
  expect(body.totalPinned).toBe(3);
});

test('fresh residency replaces even an old offline record, without overwriting it', async () => {
  await record(0, { status: 'offline' });
  const old = new Date('2000-01-01T00:00:00.000Z');
  await HostPreference.updateOne({ hostKey: 'lane-a' }, { $set: { updatedAt: old } }, { timestamps: false });
  global.fetch.mockResolvedValue(inventory([{ name: 'current-resident' }, { model: 'current-embedding' }]));
  const before = Date.now();
  const body = await read();
  expect(body.hosts[0]).toMatchObject({ online: true, status: 'ready', loadedModel: 'current-resident',
    loadedModels: ['current-resident', 'current-embedding'],
    persistedState: { status: 'offline', recordUpdatedAt: old.toISOString(), observedAt: null }
  });
  expect(Date.parse(body.hosts[0].observation.observedAt)).toBeGreaterThanOrEqual(before);
  expect((await HostPreference.findOne({ hostKey: 'lane-a' }).lean()).status).toBe('offline');
});

test('an empty successful inventory is online and idle, with no saved residents', async () => {
  await record();
  expect((await read()).hosts[0]).toMatchObject({ online: true, status: 'idle', loadedModel: null,
    loadedModels: [], observation: { status: 'fresh' }, persistedState: { loadedModel: 'saved-resident' } });
});

test.each(['network', 'timeout', 'http', 'malformed', 'malformed_entry'])('%s failure stays unknown despite a saved ready record', async kind => {
  await record();
  global.fetch.mockImplementation(async () => {
    if (kind === 'network' || kind === 'timeout') throw new Error(kind);
    if (kind === 'http') return { ok: false, status: 503 };
    if (kind === 'malformed_entry') return inventory([null]);
    return { ok: true, json: async () => ({ models: null }) };
  });
  expect((await read()).hosts[0]).toMatchObject({ online: false, status: 'unknown', loadedModel: null,
    loadedModels: [], observation: { status: 'unavailable', observedAt: null, reason: 'runtime_unavailable' } });
});

test('a missing record and failed observation cannot default to online', async () => {
  global.fetch.mockRejectedValue(new Error('No observation'));
  expect((await read()).hosts[0]).toMatchObject({ online: false, status: 'unknown', loadedModels: [],
    pinnedModels: [], persistedState: { status: null, recordUpdatedAt: null } });
});

test('a later failure never reuses the prior successful observation', async () => {
  await record();
  global.fetch.mockResolvedValue(inventory([{ name: 'short-lived-resident' }]));
  expect((await read()).hosts[0].loadedModels).toEqual(['short-lived-resident']);
  global.fetch.mockRejectedValue(new Error('Observation no longer available'));
  expect((await read()).hosts[0]).toMatchObject({ loadedModels: [], status: 'unknown',
    observation: { status: 'unavailable', observedAt: null } });
});

test('a switch starting during a probe supersedes the in-flight observation', async () => {
  defaultParking._setDescription({ configured: true, valid: true, groups: [{ id: 'synthetic',
    activeMode: 'lanes', modes: [{ id: 'lanes', endpoints: [{ url: mockHosts[0].url }] }] }] });
  global.fetch.mockImplementation(async () => {
    defaultParking.beginSwitch('synthetic', { id: 'switch-1', targetMode: 'pool' });
    return inventory([{ name: 'previous-mode-resident' }]);
  });
  expect((await read()).hosts[0]).toMatchObject({ online: false, status: 'inactive', loadedModels: [],
    topology: { reason: 'topology_switch_in_progress' } });
});

test('declared tags/reservations have unknown provenance dates, including zero defaults', async () => {
  await record(0, { tags: ['synthetic-service'], vramReservedMiB: 64 });
  const body = await read();
  expect(body.hosts[0]).toMatchObject({ vramReservedMiB: 64, declaredMetadata: {
    kind: 'operator_notes', source: 'host_preferences', freshness: 'unverified',
    tags: ['synthetic-service'], vramReservedMiB: 64,
    declaredBy: null, declaredAt: null, recordUpdatedAt: expect.any(String)
  } });
  expect(body.hosts[1].declaredMetadata).toMatchObject({ vramReservedMiB: 0, tags: [],
    freshness: 'unverified', declaredAt: null, recordUpdatedAt: null });
});

test('unconfigured records stay separate and never trigger runtime probes', async () => {
  await HostPreference.create({ hostKey: 'retired', hostUrl: 'http://synthetic-retired:11434',
    status: 'ready', loadedModel: 'old-resident', pinnedModels: [{ model: 'old-pin' }] });
  const body = await read();
  expect(body.hosts).toHaveLength(3);
  expect(body.stalePreferences).toEqual([expect.objectContaining({ hostKey: 'retired', stale: true,
    pinnedCount: 1, persistedState: { source: 'host_preferences', freshness: 'unverified', observedAt: null,
      recordUpdatedAt: expect.any(String), status: 'ready', loadedModel: 'old-resident', loadedModels: ['old-resident'] }
  })]);
  expect(global.fetch.mock.calls.every(([url]) => !url.includes('synthetic-retired'))).toBe(true);
});
