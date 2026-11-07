const {
  getLiveActivity, readActiveRequests, readPowerHistory, boundedMinutes, requestLabel, projectRequest
} = require('../../src/services/liveActivityService');

const NOW = Date.parse('2026-11-07T16:00:00Z');

function coordination(inferences) {
  return { findOne: () => ({ lean: async () => ({ _id: 'runtime', inferences }) }) };
}

const admissions = [
  { admissionId: 'secret-a', generation: 'secret-g', principal: 'core-trusted-runtime', caller: 'llm-gateway/eko',
    host: 'http://10.0.0.10:11434', model: 'main-model', kind: 'trusted-runtime-stream', state: 'ACTIVE',
    acquiredAt: new Date(NOW - 12000) },
  { admissionId: 'secret-b', generation: 'secret-h', principal: 'core-chat', caller: null,
    host: 'http://10.0.0.20:11434', model: 'small-model', kind: 'chat', state: 'ACTIVE', acquiredAt: new Date(NOW - 3000) },
  { admissionId: 'secret-c', generation: 'secret-i', principal: 'core-watchdog', host: 'http://10.0.0.10:11434',
    model: 'main-model', kind: 'watchdog-probe', state: 'ACTIVE', acquiredAt: new Date(NOW - 1000) },
  { admissionId: 'secret-d', generation: 'secret-j', principal: 'benchmark-service', host: 'http://10.0.0.10:11434',
    model: 'main-model', kind: 'trusted-runtime', workloadAdmissionId: 'w1', state: 'ACTIVE', acquiredAt: new Date(NOW - 5000) }
];

describe('liveActivityService', () => {
  test('bounds the window', () => {
    expect(boundedMinutes(undefined)).toBe(15);
    expect(boundedMinutes('2')).toBe(5);
    expect(boundedMinutes('999')).toBe(60);
    expect(boundedMinutes('30')).toBe(30);
  });

  test('labels a request by caller, then by Core principal', () => {
    expect(requestLabel({ caller: 'ops-watch', principal: 'core-inference' })).toBe('ops-watch');
    expect(requestLabel({ principal: 'core-chat' })).toBe('Chat');
    expect(requestLabel({ principal: 'someone-else' })).toBe('someone-else');
    expect(requestLabel({})).toBe('Unknown caller');
  });

  test('lists requests without admission proofs; heavy work counted, not listed', async () => {
    const result = await readActiveRequests({ now: NOW, model: coordination(admissions) });
    expect(result.active).toHaveLength(3);
    expect(result.heavyWorkInFlight).toBe(1);
    expect(result.heavyWorkHosts).toEqual(['http://10.0.0.10:11434']);
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/secret-/);
    expect(result.active[0]).toMatchObject({ label: 'llm-gateway/eko', stream: true, maintenance: false, ageMs: 12000 });
    expect(result.active.find(item => item.label === 'Watchdog probe').maintenance).toBe(true);
    expect(projectRequest({ principal: 'core-chat' }, NOW)).toMatchObject({ since: null, ageMs: null });
  });

  test('groups power samples per GPU, keeps missing readings as null', async () => {
    const calls = [];
    const fetchImpl = async (path, { query } = {}) => {
      calls.push({ path, query });
      if (path === '/api/v1/hardware/latest') {
        return { response: { ok: true }, body: { data: { hosts: [{ hostId: 'big' }, { hostId: 'small' }] } } };
      }
      if (query.includes('hostId=small')) return { response: { ok: false, status: 502 }, body: { message: 'down' } };
      return { response: { ok: true }, body: { data: { samples: [
        { index: 1, sampledAt: '2026-11-07T15:59:30Z', powerDrawW: 100, powerLimitW: 300 },
        { index: 0, sampledAt: '2026-11-07T15:59:30Z', powerDrawW: null, powerLimitW: 300 },
        { index: 0, sampledAt: '2026-11-07T15:59:00Z', powerDrawW: 210, powerLimitW: 300 }
      ] } } };
    };
    const power = await readPowerHistory({ minutes: 15, now: NOW, fetchImpl });
    expect(power.hosts.big.gpus[0]).toEqual([
      { t: '2026-11-07T15:59:00Z', w: 210, limit: 300 },
      { t: '2026-11-07T15:59:30Z', w: null, limit: 300 }
    ]);
    expect(power.hosts.big.gpus[1]).toHaveLength(1);
    expect(power.hosts.small).toEqual({ error: 'down' });
    expect(calls.find(c => c.query?.includes('hostId=big')).query).toContain(`from=${encodeURIComponent(new Date(NOW - 15 * 60000).toISOString())}`);
  });

  test('each part fails on its own', async () => {
    const logModel = { aggregate: async () => { throw new Error('logs down'); } };
    const fetchImpl = async () => { throw Object.assign(new Error('slow'), { name: 'TimeoutError' }); };
    const data = await getLiveActivity({ minutes: '15' }, { now: NOW, coordinationModel: coordination(admissions), logModel, fetchImpl });
    expect(data.requests.ok).toBe(true);
    expect(data.recent).toEqual({ ok: false, error: 'logs down' });
    expect(data.power).toEqual({ ok: false, error: 'timed out' });
  });

  test('summarizes recent requests per minute and per caller', async () => {
    const logModel = { aggregate: async (pipeline) => (pipeline[1].$group._id.$dateTrunc
      ? [{ _id: new Date('2026-11-07T15:58:00Z'), n: 4, failed: 1 }, { _id: new Date('2026-11-07T15:59:00Z'), n: 2, failed: 0 }]
      : [{ _id: 'a', n: 3 }, { _id: null, n: 1 }]) };
    const data = await getLiveActivity({}, { now: NOW, coordinationModel: coordination([]), logModel, fetchImpl: async () => ({ response: { ok: true }, body: { data: { hosts: [] } } }) });
    expect(data.recent.data).toMatchObject({ windowMinutes: 15, total: 6, moreCallers: false });
    expect(data.recent.data.perMinute[0]).toEqual({ t: '2026-11-07T15:58:00.000Z', n: 4, failed: 1 });
    expect(data.recent.data.byCaller).toEqual([{ label: 'a', n: 3 }, { label: 'Unknown caller', n: 1 }]);
  });
});
