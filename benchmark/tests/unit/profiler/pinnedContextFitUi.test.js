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
  const transport = jest.fn(async () => { throw new Error('lost ACK'); });
  const stubs = { sessionStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    crypto: { randomUUID: () => `fixture-uuid-${++sequence}` }, fetch: transport };
  const handler = () => loadBrowserModule('model-profiler/lanes.js', 'requestFit', stubs).requestFit;
  const root = { querySelector: () => null }, button = {}, status = {};
  await handler()(lane, button, status, root);
  await handler()(lane, button, status, root); // New module instance, same tab storage.
  expect(transport.mock.calls.map(([, options]) => JSON.parse(options.body).requestId)).toEqual(['fixture-uuid-1', 'fixture-uuid-1']);
  await handler()({ ...lane, pinnedFit: { id: 'fixture-uuid-1', state: 'unknown', runtimeReleased: false } }, button, status, root);
  expect(sequence).toBe(1);
  await handler()({ ...lane, pinnedFit: { id: 'fixture-uuid-1', state: 'failed', runtimeReleased: true } }, button, status, root);
  expect(sequence).toBe(2);
  expect(transport.mock.calls.every(([url]) => url.endsWith('/fit-checks/request'))).toBe(true);
});
