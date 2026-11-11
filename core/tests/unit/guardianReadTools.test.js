'use strict';
const { guardianReadTools, forTurn } = require('../../surfaces/household/guardian-read-tools');
const call = (name, args = {}) => ({ function: { name, arguments: args } });
const env = { HOUSEHOLD_GUARDIAN_TOOLS: 'iss_passes,weather,math' };
const now = () => new Date('2026-10-01T12:00:00Z');

test('server allowlist is empty by default, rejects unknown entries and excludes other packs/transports', () => {
  expect(guardianReadTools({})).toBeNull();
  expect(guardianReadTools({ HOUSEHOLD_GUARDIAN_TOOLS: 'weather,send_email' })).toBeNull();
  for (const input of [{ backend: 'openclaw', packId: 'personal_operator' }, { backend: 'agentx', packId: 'kidx_reader' },
    { backend: 'hermes', packId: 'personal_operator', blocked: true }]) expect(forTurn(env, input)).toBeNull();
  expect(forTurn(env, { backend: 'hermes', packId: 'personal_operator' }).names).toEqual(['iss_passes', 'weather', 'math']);
});

test.each([['iss_passes', { lat: 45, lon: -73 }], ['iss_passes', { hours: '24' }], ['weather', { location: 'secret' }],
  ['weather', 'null'], ['math', { operation: 'add', a: -1, b: 3 }], ['math', { operation: 'eval', expression: 'process.env' }],
  ['math', { operation: 'count', to: 101 }], ['personal_memory', {}]])('refuses %s invalid parameters before any source read', async (name, args) => {
  const readIss = jest.fn(), weather = jest.fn();
  const toolset = guardianReadTools(env, { readIss, ambient: { weather }, now });
  expect((await toolset.execute(call(name, args))).receipt.status).toBe('refused');
  expect(readIss).not.toHaveBeenCalled(); expect(weather).not.toHaveBeenCalled();
});

test('ISS uses native server observer without leaking coordinates, observer label or viewer fragment', async () => {
  const readIss = jest.fn(async () => ({ status: 'ok', computedAt: now().toISOString(), window: { hours: 24 },
    counts: { observable: 0 }, observer: { label: 'private place', lat: 45.12, lon: -73.56, defaulted: false },
    view: { url: 'https://viewer.invalid/#observer=45.12,-73.56' }, visiblePasses: [] }));
  const tools = guardianReadTools(env, { readIss, now });
  const first = await tools.execute(call('iss_passes', { hours: 24 }));
  const repeat = await tools.execute(call('iss_passes', '{"hours":24}'));
  expect(first).toEqual(repeat); expect(readIss).toHaveBeenCalledTimes(1);
  expect(readIss).toHaveBeenCalledWith({ hours: 24 });
  expect(first.receipt).toMatchObject({ authority: 'core.guardian-reads', status: 'completed' });
  expect(first.message.content).not.toMatch(/45\.12|73\.56|private place|viewer/);
  expect(JSON.parse(first.message.content).window.hours).toBe(24);
  expect(tools.definitions[0].function.parameters.properties).not.toHaveProperty('lat');
});

test('weather reuses family projection, preserves age and removes provider/private fields', async () => {
  const weather = jest.fn(async () => ({ fetchedAt: now().toISOString(), observedAt: '2026-10-01T08:00:00Z',
    temperatureC: 4, condition: 'Nuageux', lat: 45, station: 'private' }));
  const result = await guardianReadTools(env, { ambient: { weather }, now }).execute(call('weather'));
  const data = JSON.parse(result.message.content);
  expect(data).toMatchObject({ status: 'available', data: { temperatureC: 4, source: 'Environnement Canada' },
    freshness: { observationAgeMs: 14400000, observationFreshness: 'unknown' } });
  expect(result.message.content).not.toMatch(/private|station|"lat"/);
});

test('math reuses bounded Core arithmetic without evaluation; out-of-bounds sums stay refused', async () => {
  const tools = guardianReadTools(env, { now });
  expect(JSON.parse((await tools.execute(call('math', { operation: 'add', a: 8, b: 5 }))).message.content).result).toBe(13);
  expect(JSON.parse((await tools.execute(call('math', { operation: 'count', to: 100 }))).message.content).result).toHaveLength(100);
  expect((await tools.execute(call('math', { operation: 'add', a: 20, b: 1 }))).receipt).toMatchObject({ status: 'refused', error: 'MATH_OUT_OF_BOUNDS' });
});

test('failures retain the same observation identity without another source read; errors and oversize stay bounded', async () => {
  const readIss = jest.fn(async () => { throw Error('private provider error'); });
  const tools = guardianReadTools(env, { readIss, now });
  const first = await tools.execute(call('iss_passes'));
  expect(await tools.execute(call('iss_passes'))).toEqual(first); expect(readIss).toHaveBeenCalledTimes(1);
  expect(first.receipt).toMatchObject({ status: 'failed', error: 'GUARDIAN_READ_UNAVAILABLE' });
  expect(JSON.stringify(first)).not.toContain('private provider');
  const large = guardianReadTools(env, { readIss: async () => ({ passes: ['x'.repeat(9000)] }), now });
  expect((await large.execute(call('iss_passes'))).receipt.error).toBe('RESULT_TOO_LARGE');
});

test('cancellation before execution opens no source read', async () => {
  const readIss = jest.fn(), signal = AbortSignal.abort(Error('stop'));
  await expect(guardianReadTools(env, { readIss }).execute(call('iss_passes'), { signal })).rejects.toThrow('stop');
  expect(readIss).not.toHaveBeenCalled();
});
