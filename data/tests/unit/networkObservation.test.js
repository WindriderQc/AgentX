const {
  DEFAULT_ONLINE_TTL_MS, DEFAULT_RECENT_TTL_MS, classifyDevice, classifyDevices, observationRules
} = require('../../services/networkObservation');

const NOW = new Date('2026-09-05T12:00:00Z');
const ago = (ms) => new Date(NOW.getTime() - ms);

describe('network observation semantics', () => {
  test('rules come from explicit configuration with documented defaults', () => {
    expect(observationRules({})).toMatchObject({ onlineTtlMs: 30 * 60 * 1000, recentTtlMs: 24 * 60 * 60 * 1000 });
    expect(observationRules({}).source).toEqual({ onlineTtl: 'default: 2 × collector sweep (15m)', recentTtl: 'default: 24h' });
    expect(observationRules({ NETWORK_ONLINE_TTL_MS: '60000', NETWORK_RECENT_TTL_MS: '120000' }))
      .toMatchObject({ onlineTtlMs: 60000, recentTtlMs: 120000 });
    // The recent window can never be shorter than the online window.
    expect(observationRules({ NETWORK_ONLINE_TTL_MS: '600000', NETWORK_RECENT_TTL_MS: '1000' }).recentTtlMs).toBe(600000);
    expect(observationRules({ NETWORK_ONLINE_TTL_MS: 'nope' }).onlineTtlMs).toBe(DEFAULT_ONLINE_TTL_MS);
  });

  test('a device seen weeks ago is historical even if its raw flag still says online', () => {
    const stale = classifyDevice({ status: 'online', lastSeen: ago(21 * 24 * 60 * 60 * 1000), scanSource: 'retired-node' }, { now: NOW });
    expect(stale).toMatchObject({ state: 'historical', reportedStatus: 'online', source: 'retired-node' });
    expect(stale.ageMs).toBe(21 * 24 * 60 * 60 * 1000);
  });

  test('online requires a recent sighting by a reporting collector; recent and never-confirmed are distinct', () => {
    expect(classifyDevice({ status: 'online', lastSeen: ago(60000) }, { now: NOW }).state).toBe('online');
    expect(classifyDevice({ status: 'offline', lastSeen: ago(60000) }, { now: NOW }).state).toBe('recent');
    expect(classifyDevice({ status: 'online', lastSeen: ago(DEFAULT_ONLINE_TTL_MS + 1) }, { now: NOW }).state).toBe('recent');
    expect(classifyDevice({ status: 'online', lastSeen: ago(DEFAULT_RECENT_TTL_MS + 1) }, { now: NOW }).state).toBe('historical');
    expect(classifyDevice({ status: 'online' }, { now: NOW })).toMatchObject({ state: 'never_confirmed', lastSeenAt: null, ageMs: null });
  });

  test('the summary states the reference time, the windows and counts that add up to the list', () => {
    const { devices, summary } = classifyDevices([
      { ip: '1', status: 'online', lastSeen: ago(1000) },
      { ip: '2', status: 'online', lastSeen: ago(2 * 60 * 60 * 1000) },
      { ip: '3', status: 'online', lastSeen: ago(40 * 24 * 60 * 60 * 1000) },
      { ip: '4', status: 'offline' },
    ], { now: NOW });
    expect(summary).toMatchObject({
      referenceTime: NOW.toISOString(), onlineTtlMs: DEFAULT_ONLINE_TTL_MS, recentTtlMs: DEFAULT_RECENT_TTL_MS,
      total: 4, online: 1, recent: 1, historical: 1, never_confirmed: 1, reportedOnline: 3,
    });
    expect(devices.map((d) => d.observation.state)).toEqual(['online', 'recent', 'historical', 'never_confirmed']);
    expect(summary.online + summary.recent + summary.historical + summary.never_confirmed).toBe(summary.total);
  });
});
