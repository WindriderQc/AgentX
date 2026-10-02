'use strict';

jest.mock('../../src/services/gpuTelemetryService', () => ({ getGpuTelemetryForHosts: jest.fn() }));
const { getGpuTelemetryForHosts } = require('../../src/services/gpuTelemetryService');
const service = require('../../src/services/hostGpuHealthService');
const { verifyPinnedEntriesLoaded } = require('../../src/services/hostPinPrimitives');
const { resolveGpuRecovery } = require('../../src/services/alertIncidentRecovery');
const alerts = require('../../src/services/alertService');
const Alert = require('../../models/Alert');
const rule = require('../../config/default-alert-rules.json').find(item => item.id === 'pin-vram-spill');
const pref = { hostUrl: 'http://gpu-fixture:11434', pinnedModels: [{ model: 'chat', keepAlive: -1 },
  { model: 'embed', keepAlive: -1 }] };
const inventory = (vram = 100) => [{ name: 'chat', size: 100, size_vram: 100 },
  { name: 'embed', size: 100, size_vram: vram }];

beforeEach(async () => {
  await Alert.deleteMany({});
  alerts.loadRules([rule]);
  getGpuTelemetryForHosts.mockResolvedValue(new Map([[pref.hostUrl, { telemetry: { status: 'no_data' }, gpus: [] }]]));
});

test.each([[0, 'cpu'], [50, 'partial']])('a co-resident with %s VRAM bytes degrades the host', (vram, status) => {
  const health = service.assessHostGpuHealth(pref, inventory(vram), null);
  expect(health).toMatchObject({ status: 'degraded', reason: 'pinned_model_gpu_spill' });
  expect(health.entries[1]).toMatchObject({ model: 'embed', status, size: 100, sizeVram: vram });
});

test('missing, malformed and stale measurements are unknown rather than fabricated GPU failures', () => {
  const telemetry = { telemetry: { status: 'stale' }, gpus: [] };
  expect(service.assessHostGpuHealth(pref, [{ name: 'chat' }], telemetry).status).toBe('unknown');
  expect(service.assessHostGpuHealth(pref, [{ name: 'chat', size: null, size_vram: 0 }], telemetry).status).toBe('unknown');
  expect(service.assessHostGpuHealth(pref, [], telemetry).status).toBe('unknown');
  expect(service.assessHostGpuHealth(pref, inventory(), telemetry).status).toBe('healthy');
  expect(service.assessHostGpuHealth({ hostUrl: pref.hostUrl }, [], telemetry).status).toBe('not_applicable');
});

test('fresh empty GPU inventory is distinguished from a stale collector', () => {
  expect(service.assessHostGpuHealth(pref, [], { telemetry: { status: 'fresh' }, gpus: [] }))
    .toMatchObject({ status: 'degraded', reason: 'fresh_gpu_inventory_empty' });
});

test('an active runtime owner prevents pin-health claims and does not fetch or restore', async () => {
  await expect(service.readHostGpuHealth(pref.hostUrl, { pref: { ...pref, status: 'restoring' } }))
    .resolves.toMatchObject({ status: 'unknown', reason: 'runtime_owner_active' });
  expect(getGpuTelemetryForHosts).not.toHaveBeenCalled();
});

test('one continuous incident survives stale telemetry and resolves only on full co-resident GPU evidence', async () => {
  await Alert.syncIndexes();
  getGpuTelemetryForHosts.mockResolvedValue(new Map([[pref.hostUrl, { telemetry: { status: 'fresh' }, gpus: [] }]]));
  await service.observeHostGpuHealth(pref, []);
  await service.observeHostGpuHealth(pref, []);
  expect(await Alert.countDocuments({ ruleId: rule.id, status: 'active' })).toBe(1);
  getGpuTelemetryForHosts.mockResolvedValue(new Map([[pref.hostUrl, { telemetry: { status: 'stale' }, gpus: [] }]]));
  await service.observeHostGpuHealth(pref, [{ name: 'chat' }]);
  await Alert.updateMany({}, { $set: { lastOccurrence: new Date(Date.now() - 3600000) } });
  await alerts.resolveStaleAlerts();
  expect(await Alert.countDocuments({ ruleId: rule.id, status: 'active' })).toBe(1);
  await service.observeHostGpuHealth(pref, inventory());
  const incident = await Alert.findOne({ ruleId: rule.id }).lean();
  expect(incident).toMatchObject({ status: 'resolved', occurrenceCount: 2,
    resolution: { resolutionMethod: 'gpu-recovery-verified' },
    metadata: { gpuRecovery: { status: 'healthy' } } });
});

test('old healthy evidence cannot resolve a newer degraded incident', async () => {
  const old = service.assessHostGpuHealth(pref, inventory(), null, new Date(Date.now() - 1000).toISOString());
  getGpuTelemetryForHosts.mockResolvedValue(new Map([[pref.hostUrl, { telemetry: { status: 'fresh' }, gpus: [] }]]));
  await service.observeHostGpuHealth(pref, []);
  expect(await resolveGpuRecovery(old)).toBe(0);
  expect(await Alert.countDocuments({ status: 'active' })).toBe(1);
});

test('a pin spill uses the reconciler incident without emitting a duplicate host incident', async () => {
  expect(await service.observeHostGpuHealth(pref, inventory(0)))
    .toMatchObject({ status: 'degraded', reason: 'pinned_model_gpu_spill' });
  expect(await Alert.countDocuments({})).toBe(0);
});

test('empty GPU inventory followed by an observed CPU pin remains one host incident', async () => {
  await Alert.syncIndexes();
  getGpuTelemetryForHosts.mockResolvedValue(new Map([[pref.hostUrl, { telemetry: { status: 'fresh' }, gpus: [] }]]));
  await service.observeHostGpuHealth(pref, []);
  await require('../../src/services/laneObservabilityService').observePinVramSpill({
    host: pref.hostUrl, spills: [{ model: 'chat', size: 100, sizeVram: 0 }], source: 'pin-reconciler'
  });
  const records = await Alert.find({ status: 'active' }).lean();
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ ruleId: rule.id, occurrenceCount: 2 });
});

test('pin restore verification rejects an observed CPU spill without scheduling another warm', async () => {
  const original = global.fetch;
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ models: inventory(50) }) }));
  try {
    expect(await verifyPinnedEntriesLoaded(pref.hostUrl, pref.pinnedModels, 0))
      .toMatchObject({ verified: false, gpuVerified: false });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toMatch(/\/api\/ps$/);
  } finally { global.fetch = original; }
});

test('legacy inventory can verify loading without claiming GPU verification', async () => {
  const original = global.fetch;
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ models: [{ name: 'chat' }, { name: 'embed' }] }) }));
  try {
    expect(await verifyPinnedEntriesLoaded(pref.hostUrl, pref.pinnedModels, 0))
      .toMatchObject({ verified: true, gpuVerified: false });
  } finally { global.fetch = original; }
});
