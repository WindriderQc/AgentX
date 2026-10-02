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
});
