'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../public/js/pipeline-eligibility.js'), 'utf8');
async function observe({ unavailable = false, stale = false, connected = true } = {}) {
  const result = { setAttribute() {}, removeAttribute() {} }, button = {};
  const panel = { dataset: { taskEligibility: '0952' }, open: true, isConnected: connected,
    matches: () => true, querySelector: selector => selector === '[data-eligibility-result]' ? result : button };
  const listeners = {};
  const fetch = jest.fn(async url => ({ ok: !unavailable, status: 503, json: async () => ({ data: { eligibility: {
    schema: 'agentx.pipeline-eligibility/v1', pipelineId: '0952', mode: url.endsWith('true') ? 'review_only' : 'manual',
    observedAt: new Date(Date.now() - (stale ? 120000 : 0)).toISOString(), observedEligible: false,
    reasons: [{ code: 'dependencies_incomplete' }, ...(url.endsWith('true') ? [{ code: 'automation_missing' }] : [])]
  } } }) }));
  const window = {};
  vm.runInNewContext(source, { window, fetch, AbortController, setTimeout, clearTimeout, Date,
    document: { addEventListener: (name, listener) => { listeners[name] = listener; } } });
  listeners.toggle({ target: panel });
  await new Promise(resolve => setImmediate(resolve));
  return { window, fetch, result, button };
}
test('shows manual and automation reasons using only observation requests', async () => {
  const { result, fetch } = await observe();
  expect(result.innerHTML).toContain('Dependencies are incomplete');
  expect(result.innerHTML).toContain('No structured automation policy');
  expect(result.innerHTML).toContain('Guarded automation (legacy)');
  expect(result.innerHTML).not.toContain('<strong>Coding Team</strong>');
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/pipeline/tasks/0952/eligibility?automation=false', '/api/pipeline/tasks/0952/eligibility?automation=true']);
  expect(fetch.mock.calls.every(([, options]) => !options.method && !options.body)).toBe(true);
});
test.each([{ stale: true }, { unavailable: true }])('failed or stale observations do not recommend starting work', async options => {
  const { result, button } = await observe(options);
  expect(result.innerHTML).not.toContain('Queue conditions observed');
  expect(button.disabled).toBe(false);
});
test('does not apply a completed read to a removed dossier', async () => {
  const { result } = await observe({ connected: false });
  expect(result.innerHTML).toBeUndefined();
});
test('does not add a coding eligibility panel to private task lanes', async () => {
  const { window } = await observe();
  expect(window.PipelineEligibility.markup({ pipelineId: '0952', service: 'family' })).toBe('');
  expect(window.PipelineEligibility.markup({ pipelineId: '0952', source: 'household-idea' })).toBe('');
});

test('Tab and Shift+Tab loop through dialog controls rather than the scrim', () => {
  const first = { focus: jest.fn(), getClientRects: () => [1] }, last = { focus: jest.fn(), getClientRects: () => [1] };
  const dialog = { querySelectorAll: () => [first, last] };
  const listeners = {}, document = { activeElement: first, addEventListener: (name, listener) => { listeners[name] = listener; },
    getElementById: id => id === 'pipelineDrawerShell' ? { hidden: false, querySelector: () => dialog } : null };
  vm.runInNewContext(source, { document, window: {} });
  const preventDefault = jest.fn();
  listeners.keydown({ key: 'Tab', shiftKey: true, preventDefault });
  expect(last.focus).toHaveBeenCalledTimes(1);
  document.activeElement = last;
  listeners.keydown({ key: 'Tab', shiftKey: false, preventDefault });
  expect(first.focus).toHaveBeenCalledTimes(1);
  expect(preventDefault).toHaveBeenCalledTimes(2);
});
