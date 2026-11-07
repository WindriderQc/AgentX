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

test.each([0, 2])('a fresh device resumes persisted A after a lost queue ACK without allocating B (current pin index %s)', async pinIndex => {
  const uuid = jest.fn();
  const transport = jest.fn().mockRejectedValueOnce(new Error('Queue submission ACK lost'))
    .mockResolvedValue({ ok: true, json: async () => ({ status: 'success',
      data: { id: 'A', state: 'requested', queueRequestId: 'original-queue' } }) });
  const persistedA = { ...lane, pinIndex, pinnedFit: { id: 'A', hostId: 'fixture', pinIndex: 0,
    state: 'requested', queueRequestId: null, runtimeReleased: false } };
  const stores = [];
  const freshDevice = () => {
    const saved = new Map(); stores.push(saved);
    return loadBrowserModule('model-profiler/lanes.js', 'requestFit', {
      sessionStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
      crypto: { randomUUID: uuid }, fetch: transport
    }).requestFit;
  };
  const root = { querySelector: () => null };
  await freshDevice()(persistedA, {}, {}, root);
  await freshDevice()(persistedA, {}, {}, root); // No shared sessionStorage or module state.
  expect(uuid).not.toHaveBeenCalled(); expect(transport).toHaveBeenCalledTimes(2);
  for (const [url, options] of transport.mock.calls) {
    expect(url).toBe('/benchmark/api/profiler/fit-checks/request');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ requestId: 'A', hostId: 'fixture', pinIndex: 0 });
  }
  expect(stores.every(saved => saved.get(`profiler-pinned-fit:fixture:${pinIndex}`) === 'A')).toBe(true);
});

test.each([
  { id: 'A', state: 'unknown', runtimeReleased: false },
  { id: 'A', state: 'completed', runtimeReleased: false },
  { id: 'A', state: 'requested', runtimeReleased: false } // Original scope unavailable.
])('a fresh device observes persisted A without replacing an unresolved or incomplete receipt: %o', async pinnedFit => {
  const uuid = jest.fn(), transport = jest.fn();
  const saved = new Map();
  const handler = loadBrowserModule('model-profiler/lanes.js', 'requestFit', {
    sessionStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    crypto: { randomUUID: uuid }, fetch: transport
  }).requestFit;
  const status = {};
  await handler({ ...lane, pinnedFit }, {}, status, { querySelector: () => null });
  expect(uuid).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
  expect(saved.get('profiler-pinned-fit:fixture:0')).toBe('A');
  expect(status.textContent).toContain('Original fit A');
  expect(status.textContent).toContain('No new request was recorded.');
});

test.each(['requested', 'unknown', 'completed'])('a released cached A yields to persisted nonreleased B (%s) instead of allocating C', async state => {
  const saved = new Map([['profiler-pinned-fit:fixture:0', 'A']]);
  const uuid = jest.fn();
  const transport = jest.fn(async (_, options) => ({ ok: true, json: async () => ({ status: 'success',
    data: options.method === 'POST' ? { id: 'B', state: 'requested' }
      : { id: 'A', state: 'completed', runtimeReleased: true } }) }));
  const handler = loadBrowserModule('model-profiler/lanes.js', 'requestFit', {
    sessionStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    crypto: { randomUUID: uuid }, fetch: transport
  }).requestFit;
  const latestB = { ...lane, pinnedFit: { id: 'B', hostId: 'fixture', pinIndex: 2,
    state, queueRequestId: null, runtimeReleased: false } };
  await handler(latestB, {}, {}, { querySelector: () => null });
  expect(uuid).not.toHaveBeenCalled(); expect(saved.get('profiler-pinned-fit:fixture:0')).toBe('B');
  expect(transport.mock.calls[0][0]).toMatch(/\/A$/);
  const posts = transport.mock.calls.filter(([, options]) => options.method === 'POST');
  if (state === 'requested') {
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0][1].body)).toEqual({ requestId: 'B', hostId: 'fixture', pinIndex: 2 });
  } else expect(posts).toHaveLength(0);
});

const recoveryMatrix = ['absent', 'same', 'different'].flatMap(cache =>
  ['absent', 'unknown', 'terminal_unreleased', 'terminal_released'].flatMap(original =>
    ['requested', 'unknown', 'terminal_released'].map(persisted => ({ cache, original, persisted }))));
recoveryMatrix.push(...['requested', 'unavailable'].flatMap(original =>
  ['requested', 'unknown', 'terminal_released'].map(persisted => ({ cache: 'different', original, persisted }))));

test.each(recoveryMatrix)('recovery matrix: cache=$cache original=$original lane=$persisted', async ({ cache, original, persisted }) => {
  const laneId = cache === 'same' ? 'A' : 'B';
  const stored = new Map(cache === 'absent' ? [] : [['profiler-pinned-fit:fixture:0', 'A']]);
  const uuid = jest.fn(() => 'C');
  const receipt = (id, state, pinIndex) => ({ id, hostId: 'fixture', pinIndex,
    state: state.startsWith('terminal') ? 'completed' : state,
    runtimeReleased: state === 'terminal_released', queueRequestId: null });
  const transport = jest.fn(async (_, options) => {
    if (options.method === 'POST') {
      const id = JSON.parse(options.body).requestId;
      return { ok: true, json: async () => ({ status: 'success', data: { id, state: 'requested' } }) };
    }
    if (original === 'unavailable') throw new Error('Original read response lost');
    if (original === 'absent') return { ok: false, status: 404 };
    return { ok: true, json: async () => ({ status: 'success', data: receipt('A', original, 1) }) };
  });
  const handler = loadBrowserModule('model-profiler/lanes.js', 'requestFit', {
    sessionStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) },
    crypto: { randomUUID: uuid }, fetch: transport
  }).requestFit;
  await handler({ ...lane, pinnedFit: receipt(laneId, persisted, 2) }, {}, {}, { querySelector: () => null });

  // The exact lane receipt is authoritative when it names the cached ID.
  // A different cached predecessor must be resolved before considering it.
  let expectedId, expectedPinIndex, newIdentity = false;
  if (cache === 'different' && original !== 'terminal_released') {
    if (original === 'absent') { expectedId = 'A'; expectedPinIndex = 0; }
    if (original === 'requested') { expectedId = 'A'; expectedPinIndex = 1; }
  } else if (persisted === 'requested') {
    expectedId = laneId; expectedPinIndex = 2;
  } else if (persisted === 'terminal_released') {
    expectedId = 'C'; expectedPinIndex = 0; newIdentity = true;
  }
  const posts = transport.mock.calls.filter(([, options]) => options.method === 'POST');
  const reads = transport.mock.calls.filter(([, options]) => options.method !== 'POST');
  expect(reads).toHaveLength(cache === 'different' ? 1 : 0);
  if (reads.length) expect(reads[0][0]).toMatch(/\/A$/);
  expect(uuid).toHaveBeenCalledTimes(newIdentity ? 1 : 0);
  expect(posts).toHaveLength(expectedId ? 1 : 0);
  if (expectedId) {
    expect(posts[0][0]).toBe('/benchmark/api/profiler/fit-checks/request');
    expect(JSON.parse(posts[0][1].body)).toEqual({ requestId: expectedId, hostId: 'fixture', pinIndex: expectedPinIndex });
  }
  if (cache === 'different' && original !== 'terminal_released') {
    expect(stored.get('profiler-pinned-fit:fixture:0')).toBe('A');
  }
});
