'use strict';

const energy = require('../../src/services/energyCorrelationService');

describe('energy correlation', () => {
  test('uses the lower quartile as a conservative observed baseline', () => {
    expect(energy.percentile([210, 100, 120, 110, 300], .25)).toBe(110);
  });

  test('turns completion telemetry into an interval', () => {
    expect(energy.normalizeInference({ _id: 'a', timestamp: '2026-10-22T12:10:00Z', durationMs: 120000,
      caller: 'chat', model: 'qwen', hostKey: 'primary', status: 'success' })).toMatchObject({
      startAt: '2026-10-22T12:08:00.000Z', endAt: '2026-10-22T12:10:00.000Z', durationMs: 120000,
      kind: 'inference', host: 'primary'
    });
  });

  test('marks overlapping activities as low-confidence estimates', () => {
    const events = [
      { id: 'a', startAt: '2026-10-22T12:00:00Z', endAt: '2026-10-22T12:02:00Z', durationMs: 120000 },
      { id: 'b', startAt: '2026-10-22T12:01:00Z', endAt: '2026-10-22T12:03:00Z', durationMs: 120000 }
    ];
    const power = ['12:00','12:01','12:02','12:03'].map((time, index) => ({ at: `2026-10-22T${time}:00Z`, value: 200 + index }));
    const result = energy.attribute(events, power, 150, 60);
    expect(result[0].confidence).toBe('low');
    expect(result[0].estimatedWh).toBeGreaterThan(0);
  });

  test('composes measured energy separately from attributed energy', () => {
    const history = { bucket: 'minute', bucketSeconds: 60, measures: {
      power: { points: [{ ts: '2026-10-22T12:00:00Z', median: 150, min: 145, max: 160 }, { ts: '2026-10-22T12:01:00Z', median: 210, min: 200, max: 220 }] },
      current: { points: [] }, voltage: { points: [] },
      energy: { points: [{ ts: '2026-10-22T12:00:00Z', median: 2.1 }, { ts: '2026-10-22T12:01:00Z', median: 2.2 }] }
    } };
    const range = { window: '24h', from: new Date('2026-10-22T11:00:00Z'), to: new Date('2026-10-22T13:00:00Z') };
    const result = energy.compose({ history, live: { measures: {} }, range, deviceId: 'cluster-powerbar' });
    expect(result.contract).toBe('agentx.energy-observability/v1');
    expect(result.summary.energyKwh).toBeCloseTo(.1);
    expect(result.methodology.exactPerProcess).toBe(false);
  });
});
