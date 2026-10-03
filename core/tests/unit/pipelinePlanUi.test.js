'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../public/js/pipeline-plan.js'), 'utf8');

function load({ response = { ok: true, json: async () => ({ data: {} }) } } = {}) {
  const listeners = {}, events = [];
  const fetch = jest.fn(async () => response);
  const window = { localStorage: { getItem: () => 'Operator', setItem: jest.fn() } };
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init.detail; } }
  vm.runInNewContext(source, { window, fetch, CustomEvent, FormData: class { constructor(form) { this.form = form; } get(name) { return this.form.values[name]; } },
    document: { addEventListener: (name, listener) => { listeners[name] = listener; }, dispatchEvent: (event) => events.push(event) } });
  return { markup: window.PipelinePlan.markup, listeners, fetch, events };
}
const FP = 'a'.repeat(64);
function task(plan) { return { pipelineId: '0991', status: 'queued', plan: { schema: 'agentx.pipeline-task-plan/v1', executionAuthority: 'none', ...plan } }; }
const current = (extra = {}) => ({ revision: 2, planRef: 'task-0991/plan-2', mode: 'plan', at: '2026-09-27T10:00:00Z',
  actor: { declared: 'coding-team', channel: 'task_preparation' }, text: '<b>Do it</b>', steps: [], truncated: false, originalLength: 13,
  scope: ['core/a.js'], fingerprint: FP, changedSince: [], decision: null, ...extra });

test('tasks without a plan keep the short path', () => {
  const { markup } = load();
  expect(markup({ pipelineId: '0991' })).toBe('');
  expect(markup(task({ state: 'none', current: null }))).toBe('');
});

test('an undecided revision shows escaped text, the prior decision as not carried over, and an optional decision form', () => {
  const html = load().markup(task({ state: 'undecided', current: current(), priorDecision: { revision: 1, outcome: 'approved', carriedOver: false } }));
  expect(html).toContain('&lt;b&gt;Do it&lt;/b&gt;');
  expect(html).not.toContain('<b>Do it</b>');
  expect(html).toContain('Revision 1 was approved. That decision does not carry over to revision 2.');
  expect(html).toContain('never starts work');
  expect(html).toContain(`data-fingerprint="${FP}"`);
  expect(html).toContain('Approve revision 2');
});

test('decided, stale, drifted and unknown plans offer no decision form', () => {
  const { markup } = load();
  const approved = markup(task({ state: 'approved', current: current({ decision: { outcome: 'approved', actor: { declared: 'Operator' }, at: '2026-09-27T11:00:00Z' } }) }));
  expect(approved).toContain('Approved by Operator');
  expect(approved).not.toContain('data-plan-decision');
  const stale = markup(task({ state: 'stale', current: current({ decision: { outcome: 'approved', actor: { declared: 'Operator' }, staleBecause: ['task_changed'] } }) }));
  expect(stale).toContain('No longer current: the task request was edited');
  const drifted = markup(task({ state: 'undecided', current: current({ changedSince: ['scope_changed'] }) }));
  expect(drifted).toContain('the automation scope changed');
  expect(drifted).not.toContain('data-plan-decision');
  expect(markup(task({ state: 'mystery', current: current() }))).toContain('Plan state unknown');
  expect(markup({ pipelineId: '0991', plan: { schema: 'other/v9', state: 'approved', current: current() } })).toContain('Plan state unknown');
});

function form(values) {
  const buttons = [{ disabled: false }, { disabled: false }], message = { textContent: '' };
  return { dataset: { planDecision: '0991', revision: '2', fingerprint: FP }, values, isConnected: true, message, buttons,
    closest: () => null, querySelector: (selector) => selector === '[data-plan-message]' ? message : { focus: jest.fn() },
    querySelectorAll: () => buttons };
}
async function submit(env, target, outcome) {
  target.closest = () => target;
  env.listeners.submit({ target, submitter: { dataset: { outcome } }, preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
}

test('a decision posts the exact revision and fingerprint, then refreshes the dossier', async () => {
  const env = load();
  const target = form({ by: 'Operator', reason: '' });
  await submit(env, target, 'approved');
  const [url, options] = env.fetch.mock.calls[0];
  expect(url).toBe('/api/pipeline/tasks/0991/plan/decision');
  expect(JSON.parse(options.body)).toEqual({ revision: 2, planFingerprint: FP, outcome: 'approved', by: 'Operator' });
  expect(env.events[0]).toMatchObject({ type: 'pipeline-task-saved', detail: { pipelineId: '0991' } });
});

test('a refused decision keeps the form and explains why', async () => {
  const env = load({ response: { ok: false, json: async () => ({ message: 'Revision 2 is no longer current.' }) } });
  const target = form({ by: 'Operator' });
  await submit(env, target, 'changes_requested');
  expect(target.message.textContent).toBe('Revision 2 is no longer current.');
  expect(target.buttons.every((button) => !button.disabled)).toBe(true);
  expect(env.events).toHaveLength(0);
  const unsigned = form({ by: ' ' });
  await submit(env, unsigned, 'approved');
  expect(unsigned.message.textContent).toBe('Enter the reviewer name.');
  expect(env.fetch).toHaveBeenCalledTimes(1);
});
