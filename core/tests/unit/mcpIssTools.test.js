'use strict';

const { issPasses, parseArgs } = require('../../src/services/mcpIssTools');
const { computePasses, directionFr, tleEpoch } = require('../../src/services/iss/issPasses');
const { handleMcpMessage } = require('../../src/services/mcpSkillBus');

// CelesTrak ISS element set of 2026-10-24. Reference passes were computed
// independently with PyEphem 4.2.1 for 46.8139 N, 71.2080 W, sea level.
const LINE1 = '1 25544U 98067A   26297.20915682  .00007800  00000+0  14938-3 0  9991';
const LINE2 = '2 25544  51.6335  21.6229 0006884 302.9098  57.1228 15.49030149591752';
const START = new Date('2026-10-24T22:30:00Z');

function seconds(a, b) {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 1000;
}

function dataStub({ satellites, weather, fail, onDemand } = {}) {
  const calls = [];
  const fetchData = jest.fn(async (path, opts) => {
    calls.push({ path, query: opts.query });
    if (fail) throw Object.assign(new Error('boom'), { name: 'TimeoutError' });
    if (path === '/api/v1/livedata/tle') return onDemand
      ? { response: { ok: true, status: 200 }, body: { status: 'success', data: onDemand } }
      : { response: { ok: false, status: 404 }, body: { status: 'error' } };
    const data = path.includes('satellites') ? satellites : weather;
    return { response: { ok: true, status: 200 }, body: { status: 'success', data } };
  });
  return { fetchData, calls };
}

const SATELLITES = [
  { ts: '2026-10-24T17:03:41.618Z', payload: { name: 'CSS (TIANHE)', noradId: '48274', tle1: 'x', tle2: 'y' } },
  { ts: '2026-10-24T11:03:41.665Z', payload: { name: 'ISS (ZARYA)', noradId: '25544', tle1: '1 25544U old', tle2: '2 25544 old' } },
  { ts: '2026-10-24T17:03:41.618Z', payload: { name: 'ISS (ZARYA)', noradId: '25544', tle1: LINE1, tle2: LINE2 } },
];
const WEATHER = [{ timeStamp: '2026-10-24T22:18:41.733Z', lat: 46.8139, lon: -71.208, pressure: 1031.4 }];

describe('ISS pass computation', () => {
  test('reads the TLE epoch in UTC', () => {
    expect(tleEpoch(LINE1).toISOString()).toBe('2026-10-24T05:01:11.149Z');
  });

  test('matches PyEphem rise, culmination and set', () => {
    const reference = [
      ['2026-10-25T05:57:04Z', '2026-10-25T06:02:07Z', 22.3, '2026-10-25T06:07:12Z'],
      ['2026-10-25T07:33:11Z', '2026-10-25T07:38:40Z', 72.7, '2026-10-25T07:44:10Z'],
      ['2026-10-25T09:10:26Z', '2026-10-25T09:15:49Z', 34.9, '2026-10-25T09:21:12Z'],
      ['2026-10-25T10:47:36Z', '2026-10-25T10:53:04Z', 49.4, '2026-10-25T10:58:31Z'],
    ];
    const passes = computePasses({ line1: LINE1, line2: LINE2 }, { lat: 46.8139, lon: -71.208 }, { start: START, hours: 40 })
      .passes.filter(p => p.max.elDeg > 1);
    reference.forEach(([rise, max, el, set], i) => {
      expect(seconds(passes[i].rise.time, rise)).toBeLessThanOrEqual(3);
      expect(seconds(passes[i].max.time, max)).toBeLessThanOrEqual(3);
      expect(seconds(passes[i].set.time, set)).toBeLessThanOrEqual(3);
      expect(Math.abs(passes[i].max.elDeg - el)).toBeLessThanOrEqual(0.3);
    });
  });

  test('separates geometric passes from observable ones', () => {
    const passes = computePasses({ line1: LINE1, line2: LINE2 }, { lat: 46.8139, lon: -71.208 }, { start: START, hours: 40 }).passes;
    const at = (prefix) => passes.find(p => p.rise.time.startsWith(prefix));
    expect(at('2026-10-25T05:57').reason.code).toBe('earth_shadow');
    expect(at('2026-10-25T10:47').reason.code).toBe('daylight');
    expect(at('2026-10-25T04:25').reason.code).toBe('too_low');
    const visible = at('2026-10-25T09:10');
    expect(visible.observable).toBe(true);
    // PyEphem: leaves Earth's shadow at 09:16:00.
    expect(seconds(visible.visible.start.time, '2026-10-25T09:16:00Z')).toBeLessThanOrEqual(12);
    expect(visible.visible.end.direction).toBe('ENE');
  });

  test('names French cardinal directions', () => {
    expect([0, 90, 225, 270, 359].map(directionFr)).toEqual(['N', 'E', 'SO', 'O', 'N']);
  });
});

describe('iss_passes tool', () => {
  const env = { ISS_VIEW_URL: 'https://example.test/iss#passages' };
  const now = () => START;

  test('uses the newest ISS elements and the household location held by Data', async () => {
    const { fetchData, calls } = dataStub({ satellites: SATELLITES, weather: WEATHER });
    const out = await issPasses({ hours: 40 }, { fetchData, now, env });
    expect(calls.map(c => c.path).sort()).toEqual(['/api/v1/livedata/satellites/latest', '/api/v1/livedata/tle', '/api/v1/livedata/weather/latest']);
    expect(out.tle).toMatchObject({ epoch: '2026-10-24T05:01:11.149Z', retrievedAt: '2026-10-24T17:03:41.618Z', stale: false, source: 'CelesTrak via Data' });
    expect(out.timeZone).toBe('America/Toronto');
    expect(out.nextVisible).toMatchObject({ from: 'N', to: 'ENE', maxElDeg: 34.1 });
    expect(out.nextVisible.startLocal).toMatch(/dim\. 25 oct\..*05 h 16/);
    expect(out.view).toEqual({ url: 'https://example.test/iss#passages', label: expect.any(String) });
    expect(out.counts.observable).toBeGreaterThan(0);
    expect(out.passes.length).toBeLessThanOrEqual(8);
  });

  test('never returns the household coordinates', async () => {
    const { fetchData } = dataStub({ satellites: SATELLITES, weather: WEATHER });
    const text = JSON.stringify(await issPasses({}, { fetchData, now, env }));
    expect(text).not.toMatch(/46\.8|71\.2/);
  });

  test('explicit coordinates work without a known home and bypass its lookup', async () => {
    const { fetchData, calls } = dataStub({ satellites: SATELLITES });
    const out = await issPasses({ lat: 46.81, lon: -71.21, hours: 12 }, { fetchData, now, env });
    expect(calls.some(c => c.path.includes('weather'))).toBe(false);
    expect(out.observer).toMatchObject({ source: 'explicit', defaulted: false });
    expect(JSON.stringify(out)).not.toMatch(/46\.81|71\.21/);
    expect(out.passes.length).toBeGreaterThan(0);
  });

  test.each([{ weather: [] }, { weather: [{ lat: null, lon: null }] }])('discloses the configured default when the known location is missing or invalid (%j)', async ({ weather }) => {
    const { fetchData } = dataStub({ satellites: SATELLITES, weather });
    const out = await issPasses({ hours: 12 }, { fetchData, now,
      env: { ...env, OBSERVER_DEFAULT_LOCATION_JSON: JSON.stringify({ name: 'Québec', lat: 46.81, lon: -71.21 }) } });
    expect(out.observer).toEqual({ source: 'default', label: 'Québec', defaulted: true, precision: 'environ 1 km' });
    expect(out.answerRules).toMatch(/ne prouve pas la position/);
    expect(JSON.stringify(out)).not.toMatch(/46\.81|71\.21/);
  });

  test('uses the known location before a default and falls back when that lookup alone fails', async () => {
    const configured = { ...env, OBSERVER_DEFAULT_LOCATION_JSON: JSON.stringify({ name: 'Other city', lat: 10, lon: 20 }) };
    const stub = dataStub({ satellites: SATELLITES, weather: WEATHER });
    const known = await issPasses({ hours: 1 }, { ...stub, now, env: configured });
    expect(known.observer).toMatchObject({ source: 'known', defaulted: false });
    const fetchData = async (path, opts) => {
      if (path.includes('weather')) throw new Error('weather unavailable');
      return stub.fetchData(path, opts);
    };
    const fallback = await issPasses({ hours: 1 }, { fetchData, now, env: configured });
    expect(fallback.observer).toMatchObject({ source: 'default', label: 'Other city', defaulted: true });
  });

  test('visible_only keeps only observable passes', async () => {
    const { fetchData } = dataStub({ satellites: SATELLITES, weather: WEATHER });
    const out = await issPasses({ visible_only: true, hours: 40 }, { fetchData, now, env: {} });
    expect(out.passes.length).toBeGreaterThan(0);
    expect(out.passes.every(p => p.observable && p.visible.startLocal)).toBe(true);
    expect(out.view).toBeNull();
  });

  test('flags old orbital elements', async () => {
    const { fetchData } = dataStub({ satellites: SATELLITES, weather: WEATHER });
    const out = await issPasses({ hours: 6 }, { fetchData, now: () => new Date('2026-10-28T12:00:00Z'), env });
    expect(out.tle.stale).toBe(true);
    expect(out.tle.staleReason).toMatch(/3 jours/);
  });

  test('uses Data on-demand TLE without a stored feed and retains its stale disclosure', async () => {
    const { fetchData, calls } = dataStub({ weather: WEATHER, onDemand: {
      line1: LINE1, line2: LINE2, fetchedAt: '2026-10-24T17:03:41.618Z', stale: true
    } });
    const out = await issPasses({ hours: 12 }, { fetchData, now, env });
    expect(calls.some(c => c.path.includes('satellites'))).toBe(false);
    expect(calls.find(c => c.path.endsWith('/tle')).query).toBe('norad=25544');
    expect(out.tle).toMatchObject({ stale: true, staleReason: expect.stringMatching(/secours/) });
    expect(out.passes.length).toBeGreaterThan(0);
  });

  test('reports missing sources instead of inventing passes', async () => {
    await expect(issPasses({}, { ...dataStub({ satellites: SATELLITES.slice(0, 1), weather: WEATHER }), now, env }))
      .rejects.toMatchObject({ code: 'ISS_DATA_UNAVAILABLE', message: expect.stringMatching(/no ISS orbital elements/) });
    await expect(issPasses({}, { ...dataStub({ satellites: SATELLITES, weather: [] }), now, env }))
      .rejects.toMatchObject({ code: 'ISS_DATA_UNAVAILABLE', message: expect.stringMatching(/weather location/) });
    await expect(issPasses({}, { ...dataStub({ fail: true }), now, env }))
      .rejects.toMatchObject({ code: 'ISS_DATA_UNAVAILABLE', message: expect.stringMatching(/timeout/) });
  });

  test('validates its arguments strictly', () => {
    expect(parseArgs(undefined)).toEqual({ hours: 72, visibleOnly: false, maxPasses: 8 });
    expect(() => parseArgs({ lat: 1 })).toThrow(/lat and lon/);
    expect(() => parseArgs({ lat: null, lon: null })).toThrow(/lat and lon/);
    expect(() => parseArgs({ lat: false, lon: 0 })).toThrow(/lat and lon/);
    expect(() => parseArgs({ location: 'somewhere' })).toThrow(/unknown argument/);
    expect(parseArgs({ lat: 0, lon: 0 }).position).toEqual({ lat: 0, lon: 0 });
    expect(() => parseArgs({ hours: 500 })).toThrow(/hours/);
    expect(() => parseArgs({ visible_only: 'yes' })).toThrow(/boolean/);
  });

  test('is callable through the Core MCP bus as a read-only tool', async () => {
    const list = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tool = list.result.tools.find(t => t.name === 'iss_passes');
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    const { fetchData } = dataStub({ satellites: SATELLITES, weather: WEATHER });
    const res = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'iss_passes', arguments: { hours: 12 } } }, { fetchData, now, env });
    expect(res.result.isError).toBe(false);
    expect(res.result.structuredContent.status).toBe('ok');
  });
});
