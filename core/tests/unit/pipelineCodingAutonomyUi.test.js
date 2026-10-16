'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../public/js/pipeline-coding-autonomy.js'), 'utf8');
const KEY = '11111111-2222-4333-8444-555555555555';
class Element {
  constructor(text = '') { this.textContent = text; this.children = []; this.events = {}; this.dataset = {}; this.value = ''; this.checked = false; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(name, fn) { this.events[name] = fn; }
  setAttribute(name, value) { this[name] = value; }
  contains(node) { return descendants(this).includes(node); }
  querySelectorAll(selector) {
    return descendants(this).slice(1).filter(node => selector.split(',').some(part => {
      const match = part.trim().match(/^([a-z]+)(?:\[type="([a-z]+)"\])?$/);
      return match && node.tagName === match[1].toUpperCase() && (!match[2] || node.type === match[2]);
    }));
  }
}
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
function setup(state, options = {}) {
  let interval;
  const nodes = { codingAutonomyConfirm: new Element() };
  const document = { getElementById: id => nodes[id] ||= new Element(),
    createElement: tag => { const node = new Element(); node.tagName = tag.toUpperCase(); return node; }, addEventListener: (_name, fn) => { document.start = fn; },
    querySelectorAll: () => switches };
  const switches = ['true', 'false'].map(value => { const e = new Element(); e.dataset.autonomySwitch = value; return e; });
  const calls = [];
  vm.runInNewContext(source, { document, window: { addEventListener() {} }, AbortController,
    FormData: class {
      constructor(form) { this.values = form.values || {}; }
      get(name) { return this.values[name] ?? null; }
    },
    setTimeout: () => 1, clearTimeout() {}, setInterval: fn => { interval = fn; return 1; }, clearInterval() {},
    fetch: async (url, requestOptions) => {
      calls.push({ url, options: requestOptions });
      if (url.startsWith('/api/cluster/schedule/work-queue/')) return { ok: true, json: async () => ({ data: options.job }) };
      if (url.endsWith('/recover') && options.failRecoveryOnce) {
        options.failRecoveryOnce = false; return { ok: false, json: async () => ({ message: 'Reply lost; reconcile the same identity' }) };
      }
      return { ok: true, json: async () => ({ data: state }) };
    } });
  document.start();
  return { nodes, switches, calls, document, tick: () => interval() };
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
test('idle status separates blocked cards from work awaiting execution and keeps archived qualifications accessible', async () => {
  const snapshot = state('stopped'); Object.assign(snapshot.tasks[0], { taskStatus: 'blocked', authorized: false, disposition: { kind: 'qualification', outcome: 'abandoned' } });
  const { nodes } = setup(snapshot); await flush();
  expect(nodes.codingAutonomyStatus.textContent).toContain('0 authorized tasks waiting · 0 blocked');
  expect(descendants(nodes.codingAutonomyTasks).some(n => n.textContent.includes('Synthetic <script> task'))).toBe(false);
  expect(nodes.codingAutonomyArchiveTasks.hidden).toBe(true);
  descendants(nodes.codingAutonomyArchiveControls).find(n => n.textContent.startsWith('Show archived')).events.click();
  expect(nodes.codingAutonomyArchiveTasks.hidden).toBe(false);
  expect(descendants(nodes.codingAutonomyArchiveTasks).some(n => n.textContent.includes('Original execution outcomes'))).toBe(true);
  expect(descendants(nodes.codingAutonomyTasks).some(n => n.textContent.includes('Original execution outcomes'))).toBe(false);
});
test('merged PR and failed CI remain visible as separate facts without acceptance', async () => {
  const snapshot = state('ready_for_review'); snapshot.tasks[0].delivery = { merged: true, state: 'closed',
    headMatches: true, observedAt: 'synthetic-time', ci: 'failure', checks: [{ name: 'tests (core)', state: 'failure' }] };
  const { nodes } = setup(snapshot); await flush(); const text = descendants(nodes.codingAutonomyTasks).map(n => n.textContent).join('\n');
  expect(text).toContain('PR #42 · merged'); expect(text).toContain('CI failure on the published commit');
  expect(text).toContain('Human acceptance remains a separate decision'); expect(text).not.toContain('Draft PR');
});
test('reviewed continuation sends the original checkpoint and intent with explicit cumulative credits', async () => {
  const snapshot = state('stopped'), task = snapshot.tasks[0];
  Object.assign(task, { authorized: false, taskStatus: 'blocked', pr: null, authorizationRevision: 12,
    nativeAttemptCount: 3, nativeAttemptLimit: 3, automationFingerprint: 'b'.repeat(64), verificationProfile: 'agentx-core-runner-tests/v1' });
  task.runs[0].head = 'a'.repeat(40);
  const { nodes, calls } = setup(snapshot); await flush(); nodes.codingAutonomyConfirm.checked = true;
  const form = descendants(nodes.codingAutonomyTasks).find(n => n.events.submit && descendants(n).some(child => child.textContent === 'Record reviewed continuation'));
  expect(form).toBeDefined();
  const field = title => descendants(form).find(n => n.textContent === title).children[0];
  field('New approved coding campaign').value = KEY;
  descendants(form).find(n => n.textContent.startsWith('Correction based')).children[0].value = 'Fix the exact preserved test failure.';
  await form.events.submit({ preventDefault() {} }); await flush();
  const mutation = calls.find(call => call.options.method === 'POST');
  expect(mutation.url).toBe(`/api/pipeline/coding-autonomy/tasks/0001/runs/${KEY}/continuation`);
  expect(JSON.parse(mutation.options.body)).toMatchObject({ expectedRevision: 12, expectedNativeAttemptLimit: 3,
    nativeAttemptLimit: 4, expectedAutomationFingerprint: 'b'.repeat(64), head: 'a'.repeat(40), additionalRuns: 1,
    budget: { workSeconds: 3600, testSeconds: 900, modelSeconds: 1800, modelCalls: 32, ciSeconds: 900 } });
});
test('a merged PR offers authorization withdrawal and refuses another review correction in the UI', async () => {
  const snapshot = state('ready_for_review'); snapshot.tasks[0].delivery = { merged: true, state: 'closed',
    headMatches: true, ci: 'success', observedAt: 'synthetic-time', checks: [] };
  const { nodes } = setup(snapshot); await flush(); const text = descendants(nodes.codingAutonomyTasks).map(n => n.textContent);
  expect(text).toContain('Remove task authorization'); expect(text).not.toContain('Send correction to the Coding Team');
});
test.each(['workSeconds', 'testSeconds', 'modelSeconds', 'modelCalls', 'ciSeconds'])('only an exact zero %s budget is described as exhausted', async key => {
  const snapshot = state(); snapshot.tasks[0].remaining[key] = 0;
  const { nodes } = setup(snapshot); await flush();
  expect(descendants(nodes.codingAutonomyTasks).some(n => n.textContent.startsWith('Exhausted budgets:'))).toBe(true);
  const positive = state(); for (const field of Object.keys(positive.tasks[0].remaining)) positive.tasks[0].remaining[field] = 1;
  const live = setup(positive); await flush();
  expect(descendants(live.nodes.codingAutonomyTasks).some(n => n.textContent.startsWith('Exhausted budgets:'))).toBe(false);
});
test.each([false, true])('CI watch disclosure follows the Core fact %s, independently of the enabled switch', async active => {
  const snapshot = state('blocked'); snapshot.tasks[0].ciObservationActive = active;
  const { nodes } = setup(snapshot); await flush();
  expect(descendants(nodes.codingAutonomyTasks).some(n => n.textContent.startsWith('Core continues watching CI'))).toBe(active);
});
test('confirmed administrative recovery still describes historical UNKNOWN as uncertain', async () => {
  const snapshot = state('stopped'); snapshot.tasks[0].authorized = false;
  snapshot.tasks[0].runs[0] = { requestId: KEY, finishedAt: 'synthetic-time', pendingInferenceCount: 0,
    historicalPendingInferenceCount: 1, recovery: { state: 'confirmed', authority: 'operator-reconciliation' },
    modelReceipts: [{ state: 'unknown' }] };
  const { nodes } = setup(snapshot); await flush();
  const text = descendants(nodes.codingAutonomyTasks).map(n => n.textContent).join('\n');
  expect(text).toContain('An unknown or pending model receipt is an uncertain outcome');
  expect(text).toContain('does not make it successful or authorize another worker');
});
test('archive draft survives background refresh after focus moves to global confirmation and clears when values are restored', async () => {
  const snapshot = state('stopped'); snapshot.tasks[0].authorized = false;
  const view = setup(snapshot); await flush();
  const form = descendants(view.nodes.codingAutonomyTasks).find(node => node.events.submit && descendants(node).some(child => child.textContent === 'Archive qualification'));
  const reference = descendants(form).find(node => node.textContent === 'Private qualification receipt reference').children[0];
  reference.value = '/private/qualification.json'; form.events.input();
  view.document.activeElement = view.nodes.codingAutonomyConfirm;
  await view.tick(); await flush();
  expect(descendants(view.nodes.codingAutonomyTasks)).toContain(form); expect(reference.value).toBe('/private/qualification.json');
  expect(view.nodes.codingAutonomyStatus.textContent).toContain('once your edit is sent or cleared');
  reference.value = ''; form.events.input(); await view.tick(); await flush();
  expect(descendants(view.nodes.codingAutonomyTasks)).not.toContain(form);
});
test('switch requires explicit operator confirmation and uses the current durable revision', async () => {
  const { nodes, switches, calls } = setup(state()); await flush();
  switches[0].events.click(); await flush(); expect(calls).toHaveLength(1);
  nodes.codingAutonomyConfirm.checked = true; switches[0].events.click(); await flush();
  const mutation = calls.find(call => call.options.method === 'POST');
  expect(JSON.parse(mutation.options.body)).toEqual({ enabled: true, confirm: true, expectedRevision: 7 });
});
function authorizationValues(overrides) {
  const template = fs.readFileSync(path.join(__dirname, '../../views/partials/pipeline-coding-autonomy.ejs'), 'utf8');
  const html = require('ejs').render(template).match(/<form id="codingAutonomyAuthorize">([\s\S]*?)<\/form>/)[1];
  const values = {};
  for (const match of html.matchAll(/<(?:input|textarea|select)\b[^>]*\bname="([^"]+)"[^>]*>/g)) {
    values[match[1]] = match[0].match(/\bvalue="([^"]*)"/)?.[1] || '';
  }
  for (const name of Object.keys(overrides)) expect(values).toHaveProperty(name);
  expect(html).toContain(`<option value="${overrides.verificationProfile}">`);
  return { ...values, ...overrides };
}
test('authorization submits reduced cumulative budgets and the installed Benchmark verifier from the rendered form', async () => {
  const snapshot = state(); snapshot.tasks[0].authorizationRevision = 12;
  const { nodes, calls } = setup(snapshot); await flush();
  const form = nodes.codingAutonomyAuthorize;
  form.values = authorizationValues({ pipelineId: '0001', queueRequestId: KEY,
    scope: ' benchmark/src/services/benchmark/artifactComparison.js \n\nbenchmark/tests/unit/benchmark/artifactComparison.test.js',
    verificationProfile: 'agentx-benchmark-artifact-tests/v1', maxResumes: '0', workMinutes: '20',
    testMinutes: '5', modelMinutes: '10', modelCalls: '17', ciMinutes: '8', noProgressMinutes: '3' });
  form.events.submit({ target: form, preventDefault() {} }); await flush();
  expect(calls.some(call => call.options.method === 'POST')).toBe(false);
  nodes.codingAutonomyConfirm.checked = true;
  form.events.submit({ target: form, preventDefault() {} }); await flush();
  const mutation = calls.find(call => call.options.method === 'POST');
  expect(mutation.url).toBe('/api/pipeline/coding-autonomy/tasks/0001/authorization');
  const body = JSON.parse(mutation.options.body);
  expect(body).toMatchObject({ confirm: true, authorized: true, lowRisk: true, expectedRevision: 12,
    queueRequestId: KEY, verificationProfile: 'agentx-benchmark-artifact-tests/v1',
    scope: ['benchmark/src/services/benchmark/artifactComparison.js', 'benchmark/tests/unit/benchmark/artifactComparison.test.js'],
    limits: { maxResumes: 0, workSeconds: 1200, testSeconds: 300, modelSeconds: 600,
      modelCalls: 17, ciSeconds: 480, noProgressSeconds: 180 } });
  expect(require('../../src/services/pipelineCodingAutonomyPolicy').limits(body.limits)).toEqual(body.limits);
});
test('rendered authorization defaults match Core caps and invalid reduced model credit is refused', async () => {
  const { nodes, calls } = setup(state()); await flush(); nodes.codingAutonomyConfirm.checked = true;
  const form = nodes.codingAutonomyAuthorize;
  form.values = authorizationValues({ pipelineId: '0001', queueRequestId: KEY, scope: 'source.js',
    verificationProfile: 'agentx-core-runner-tests/v1' });
  form.events.submit({ target: form, preventDefault() {} }); await flush();
  const policy = require('../../src/services/pipelineCodingAutonomyPolicy');
  expect(JSON.parse(calls.find(call => call.options.method === 'POST').options.body).limits).toEqual(policy.DEFAULT_LIMITS);
  form.values.modelMinutes = '0';
  form.events.submit({ target: form, preventDefault() {} }); await flush();
  const latest = calls.filter(call => call.options.method === 'POST').at(-1);
  const limits = JSON.parse(latest.options.body).limits;
  expect(limits.modelSeconds).toBe(0);
  expect(() => policy.limits(limits)).toThrow(); // No default or extra model credit is substituted.
});
test('cancel waiting targets only the current task/request and explains that future corrections stop', async () => {
  const { nodes, calls } = setup(state()); await flush(); nodes.codingAutonomyConfirm.checked = true;
  const button = descendants(nodes.codingAutonomyTasks).find(n => n.textContent === 'Cancel waiting and future corrections');
  expect(button).toBeDefined(); button.events.click(); await flush();
  expect(calls.find(call => call.options.method === 'POST').url).toBe(`/api/pipeline/coding-autonomy/tasks/0001/runs/${KEY}/stop`);
});
test('recovery requires termination confirmation and reuses the exact received campaign proof after a lost response', async () => {
  const snapshot = state('blocked'); const task = snapshot.tasks[0]; task.authorized = false; task.authorizationRevision = 10;
  task.pr = null; task.runs[0] = { requestId: KEY, pendingInferenceCount: 1, unresolvedCallIds: [KEY] };
  const { nodes, calls } = setup(snapshot, { failRecoveryOnce: true,
    job: { releaseReceipt: { receiptRef: '/private/received.json', receiptSha256: 'b'.repeat(64) } } });
  await flush(); nodes.codingAutonomyConfirm.checked = true;
  const form = descendants(nodes.codingAutonomyTasks).find(n => n.events.submit && descendants(n).some(child => child.textContent === 'Reconcile this original execution'));
  expect(form).toBeDefined(); await form.events.submit({ preventDefault() {} }); await flush();
  expect(calls.some(call => call.options.method === 'POST')).toBe(false);
  const label = descendants(form).find(n => n.textContent.startsWith('I verified termination'));
  label.children[0].checked = true; await form.events.submit({ preventDefault() {} }); await flush();
  await form.events.submit({ preventDefault() {} }); await flush();
  const mutations = calls.filter(call => call.options.method === 'POST'); expect(mutations).toHaveLength(2);
  expect(mutations[0].options.body).toBe(mutations[1].options.body);
  expect(JSON.parse(mutations[0].options.body)).toEqual({ confirm: true,
    confirmation: 'ORIGINAL_WORKER_TERMINATED_AND_NATIVE_AUTHORITY_RELEASED', key: `coding-recovery:${KEY}`,
    expectedRevision: 10, callIds: [KEY], receiptRef: '/private/received.json', receiptSha256: 'b'.repeat(64) });
});
test('confirmed recovery keeps a finalization form while the original selection slot remains held', async () => {
  const snapshot = state('stopped'); const task = snapshot.tasks[0]; task.authorized = false; task.authorizationRevision = 14;
  task.pr = null; snapshot.active = { pipelineId: '0001', requestId: KEY };
  task.runs[0] = { requestId: KEY, finishedAt: 'synthetic-time', pendingInferenceCount: 0,
    historicalPendingInferenceCount: 1, unresolvedCallIds: [], recovery: { state: 'confirmed', authority: 'operator-reconciliation',
      key: `coding-recovery:${KEY}`, callIds: [KEY], receiptRef: '/private/received.json', receiptSha256: 'b'.repeat(64) } };
  const { nodes, calls } = setup(snapshot); await flush(); nodes.codingAutonomyConfirm.checked = true;
  expect(descendants(nodes.codingAutonomyTasks).some(n => n.textContent.includes('selection slot still held'))).toBe(true);
  const form = descendants(nodes.codingAutonomyTasks).find(n => n.events.submit && descendants(n).some(child => child.textContent === 'Finish this original recovery'));
  const label = descendants(form).find(n => n.textContent.startsWith('I verified termination')); label.children[0].checked = true;
  await form.events.submit({ preventDefault() {} }); await flush();
  const mutation = calls.find(call => call.options.method === 'POST');
  expect(JSON.parse(mutation.options.body)).toMatchObject({ callIds: [KEY], receiptRef: '/private/received.json',
    receiptSha256: 'b'.repeat(64), key: `coding-recovery:${KEY}` });
});
function stateWithRemaining(workSeconds, testSeconds, modelSeconds, modelCalls, ciSeconds) {
  const snapshot = state();
  snapshot.tasks[0].remaining = { workSeconds, testSeconds, modelSeconds, modelCalls, ciSeconds };
  return snapshot;
}
function remainingLine(nodes) {
  return descendants(nodes.codingAutonomyTasks).map(n => n.textContent).find(t => t.startsWith('Remaining:'));
}
test('sub-minute remaining budgets display exact positive seconds instead of zero minutes', async () => {
  const { nodes } = setup(stateWithRemaining(0, 1, 59, 7, 60)); await flush();
  expect(remainingLine(nodes)).toBe('Remaining: 0 min work, 1 sec tests, 59 sec model, 7 calls, 1 min CI');
});
test('remaining budgets of one minute or more keep whole minutes while mixed sub-minute fields stay in seconds', async () => {
  const { nodes } = setup(stateWithRemaining(60, 120, 60, 7, 59)); await flush();
  expect(remainingLine(nodes)).toBe('Remaining: 1 min work, 2 min tests, 1 min model, 7 calls, 59 sec CI');
});
test('remaining budgets keep minute and second precision for mixed fields above one minute', async () => {
  const { nodes } = setup(stateWithRemaining(61, 90, 3601, 7, 0)); await flush();
  expect(remainingLine(nodes)).toBe('Remaining: 1 min 1 sec work, 1 min 30 sec tests, 60 min 1 sec model, 7 calls, 0 min CI');
});
test('an API-created recovery key survives a lost fence acknowledgement in the operator form', async () => {
  const snapshot = state('blocked'); const task = snapshot.tasks[0]; task.authorized = false; task.pr = null;
  task.authorizationRevision = 10; task.runs[0] = { requestId: KEY, pendingInferenceCount: 1, unresolvedCallIds: [KEY] };
  snapshot.active = { pipelineId: '0001', requestId: KEY, recovery: { key: 'custom-api-recovery' } };
  const { nodes, calls } = setup(snapshot, { job: { releaseReceipt: { receiptRef: '/private/received.json', receiptSha256: 'b'.repeat(64) } } });
  await flush(); nodes.codingAutonomyConfirm.checked = true;
  const form = descendants(nodes.codingAutonomyTasks).find(n => n.events.submit && descendants(n).some(child => child.textContent === 'Reconcile this original execution'));
  const label = descendants(form).find(n => n.textContent.startsWith('I verified termination')); label.children[0].checked = true;
  await form.events.submit({ preventDefault() {} }); await flush();
  expect(JSON.parse(calls.find(call => call.options.method === 'POST').options.body).key).toBe('custom-api-recovery');
});
