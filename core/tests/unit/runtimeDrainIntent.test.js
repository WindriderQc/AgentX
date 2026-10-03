const drain = require('../../src/services/runtimeDrainIntent');

describe('runtime drain request (#253)', () => {
  afterEach(() => drain.clear());

  test('is held for a bounded time, replaced by a newer one and withdrawn on demand', () => {
    const now = new Date('2026-10-03T07:00:00Z');
    expect(drain.current(now)).toBeNull();
    expect(drain.request({ scope: 'core-recreate', ttlMs: 150000, principal: 'operator' }, now)).toEqual({
      scope: 'core-recreate', principal: 'operator', requestedAt: '2026-10-03T07:00:00.000Z', expiresAt: '2026-10-03T07:02:30.000Z' });
    expect(drain.current(new Date('2026-10-03T07:02:29Z')).scope).toBe('core-recreate');
    expect(drain.current(new Date('2026-10-03T07:02:30Z'))).toBeNull();
    drain.request({ scope: 'runtime-deploy', ttlMs: 1 }, now);
    expect(drain.current(now).expiresAt).toBe('2026-10-03T07:00:30.000Z');
    drain.request({ scope: 'runtime-deploy', ttlMs: 9e9 }, now);
    expect(drain.current(now).expiresAt).toBe('2026-10-03T07:10:00.000Z');
    expect(drain.clear()).toEqual({ cleared: true });
    expect(drain.clear()).toEqual({ cleared: false });
  });

  test('refuses a request without a scope', () => {
    expect(() => drain.request({ scope: '../etc' })).toThrow('A drain request names its scope');
    expect(drain.current()).toBeNull();
  });
});
