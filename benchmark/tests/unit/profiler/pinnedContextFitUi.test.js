'use strict';
const { loadBrowserModule } = require('../../helpers/browserModule');
const escAttr = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ui = loadBrowserModule('model-profiler/components/lane-capability.js', 'renderLaneCard, renderPinnedFit', {
  escAttr, _fmtCtx: value => `${value / 1024}k`
});
const lane = { pinned: true, pinIndex: 0, residency: 'gpu', pinContext: 8192,
  capability: { model: 'fixture:latest', hostId: 'fixture', runtimeDrift: { measured: '0.1', installed: '0.2' } } };
test('fit control records a request while general runtime drift remains visible after a pass', () => {
  const html = ui.renderLaneCard({ ...lane, pinnedFit: { status: 'pass', state: 'completed', matchesCurrent: true,
    numCtx: 8192, ollamaVersion: '0.2', checkedAt: '2026-11-07T20:00:00Z', durationMs: 4100,
    limit: 'Residency only; tools and quality remain separate.' } });
  expect(html).toContain('Request pinned fit check'); expect(html).toContain('Measured on Ollama 0.1');
  expect(html).toContain('GPU residency passed at 8k on Ollama 0.2'); expect(html).toContain('4.1 s');
  expect(html).toContain('tools and quality remain separate');
});
test('historical and unknown receipts never clear warnings or offer a replacement during uncertainty', () => {
  const html = ui.renderLaneCard({ ...lane, pinnedFit: { state: 'unknown', status: 'unknown', matchesCurrent: false } });
  expect(html).toContain('Historical fit'); expect(html).toContain('revalidation required');
  expect(html).not.toContain('data-lane-action="fit"'); expect(html).toContain('Measured on Ollama 0.1');
});
test('rendering is inert and escapes receipt metadata', () => {
  const html = ui.renderPinnedFit({ state: '<script>', checkedAt: '<img>', matchesCurrent: false, reason: 'untrusted' });
  expect(html).not.toContain('<script>'); expect(html).not.toContain('<img>');
  expect(html).toContain('pinned context is preserved');
});
test('the browser retains one request UUID across a lost response and reload; only a released terminal receipt permits a new intent', async () => {
  const saved = new Map(); let sequence = 0;
  const transport = jest.fn(async (_, options) => {
    if (options.method !== 'POST') return { ok: false, status: 404 };
    throw new Error('lost ACK');
  });
  const stubs = { sessionStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    crypto: { randomUUID: () => `fixture-uuid-${++sequence}` }, fetch: transport };
  const handler = () => loadBrowserModule('model-profiler/lanes.js', 'requestFit', stubs).requestFit;
  const root = { querySelector: () => null }, button = {}, status = {};
  await handler()(lane, button, status, root);
  await handler()(lane, button, status, root); // New module instance, same tab storage.
  expect(transport.mock.calls.filter(([, options]) => options.method === 'POST')
    .map(([, options]) => JSON.parse(options.body).requestId)).toEqual(['fixture-uuid-1', 'fixture-uuid-1']);
  await handler()({ ...lane, pinnedFit: { id: 'fixture-uuid-1', state: 'unknown', runtimeReleased: false } }, button, status, root);
  expect(sequence).toBe(1);
  await handler()({ ...lane, pinnedFit: { id: 'fixture-uuid-1', state: 'failed', runtimeReleased: true } }, button, status, root);
  expect(sequence).toBe(2);
  expect(transport.mock.calls.filter(([, options]) => options.method === 'POST')
    .every(([url]) => url.endsWith('/fit-checks/request'))).toBe(true);
});

test('A loses its response, another tab finishes B, then the first tab reads A before recording C', async () => {
  const saved = new Map(); let sequence = 0;
  const transport = jest.fn(async (url, options) => {
    if (options.method !== 'POST') return { ok: true, json: async () => ({ status: 'success',
      data: { id: 'A', state: 'completed', runtimeReleased: true } }) };
    const id = JSON.parse(options.body).requestId;
    if (id === 'A') throw new Error('A completed, response lost');
    return { ok: true, json: async () => ({ status: 'success', data: { id, state: 'requested' } }) };
  });
  const makeHandler = () => loadBrowserModule('model-profiler/lanes.js', 'requestFit', {
    sessionStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    crypto: { randomUUID: () => ++sequence === 1 ? 'A' : 'C' }, fetch: transport
  }).requestFit;
  const root = { querySelector: () => null }, button = {}, status = {};
  await makeHandler()(lane, button, status, root);
  const latestB = { ...lane, pinnedFit: { id: 'B', state: 'completed', runtimeReleased: true } };
  await makeHandler()(latestB, button, status, root);
  expect(transport.mock.calls.map(([url, options]) => options.method === 'POST'
    ? `POST ${JSON.parse(options.body).requestId}` : `GET ${url.split('/').pop()}`)).toEqual(['POST A', 'GET A', 'POST C']);
  expect(saved.get('profiler-pinned-fit:fixture:0')).toBe('C');
});

test.each(['unknown', 'unavailable'])('latest B never replaces %s A without its own release proof', async state => {
  const saved = new Map([['profiler-pinned-fit:fixture:0', 'A']]);
  const uuid = jest.fn();
  const transport = jest.fn(async () => {
    if (state === 'unavailable') throw new Error('Original receipt response lost');
    return { ok: true, json: async () => ({ status: 'success', data: { id: 'A', state, runtimeReleased: false } }) };
  });
  const handler = loadBrowserModule('model-profiler/lanes.js', 'requestFit', {
    sessionStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    crypto: { randomUUID: uuid }, fetch: transport
  }).requestFit;
  const latestB = { ...lane, pinnedFit: { id: 'B', state: 'completed', runtimeReleased: true } };
  const status = {};
  await handler(latestB, {}, status, { querySelector: () => null });
  expect(uuid).not.toHaveBeenCalled(); expect(saved.get('profiler-pinned-fit:fixture:0')).toBe('A');
  expect(transport).toHaveBeenCalledTimes(1); expect(transport.mock.calls[0][0]).toMatch(/\/A$/);
  expect(transport.mock.calls[0][1]).toEqual({ cache: 'no-store' });
  expect(status.textContent).not.toContain('Manual request recorded.');
});
