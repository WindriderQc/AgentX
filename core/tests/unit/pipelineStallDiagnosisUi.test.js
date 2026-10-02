'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../public/js/pipeline-stall-diagnosis.js'), 'utf8');

function diagnosis(overrides = {}) {
  return { schema: 'agentx.pipeline-task-diagnosis/v1', pipelineId: '0701', observedAt: new Date().toISOString(),
    category: 'recovery_required', code: 'lease_expired', owner: 'operator',
    summary: 'The automation lease expired.', action: 'Inspect the worker host.',
    worker: { heartbeat: 'stale', heartbeatAt: null, state: 'unknown' },
    lease: { state: 'expired', ref: 'lease-0123456789abcdef', expiresAt: new Date().toISOString() },
    missingEvidence: [{ code: 'worker_process', label: 'Worker process state on its host' }],
    escalation: { key: 'esc-0123456789abcdef', since: new Date().toISOString() },
    runtime: { consulted: false, boundary: 'Runtime recovery is separate.' }, ...overrides };
}

function load(responses) {
  const listeners = {};
  const storage = new Map();
  const fetch = jest.fn(async () => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return { ok: next.ok !== false, status: next.status || 200, json: async () => next.body };
  });
  const window = { sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } };
  vm.runInNewContext(source, { window, fetch, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, Date,
    document: { addEventListener: (name, listener) => { listeners[name] = listener; }, getElementById: () => null } });
  const result = { innerHTML: '', setAttribute() {}, removeAttribute() {}, querySelector: () => null };
  const button = {};
  const panel = { dataset: { stallTask: '0701' }, open: true, isConnected: true, id: '',
    matches: selector => selector === '[data-stall-task]',
    querySelector: selector => selector === '[data-stall-result]' ? result : button };
  const open = async () => { listeners.toggle({ target: panel }); await new Promise(resolve => setImmediate(resolve)); };
  return { window, fetch, result, button, open, storage };
}

test('shows category, owner, next step and missing evidence using only GET reads', async () => {
  const { result, fetch, open } = load([{ body: { data: { diagnosis: diagnosis() } } }]);
  await open();
  expect(result.innerHTML).toContain('Recovery required');
  expect(result.innerHTML).toContain('Operator');
  expect(result.innerHTML).toContain('Inspect the worker host.');
  expect(result.innerHTML).toContain('Worker process state on its host');
  expect(result.innerHTML).toContain('Runtime recovery is separate.');
  expect(result.innerHTML).not.toMatch(/stopped|dead/i);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/pipeline/tasks/0701/diagnosis']);
  expect(fetch.mock.calls.every(([, options]) => !options.method && !options.body)).toBe(true);
});

test('an escalation is announced once, then shown as already escalated on refresh', async () => {
  const { result, open } = load([{ body: { data: { diagnosis: diagnosis() } } }, { body: { data: { diagnosis: diagnosis() } } }]);
  await open();
  expect(result.innerHTML).toContain('New escalation');
  await open();
  expect(result.innerHTML).toContain('Escalated earlier — not repeated');
  expect(result.innerHTML).not.toContain('New escalation');
});

test('an unknown shape stays unknown and a failed refresh keeps the last observation', async () => {
  const unknown = load([{ body: { data: { diagnosis: { schema: 'other/v1', pipelineId: '0701' } } } }]);
  await unknown.open();
  expect(unknown.result.innerHTML).toContain('unknown shape');
  expect(unknown.button.disabled).toBe(false);

  const kept = load([{ body: { data: { diagnosis: diagnosis() } } }, { ok: false, status: 503, body: {} }]);
  await kept.open();
  kept.result.querySelector = selector => selector === '.pipeline-stall-result' ? { outerHTML: '<div class="pipeline-stall-result">kept</div>' } : null;
  await kept.open();
  expect(kept.result.innerHTML).toContain('could not be read');
  expect(kept.result.innerHTML).toContain('The last observation is kept below.');
  expect(kept.result.innerHTML).toContain('kept');
});

test('no diagnosis panel for closed tasks or invalid ids', () => {
  const { window } = load([]);
  expect(window.PipelineStallDiagnosis.markup({ pipelineId: '0701', status: 'done' })).toBe('');
  expect(window.PipelineStallDiagnosis.markup({ pipelineId: 'x', status: 'queued' })).toBe('');
  expect(window.PipelineStallDiagnosis.markup({ pipelineId: '0701', status: 'in_progress' })).toContain('data-stall-task="0701"');
  expect(window.PipelineStallDiagnosis.markup({ pipelineId: '0701', status: 'queued', service: 'family', assignee: 'household-family' })).toBe('');
  expect(window.PipelineStallDiagnosis.markup({ pipelineId: '0701', status: 'queued', source: 'household-idea' })).toBe('');
});
