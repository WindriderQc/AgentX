'use strict';

const hardware = require('../../services/hardwareTelemetryService');

describe('hardwareTelemetryService', () => {
  test('history TTL defaults to 7 days and is bounded', () => {
    expect(hardware.historyTtlSeconds({})).toBe(7 * 86400);
    expect(hardware.historyTtlSeconds({ DATA_HARDWARE_HISTORY_TTL_DAYS: '1.5' })).toBe(1.5 * 86400);
    expect(hardware.historyTtlSeconds({ DATA_HARDWARE_HISTORY_TTL_DAYS: '9999' })).toBe(90 * 86400);
    expect(hardware.historyTtlSeconds({ DATA_HARDWARE_HISTORY_TTL_DAYS: 'nope' })).toBe(7 * 86400);
  });

  test('staleness follows three collector intervals with a 90 s floor', () => {
    expect(hardware.staleAfterMs(30000)).toBe(90000);
    expect(hardware.staleAfterMs(60000)).toBe(180000);
    expect(hardware.staleAfterMs(undefined)).toBe(90000);
  });

  test('GPU rows keep unknown values null instead of inventing zeros', () => {
    const gpu = hardware.normalizeGpu({
      index: '1', name: 'GPU', utilizationPct: null, temperatureC: 'N/A', powerDrawW: '120.5',
      throttleReasons: ['sw_power_cap', 7, ''], extra: 'ignored'
    }, 0);
    expect(gpu).toMatchObject({ index: 1, name: 'GPU', utilizationPct: null, temperatureC: null, powerDrawW: 120.5 });
    expect(gpu.throttleReasons).toEqual(['sw_power_cap']);
    expect(gpu.extra).toBeUndefined();
  });

  test('a changed TTL setting is applied with collMod', async () => {
    const collection = {
      indexes: jest.fn().mockResolvedValue([{ name: hardware.TTL_INDEX_NAME, expireAfterSeconds: 7 * 86400 }]),
      createIndex: jest.fn()
    };
    const db = { collection: jest.fn(() => collection), command: jest.fn().mockResolvedValue({ ok: 1 }) };
    const result = await hardware.ensureHistoryTtl(db, { DATA_HARDWARE_HISTORY_TTL_DAYS: '3' });
    expect(result).toMatchObject({ expireAfterSeconds: 3 * 86400, updated: true });
    expect(db.command).toHaveBeenCalledWith({
      collMod: hardware.SAMPLES,
      index: { name: hardware.TTL_INDEX_NAME, expireAfterSeconds: 3 * 86400 }
    });
    expect(collection.createIndex).not.toHaveBeenCalled();
  });

  test('ingest rejects a collector without a stable identifier', async () => {
    await expect(hardware.ingestSamples({ collection: jest.fn() }, { collectorId: '' }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  test('ingest keeps the latest Ollama service observation with only allowlisted settings', async () => {
    const writes = [];
    const collections = {
      [hardware.COLLECTORS]: { updateOne: jest.fn().mockResolvedValue({}) },
      [hardware.HOSTS]: { bulkWrite: jest.fn(async ops => { writes.push(...ops); }) },
      [hardware.SAMPLES]: { insertMany: jest.fn().mockResolvedValue({}) }
    };
    const db = { collection: name => collections[name] };
    const observation = {
      source: 'systemd', unit: 'ollama.service', ok: true, observedAt: '2026-10-04T05:00:00.000Z',
      values: { OLLAMA_KV_CACHE_TYPE: 'q8_0', HF_TOKEN: 'synthetic-secret', OLLAMA_NUM_PARALLEL: '1 && reboot' },
      rejectedKeys: ['OLLAMA_NUM_PARALLEL', 'HF_TOKEN'], activeState: 'active', needDaemonReload: false, environmentFiles: true
    };
    await hardware.ingestSamples(db, {
      collectorId: 'gpu-agent',
      hosts: [{ id: 'gpu-a' }, { id: 'gpu-b' }, { id: 'gpu-c' }],
      results: [
        { hostId: 'gpu-a', ok: true, gpus: [], ollamaEnvironment: observation },
        { hostId: 'gpu-b', ok: false, error: 'ssh timed out', ollamaEnvironment: { source: 'systemd', ok: false, observedAt: '2026-10-04T05:00:00Z', error: 'Permission denied' } },
        { hostId: 'gpu-c', ok: true, gpus: [] }
      ]
    }, new Date('2026-10-04T05:00:01Z'));

    const set = hostId => writes.find(op => op.updateOne.filter.hostId === hostId).updateOne.update.$set;
    expect(set('gpu-a').ollamaEnvironment).toEqual({
      source: 'systemd', unit: 'ollama.service', observedAt: '2026-10-04T05:00:00.000Z', ok: true,
      values: { OLLAMA_KV_CACHE_TYPE: 'q8_0' }, rejectedKeys: ['OLLAMA_NUM_PARALLEL'],
      activeState: 'active', activeSince: null, needDaemonReload: false, environmentFiles: true
    });
    expect(set('gpu-b').ollamaEnvironment).toEqual({
      source: 'systemd', unit: null, observedAt: '2026-10-04T05:00:00.000Z', ok: false, error: 'Permission denied'
    });
    // A cycle without a fresh read leaves the stored observation untouched.
    expect(set('gpu-c')).not.toHaveProperty('ollamaEnvironment');
  });
});
