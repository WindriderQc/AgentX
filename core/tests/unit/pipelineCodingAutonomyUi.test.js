'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../public/js/pipeline-coding-autonomy.js'), 'utf8');
const KEY = '11111111-2222-4333-8444-555555555555';
class Element {
  constructor(text = '') { this.textContent = text; this.children = []; this.events = {}; this.dataset = {}; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(name, fn) { this.events[name] = fn; }
}
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
function setup(state) {
  const nodes = { codingAutonomyConfirm: new Element() };
  const document = { getElementById: id => nodes[id] ||= new Element(),
    createElement: () => new Element(), addEventListener: (_name, fn) => { document.start = fn; },
    querySelectorAll: () => switches };
  const switches = ['true', 'false'].map(value => { const e = new Element(); e.dataset.autonomySwitch = value; return e; });
  const calls = [];
  vm.runInNewContext(source, { document, window: { addEventListener() {} }, AbortController,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ data: state }) }; } });
  document.start();
  return { nodes, switches, calls };
}
function state(taskState = 'waiting_ci') {
  return { enabled: false, revision: 7, active: null, tasks: [{ pipelineId: '0001', title: 'Synthetic <script> task',
    state: taskState, taskStatus: 'review', resumes: 1, authorized: true, nextAction: 'Observe exact commit',
    scope: ['source.py'], queueRequestId: KEY, manualInterventions: [{ kind: 'review_feedback', head: 'a'.repeat(40), at: 'synthetic-time' }],
    remaining: { workSeconds: 90, testSeconds: 90, modelSeconds: 90, modelCalls: 7, ciSeconds: 90 },
    runs: [{ requestId: KEY, finishedAt: 'synthetic-time', pendingInferenceCount: 0 }], observations: [],
    pr: { url: 'https://github.com/synthetic/repository/pull/42', number: 42, head: 'a'.repeat(40) } }] };
}
function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }
test('operator sees separate PR, CI, native completion, scope and manual intervention evidence', async () => {
  const { nodes } = setup(state()); await flush();
  const text = descendants(nodes.codingAutonomyTasks).map(n => n.textContent).join('\n');
  expect(text).toContain('worker finished'); expect(text).toContain('unresolved model requests 0');
  expect(text).toContain('source.py'); expect(text).toContain('manual interventions: 1');
  expect(text).toContain('PR published. CI not yet observed'); expect(text).toContain('product acceptance have no receipt');
  expect(text).toContain('Synthetic <script> task'); // textContent, never markup parsing.
});
test('switch requires explicit operator confirmation and uses the current durable revision', async () => {
  const { nodes, switches, calls } = setup(state()); await flush();
  switches[0].events.click(); await flush(); expect(calls).toHaveLength(1);
  nodes.codingAutonomyConfirm.checked = true; switches[0].events.click(); await flush();
  const mutation = calls.find(call => call.options.method === 'POST');
  expect(JSON.parse(mutation.options.body)).toEqual({ enabled: true, confirm: true, expectedRevision: 7 });
});
test('cancel waiting targets only the current task/request and explains that future corrections stop', async () => {
  const { nodes, calls } = setup(state()); await flush(); nodes.codingAutonomyConfirm.checked = true;
  const button = descendants(nodes.codingAutonomyTasks).find(n => n.textContent === 'Cancel waiting and future corrections');
  expect(button).toBeDefined(); button.events.click(); await flush();
  expect(calls.find(call => call.options.method === 'POST').url).toBe(`/api/pipeline/coding-autonomy/tasks/0001/runs/${KEY}/stop`);
});
