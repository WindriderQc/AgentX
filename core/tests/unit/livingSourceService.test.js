'use strict';
const { forAudience } = require('../../src/services/livingSourceService');
const now = () => new Date('2026-11-10T12:00:00Z');
const weather = { fetchedAt: '2026-11-10T11:55:00Z', temperatureC: 0, condition: 'Cloudy' };
const ambient = { weather: jest.fn(async () => weather) };

test('same registry, owner-only records never discoverable or read by household', async () => {
  const brief = jest.fn();
  const family = forAudience('household', { brief });
  expect(family.catalogue().sources.map(row => row.source)).toEqual(['weather', 'agentx']);
  expect(forAudience('owner').catalogue().sources.map(row => row.source)).toEqual(['weather', 'agentx', 'secretary', 'comptable']);
  for (const source of ['secretary', 'comptable', 'constructor', '__proto__', '/etc/passwd']) {
    await expect(family.read({ source })).rejects.toMatchObject({ code: 'SOURCE_NOT_AVAILABLE' });
  }
  expect(brief).not.toHaveBeenCalled();
  expect(() => forAudience('child-selected-owner')).toThrow();
  await expect(family.read({ source: 'weather', audience: 'owner' })).rejects.toMatchObject({ code: 'SOURCE_ARGUMENT_INVALID' });
});

test('weather has matching content across audiences, native timestamp and no private fields', async () => {
  const injected = { weather: async () => ({ ...weather, lat: 40, secret: 'not permitted', temperatureC: 0 }) };
  const owner = await forAudience('owner', { ambient: injected, now }).read({ source: 'weather' });
  const family = await forAudience('household', { ambient: injected, now }).read({ source: 'weather' });
  expect(owner.data).toEqual(family.data);
  expect(family).toMatchObject({ status: 'available', sourceUpdatedAt: '2026-11-10T11:55:00.000Z', complete: true });
  expect(JSON.stringify(family)).not.toContain('not permitted');
  expect(family.data).not.toHaveProperty('lat');
  expect(family.data.temperatureC).toBe(0);
});

test.each([
  ['2026-11-10T10:00:00Z', 'stale'],
  ['2026-11-10T12:10:00Z', 'unavailable'],
  [null, 'unavailable']
])('weather freshness %s remains %s', async (fetchedAt, status) => {
  const result = await forAudience('household', { ambient: { weather: async () => ({ ...weather, fetchedAt }) }, now }).read({ source: 'weather' });
  expect(result.status).toBe(status);
});

test('a failed read does not leak secrets or pretend cached success', async () => {
  const result = await forAudience('owner', { ambient: { weather: async () => { throw Error('secret-password'); } }, now }).read({ source: 'weather' });
  expect(result).toMatchObject({ status: 'unavailable', data: null, lastSuccessfulReadAt: null, error: 'SOURCE_READ_UNAVAILABLE' });
  expect(JSON.stringify(result)).not.toContain('secret-password');
});

test('AgentX source projects only named service reachability, never raw reports', async () => {
  const reportsClient = { fetchBenchmarkAnalyticsSummary: async () => ({ secret: 'private records' }), fetchRagStatus: async () => null };
  const result = await forAudience('household', { reportsClient, now }).read({ source: 'agentx' });
  expect(result.status).toBe('partial');
  expect(result.data.services).toEqual({ core: 'reachable', benchmark: 'reachable', rag: 'unavailable' });
  expect(JSON.stringify(result)).not.toContain('private records');
});

test('large producer content has lossless continuation and revision checks', async () => {
  const snapshot = { asOf: now().toISOString(), since: '2026-11-08T12:00:00.000Z', sections: { mail: { text: 'é😀'.repeat(1000), pagination: { hasMore: true, nextOffset: 20 } } } };
  const brief = jest.fn(async () => snapshot);
  const service = forAudience('owner', { brief, now });
  const first = await service.read({ source: 'secretary', section: 'mail', pageChars: 257 });
  expect(first.complete).toBe(false);
  expect(first.nextOffset).toBeGreaterThan(0);
  let text = first.text, page = first;
  while (page.nextOffset !== null) {
    page = await service.read({ ...page.nextReadArgs, offset: page.nextOffset, expectedHash: first.contentHash });
    text += page.text;
  }
  expect(JSON.parse(text).sections).toEqual(snapshot.sections);
  expect(first.nextReadArgs.asOf).toBe(snapshot.asOf);
  await expect(service.read({ source: 'secretary', offset: 257 })).rejects.toMatchObject({ code: 'SOURCE_ARGUMENT_INVALID' });
  snapshot.sections.mail.text += ' changed';
  await expect(service.read({ ...first.nextReadArgs, offset: first.nextOffset, expectedHash: first.contentHash })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
});

test('producer record pagination is separate from transport pagination', async () => {
  const brief = jest.fn(async input => ({ asOf: input.asOf, sections: {} }));
  await forAudience('owner', { brief, now }).read({ source: 'comptable', section: 'pendingAlerts', recordOffset: 100, limit: 50, asOf: now().toISOString() });
  expect(brief).toHaveBeenCalledWith({ member: 'comptable', section: 'pendingAlerts', offset: 100, limit: 50, asOf: now().toISOString() });
});

test('invalid bounds and unsupported arguments refuse without source I/O', async () => {
  const read = jest.fn();
  const service = forAudience('household', { ambient: { weather: read }, now });
  for (const input of [{ pageChars: 0 }, { offset: -1 }, { expectedHash: 'bad' }, { section: 'secret' }]) {
    await expect(service.read({ source: 'weather', ...input })).rejects.toMatchObject({ code: 'SOURCE_ARGUMENT_INVALID' });
  }
  expect(read).not.toHaveBeenCalled();
});

test('failed sole or all brief sections do not claim a successful read', async () => {
  for (const sections of [{ mail: { unavailable: 'Source unavailable' } },
    { mail: { unavailable: 'Source unavailable' }, actions: { unavailable: 'Source unavailable' } }]) {
    const result = await forAudience('owner', { brief: async () => ({ sections }), now }).read({ source: 'secretary' });
    expect(result).toMatchObject({ status: 'unavailable', lastSuccessfulReadAt: null });
  }
  const partial = await forAudience('owner', { brief: async () => ({ sections: { mail: { unavailable: 'Source unavailable' }, actions: [] } }), now }).read({ source: 'secretary' });
  expect(partial.status).toBe('partial');
});
