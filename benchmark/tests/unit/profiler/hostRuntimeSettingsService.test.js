'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { SYNC_INTERVAL_MS, syncHostRuntimeSettings, _resetForTests } = require('../../../src/services/profiler/hostRuntimeSettingsService');

const HOST = { hostId: 'ugalien', hostUrl: 'http://ugalien:11434' };
const environment = (values, extra = {}) => ({
  source: 'systemd', ok: true, observedAt: '2026-10-05T10:00:00.000Z', values, ...extra
});

function store(settings = null, exists = true, gpus = undefined) {
  const model = {
    findOne: jest.fn(() => ({ select: () => ({ lean: async () => (exists ? { ollama: { settings }, gpus } : null) }) })),
    updateOne: jest.fn(async () => ({ modifiedCount: 1 })),
  };
  return model;
}

describe('host Ollama settings sync', () => {
  beforeEach(() => _resetForTests());

  test('records observed settings on a host profile and reports a change', async () => {
    const model = store({ kvCacheType: 'default', flashAttention: 'on', visibleDevices: 'default', schedSpread: 'on', gpuCount: 2 });
    const readHardware = jest.fn(async () => ({
      ollamaEnvironment: environment({ OLLAMA_KV_CACHE_TYPE: 'q8_0', OLLAMA_FLASH_ATTENTION: '1', OLLAMA_SCHED_SPREAD: '1' }),
      knownGpuCount: 2
    }));
    await expect(syncHostRuntimeSettings(HOST, { readHardware, model })).resolves.toMatchObject({
      synced: true, changed: true, settings: { kvCacheType: 'q8_0', gpuCount: 2 }
    });
    expect(readHardware).toHaveBeenCalledWith(HOST.hostUrl);
    expect(model.updateOne).toHaveBeenCalledWith({ hostId: 'ugalien' }, { $set: {
      'ollama.settings': { kvCacheType: 'q8_0', flashAttention: 'on', visibleDevices: 'default', schedSpread: 'on', gpuCount: 2 },
      'ollama.settingsObservedAt': new Date('2026-10-05T10:00:00.000Z'),
      'ollama.settingsSource': 'systemd'
    } });
  });

  test('leaves stored settings alone when nothing changed, nothing was observed, or a reload is pending', async () => {
    const stored = { kvCacheType: 'q8_0', flashAttention: 'on', visibleDevices: 'default', schedSpread: 'default', gpuCount: 2 };
    const same = { ollamaEnvironment: environment({ OLLAMA_KV_CACHE_TYPE: 'q8_0', OLLAMA_FLASH_ATTENTION: 'true' }), knownGpuCount: null };
    for (const [hardware, reason] of [
      [same, 'unchanged'],
      [{ ollamaEnvironment: { ok: false, error: 'unit missing' } }, 'not_observed'],
      [null, 'not_observed'],
      [{ ollamaEnvironment: environment({ OLLAMA_KV_CACHE_TYPE: 'f16' }, { needDaemonReload: true }) }, 'daemon_reload_pending'],
    ]) {
      const model = store(stored);
      await expect(syncHostRuntimeSettings(HOST, { readHardware: async () => hardware, model, force: true }))
        .resolves.toMatchObject({ synced: false, reason });
      expect(model.updateOne).not.toHaveBeenCalled();
    }
  });

  test('never creates a host profile and reads the collector at most once per interval', async () => {
    const readHardware = jest.fn(async () => ({ ollamaEnvironment: environment({}), knownGpuCount: 1 }));
    let clock = 1_000_000;
    const now = () => clock;
    await expect(syncHostRuntimeSettings(HOST, { readHardware, model: store(null, false), now }))
      .resolves.toMatchObject({ synced: false, reason: 'no_host_profile' });
    await expect(syncHostRuntimeSettings(HOST, { readHardware, model: store(), now }))
      .resolves.toMatchObject({ synced: false, reason: 'recent' });
    clock += SYNC_INTERVAL_MS;
    await expect(syncHostRuntimeSettings(HOST, { readHardware, model: store(), now })).resolves.toMatchObject({ synced: true, changed: false });
    expect(readHardware).toHaveBeenCalledTimes(2);
  });

  test('records every GPU from a fresh inventory even when service settings are unavailable', async () => {
    const model = store();
    const gpus = [
      { index: 0, uuid: 'GPU-A', name: 'Synthetic GPU A', memoryTotalMiB: 24576 },
      { index: 1, uuid: 'GPU-B', name: 'Synthetic GPU B', memoryTotalMiB: 24576 }
    ];
    const hardware = { status: 'observed', source: 'agentx-data', sampledAt: '2026-10-06T00:00:00.000Z', gpus };
    await expect(syncHostRuntimeSettings(HOST, { model, readHardware: async () => hardware }))
      .resolves.toMatchObject({ synced: true });
    const update = model.updateOne.mock.calls[0][1].$set;
    expect(update.gpus).toHaveLength(2);
    expect(update.gpus[1]).toMatchObject({ uuid: 'GPU-B', model: 'Synthetic GPU B', vramTotalMiB: 24576 });
    expect(update.gpusObservedAt).toEqual(new Date(hardware.sampledAt));
    expect(update['ollama.settings']).toBeUndefined();
  });

  test('a stale, failed or absent inventory never erases the last observed GPUs', async () => {
    const gpus = [{ index: 0, uuid: 'GPU-A', model: 'Synthetic GPU', vramTotalMiB: 24576 }];
    for (const status of ['stale', 'unavailable', 'no_data']) {
      const model = store(null, true, gpus);
      await expect(syncHostRuntimeSettings(HOST, { model, force: true, readHardware: async () => ({ status, gpus: [] }) }))
        .resolves.toMatchObject({ synced: false });
      expect(model.updateOne).not.toHaveBeenCalled();
    }
  });

  test('HostProfile retains two distinct GPUs without changing legacy aggregate fields', () => {
    const HostProfile = require('../../../models/HostProfile');
    const profile = new HostProfile({ ...HOST, gpu: { model: 'Synthetic GPU', vramTotalMiB: 49152 }, gpus: [
      { index: 0, uuid: 'GPU-A', model: 'Synthetic GPU', vramTotalMiB: 24576 },
      { index: 1, uuid: 'GPU-B', model: 'Synthetic GPU', vramTotalMiB: 24576 }
    ] }).toObject();
    expect(profile.gpus.map(gpu => gpu.uuid)).toEqual(['GPU-A', 'GPU-B']);
    expect(profile.gpu.vramTotalMiB).toBe(49152);
    expect(profile.gpus.every(gpu => gpu._id === undefined)).toBe(true);
  });
});
