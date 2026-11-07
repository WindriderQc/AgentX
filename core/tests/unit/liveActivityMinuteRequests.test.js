'use strict';

const InferenceLog = require('../../models/InferenceLog');
const { readMinuteRequests, minuteBounds } = require('../../src/services/liveActivityService');

// One minute of the Nerve Center requests chart: caller, machine, duration,
// status and a stable failure reason. Never the stored error text.
describe('live activity: requests of one minute', () => {
  const NOW = Date.now();
  const minute = Math.floor((NOW - 5 * 60_000) / 60_000) * 60_000;
  const at = offset => new Date(minute + offset);

  beforeEach(async () => {
    await InferenceLog.deleteMany({});
    await InferenceLog.create([
      { host: 'http://10.0.0.10:11434/api', model: 'm1', status: 'success', durationMs: 850,
        callerDetail: 'openclaw-runtime-bridge', timestamp: at(5_000) },
      { host: 'http://10.0.0.10:11434', model: 'm1', status: 'timeout', durationMs: 120_000,
        consumerContract: 'rag-service-v1', error: 'secret upstream body sk-123', timestamp: at(20_000) },
      { host: 'http://10.0.0.20:11434', model: 'm2', status: 'error', durationMs: 3,
        error: 'boom with private text', timestamp: at(40_000),
        routeDecision: { outcome: { reasonCode: 'workload_reserved' } } },
      // Outside the minute.
      { host: 'http://10.0.0.10:11434', model: 'm1', status: 'success', timestamp: at(61_000) },
    ]);
  });
  afterAll(async () => { await InferenceLog.deleteMany({}); });

  test('lists that minute only, with plain fields and no error text', async () => {
    const data = await readMinuteRequests({ at: at(30_000).toISOString(), now: NOW });
    expect(data.minute).toBe(new Date(minute).toISOString());
    expect(data.total).toBe(3);
    expect(data.truncated).toBe(false);
    expect(data.requests.map(r => [r.caller, r.host, r.status, r.reason])).toEqual([
      ['openclaw-runtime-bridge', 'http://10.0.0.10:11434', 'success', null],
      ['rag-service-v1', 'http://10.0.0.10:11434', 'timeout', 'upstream_timeout'],
      ['Unknown caller', 'http://10.0.0.20:11434', 'error', 'workload_reserved'],
    ]);
    expect(data.requests[0].durationMs).toBe(850);
    const text = JSON.stringify(data);
    expect(text).not.toContain('sk-123');
    expect(text).not.toContain('private text');
  });

  test('refuses times outside the last 24 hours', async () => {
    expect(minuteBounds('not a date', NOW)).toBeNull();
    expect(minuteBounds(new Date(NOW - 25 * 3600_000).toISOString(), NOW)).toBeNull();
    expect(minuteBounds(new Date(NOW + 10 * 60_000).toISOString(), NOW)).toBeNull();
    await expect(readMinuteRequests({ at: 'yesterday', now: NOW })).rejects.toMatchObject({ statusCode: 400 });
  });
});
