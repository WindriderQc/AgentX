'use strict';
const vm = require('vm');
const fs = require('node:fs');
const path = require('node:path');
const { readPipelineScript } = require('../helpers/pipelineScripts');
const Monitor = require('../../public/js/pipeline-worker-monitor');
const ID = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const NOW = Date.parse('2026-10-08T12:02:00Z');

function fixture(progress = {}, phase = 'running', extra = {}) {
  const run = { requestId: ID, pipelineId: '0001', phase, canStop: phase === 'running',
    expectedAttemptCount: 8, progress: { requestId: ID, pipelineId: '0001', ...progress } };
  const control = { available: true, busy: !['finished', 'rejected', 'stopped'].includes(phase), candidates: [],
    observedAt: '2026-10-08T12:01:45Z', run, ...extra };
  const controller = { control, pending: ['finished', 'stopped', 'rejected'].includes(phase) ? null : { requestId: ID, pipelineId: '0001' },
    canStop: jest.fn(() => control.run?.canStop === true), stop: jest.fn(), refresh: jest.fn() };
  return { controller, now: NOW };
}

function monitorElements() {
  const ids = ['pipelineWorkerMonitor', 'pipelineTeamLaunchState', 'pipelineWorkerMonitorEvidence', 'pipelineWorkerMonitorNote',
    'pipelineWorkerMonitorDossier', 'pipelineTeamLaunchRefresh', 'pipelineTeamLaunchStop'];
  return Object.fromEntries(ids.map(id => [id, { dataset: {}, textContent: '', innerHTML: '', removeAttribute(name) { delete this[name]; } }]));
}

function renderMonitor(f) {
  const elements = monitorElements();
  Monitor.render({ $: id => elements[id], ...f });
  return elements;
}

function setup(progress, phase = 'running', extra = {}) {
  const f = fixture(progress, phase, extra);
  const elements = { ...monitorElements(), ...Object.fromEntries(['Detail', 'Task', 'Confirm', 'Button', 'Result', 'Availability'].map(name =>
    [`pipelineTeamLaunch${name}`, { dataset: {}, value: '', textContent: '', innerHTML: '', checked: false }])) };
  elements.pipelineTeamAdmissionDetail = { textContent: '' };
  const window = { PipelineWorkerMonitor: Monitor };
  vm.runInNewContext(readPipelineScript('pipeline-delivery.js'), { window, URL });
  const api = window.PipelineDelivery.create({ $: id => elements[id], state: { launchController: f.controller },
    escapeHtml: value => String(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;'), formatDate: value => value, formatStatus: value => value
  });
  api.renderDispatchControl();
  return { elements, controller: f.controller, draw: api.renderDispatchControl };
}

test('a running receipt separates observed age, host liveness, useful work, budgets, tests and checkpoint', () => {
  const elements = renderMonitor(fixture({ stage: 'test', heartbeatAt: '2026-10-08T12:01:00Z', progressAt: '2026-10-08T12:00:00Z',
    softRemainingSeconds: 1800, hardRemainingSeconds: 9000, currentTest: 'jest', modelCalls: 4,
    lastTest: { name: 'pytest', outcome: 'failed' }, checkpoint: 'a'.repeat(40) }));
  const evidence = elements.pipelineWorkerMonitorEvidence.innerHTML;
  expect(evidence).toContain('Tests running');
  expect(evidence).toContain('15s ago (browser clock)');
  expect(evidence).toContain('2026-10-08T12:01:00Z · 1 min ago');
  expect(evidence).toContain('2026-10-08T12:00:00Z · 2 min ago');
  expect(evidence).toContain('30 min remaining');
  expect(evidence).toContain('150 min remaining');
  expect(evidence).toContain('pytest failed');
  expect(evidence).toContain('aaaaaaaaaaaa');
  expect(elements.pipelineWorkerMonitorDossier.href).toBe('/pipeline?task=0001');
});

test('attempt identity requires the dossier request binding and never adds one to the pre-launch count', () => {
  const f = fixture({}, 'running', { inference: { pipelineId: '0001', attempt: 9 }, run: { requestId: ID, pipelineId: '0001',
    phase: 'running', expectedAttemptCount: 8, task: { pipelineId: '0001', automationAttemptCount: 9 } } });
  expect(Monitor.observation(f.controller, undefined, NOW).attempt).toBeNull();
  f.task = { pipelineId: '0001', evidenceReferences: { schema: 'agentx.pipeline-evidence-references/v1', pipelineId: '0001',
    attempts: [{ attempt: 7, current: false, request: { status: 'recorded', requestId: ID } }] } };
  const elements = renderMonitor(f);
  expect(elements.pipelineWorkerMonitorEvidence.innerHTML).toContain('7 · historical in dossier');
  expect(elements.pipelineWorkerMonitorDossier.href).toBe('/pipeline?task=0001&attempt=7');
  f.task.evidenceReferences.attempts.push({ attempt: 9, request: { status: 'recorded', requestId: ID } });
  expect(Monitor.observation(f.controller, f.task, NOW).attempt).toBeNull();
  f.task.pipelineId = '0002';
  expect(Monitor.observation(f.controller, f.task, NOW).attempt).toBeNull();
});

test('the monitor shows an explicit report call budget and never invents one for a legacy receipt', () => {
  const extended=renderMonitor(fixture({modelCalls:128,modelCallLimit:256}));
  expect(extended.pipelineWorkerMonitorEvidence.innerHTML).toContain('128 / 256 · 128 remaining');
  const legacy=renderMonitor(fixture({modelCalls:128}));
  expect(legacy.pipelineWorkerMonitorEvidence.innerHTML).not.toContain('remaining</dd>');
  const malformed=renderMonitor(fixture({modelCalls:128,modelCallLimit:10000}));
  expect(malformed.pipelineWorkerMonitorEvidence.innerHTML).not.toContain('/ 10000');
});

test('completed receipts are historical and unknown host outcomes remain unresolved', () => {
  const progress = { stage: 'checkpoint', result: 'blocked', stopReason: 'soft_budget_no_progress' };
  const done = renderMonitor(fixture(progress, 'finished'));
  expect(done.pipelineTeamLaunchState.textContent).toBe('Last worker receipt');
  expect(done.pipelineWorkerMonitorEvidence.innerHTML).toContain('historical receipt');
  expect(done.pipelineTeamLaunchStop.hidden).toBe(true);
  const unknown = renderMonitor(fixture(progress, 'unknown'));
  expect(unknown.pipelineTeamLaunchState.textContent).toBe('Host outcome unknown');
  expect(unknown.pipelineWorkerMonitorNote.textContent).toContain('Reconcile this original request');
  expect(unknown.pipelineWorkerMonitorEvidence.innerHTML).toContain('soft budget no progress');
});

test('native retry observations require the exact current dossier attempt and never expose raw causes', () => {
  const f = fixture({}, 'running', { inference: { pipelineId: '0001', attempt: 7, state: 'waiting', requestCount: 3, attempts: 2, cause: 'privateFixture' } });
  expect(renderMonitor(f).pipelineWorkerMonitorEvidence.innerHTML).toContain('no current dossier binding');
  f.task = { pipelineId: '0001', evidenceReferences: { schema: 'agentx.pipeline-evidence-references/v1', pipelineId: '0001',
    attempts: [{ attempt: 7, current: true, request: { status: 'recorded', requestId: ID } }] } };
  const evidence = renderMonitor(f).pipelineWorkerMonitorEvidence.innerHTML;
  expect(evidence).toContain('Waiting to retry inference · 3 observed call(s) · call try 2/6');
  expect(evidence).not.toContain('privateFixture');
  f.controller.control.inference.attempt = 8;
  expect(renderMonitor(f).pipelineWorkerMonitorEvidence.innerHTML).not.toContain('Waiting to retry inference');
  f.controller.control.inference.attempt = 7;
  f.task.evidenceReferences.attempts[0].request.requestId = OTHER;
  expect(renderMonitor(f).pipelineWorkerMonitorEvidence.innerHTML).not.toContain('Waiting to retry inference');
  f.task.evidenceReferences.attempts[0].request.requestId = ID;
  f.task.evidenceReferences.attempts[0].current = false;
  expect(renderMonitor(f).pipelineWorkerMonitorEvidence.innerHTML).not.toContain('Waiting to retry inference');
});

test('Stop invokes the existing controller and stop acknowledgement never asserts release', () => {
  const f = fixture();
  const active = renderMonitor(f).pipelineTeamLaunchStop;
  expect(active.hidden).toBe(false);
  expect(active.disabled).toBe(false);
  expect(active.textContent).toBe('Stop worker #0001');
  active.onclick();
  expect(f.controller.stop).toHaveBeenCalledTimes(1);
  const stopping = renderMonitor(fixture({}, 'stopping'));
  expect(stopping.pipelineTeamLaunchStop.hidden).toBe(false);
  expect(stopping.pipelineTeamLaunchStop.disabled).toBe(true);
  expect(stopping.pipelineWorkerMonitorNote.textContent).toContain('Worker termination and native model/resource release remain unproven');
  expect(renderMonitor(f).pipelineTeamLaunchRefresh.onclick).toBeUndefined();
  expect(f.controller.refresh).not.toHaveBeenCalled();
});

test('a different host request cannot replace the retained browser request or expose a stop button', () => {
  const f = fixture({ stage: 'tool', checkpoint: 'a'.repeat(40) });
  f.controller.control.run.requestId = OTHER;
  const elements = renderMonitor(f);
  expect(elements.pipelineWorkerMonitorEvidence.innerHTML).toContain(ID);
  expect(elements.pipelineWorkerMonitorEvidence.innerHTML).not.toContain(OTHER);
  expect(elements.pipelineWorkerMonitorEvidence.innerHTML).not.toContain('aaaaaaaaaaaa');
  expect(elements.pipelineTeamLaunchStop.hidden).toBe(true);
  expect(elements.pipelineTeamLaunchState.textContent).toContain('Checking the original request');
});

test('a failed refresh retains the last evidence while disabling the native stop action', () => {
  const f = fixture({ stage: 'test' });
  f.controller.error = 'Host response lost';
  f.controller.canStop.mockReturnValue(false);
  const elements = renderMonitor(f);
  expect(elements.pipelineTeamLaunchState.textContent).toContain('last observation retained');
  expect(elements.pipelineWorkerMonitorEvidence.innerHTML).toContain(ID);
  expect(elements.pipelineTeamLaunchStop.disabled).toBe(true);
  const future = fixture({ heartbeatAt: '2026-10-08T12:03:00Z' });
  expect(renderMonitor(future).pipelineWorkerMonitorEvidence.innerHTML).toContain('age unknown (clock ahead)');
});

test('ordinary reconciliation does not change the announced worker state', () => {
  const f = fixture({ stage: 'test' });
  const before = Monitor.observation(f.controller, undefined, NOW);
  f.controller.checking = true;
  expect(Monitor.observation(f.controller, undefined, NOW).title).toBe(before.title);
});

test('unmatched progress and raw labels, commands, paths, transcripts and markup stay out of the monitor', () => {
  const privateText = '<img src=x onerror=privateFixture>';
  const f = fixture({ stage: privateText, currentTest: privateText, heartbeatAt: privateText,
    progressAt: privateText, lastTest: { name: privateText, outcome: privateText },
    stopReason: privateText, checkpoint: privateText, rawOutput: privateText, command: privateText, hostPath: privateText });
  f.controller.control.run.message = privateText;
  f.controller.control.run.phase = privateText;
  const elements = renderMonitor(f);
  for (const element of Object.values(elements)) {
    expect(element.textContent).not.toContain('privateFixture');
    expect(element.innerHTML).not.toContain('privateFixture');
  }
  f.controller.control.run.progress.requestId = OTHER;
  f.controller.control.run.progress.checkpoint = 'a'.repeat(40);
  expect(renderMonitor(f).pipelineWorkerMonitorEvidence.innerHTML).not.toContain('aaaaaaaaaaaa');
});

test('a completed earlier task cannot replace current admission or disable a new candidate', () => {
  const { elements } = setup({ stage: 'publishing', result: 'review' }, 'finished', {
    observedAt: '2026-10-09T12:00:00Z', candidates: [{ pipelineId: '0002', title: 'Next synthetic task' }],
    summary: { queuedTasks: 2, eligibleTasks: 1, privateQueuedTasks: 1 }
  });
  expect(elements.pipelineTeamLaunchState.textContent).toBe('Last worker receipt');
  expect(elements.pipelineTeamLaunchAvailability.textContent).toContain('1 eligible task');
  expect(elements.pipelineTeamAdmissionDetail.textContent).toContain('1 of 2 queued tasks eligible');
  expect(elements.pipelineTeamLaunchTask.disabled).toBe(false);
  expect(elements.pipelineTeamLaunchTask.innerHTML).toContain('0002');
  expect(elements.pipelineTeamLaunchResult.innerHTML).toContain('0001');
});

test('a status refresh preserves consent for the same candidate and changed identity clears it', () => {
  const { elements, controller, draw } = setup(null, 'finished', { candidates: [{ pipelineId: '0002', title: 'Synthetic task', expectedAttemptCount: 0 }] });
  elements.pipelineTeamLaunchTask.value = '0002'; draw();
  elements.pipelineTeamLaunchConfirm.checked = true;
  controller.checking = true; draw();
  expect(elements.pipelineTeamLaunchConfirm.checked).toBe(true);
  expect(elements.pipelineTeamLaunchButton.disabled).toBe(true);
  controller.checking = false; draw();
  expect(elements.pipelineTeamLaunchTask.value).toBe('0002');
  expect(elements.pipelineTeamLaunchButton.disabled).toBe(false);
  controller.control.candidates[0].title = 'Changed scope'; draw();
  expect(elements.pipelineTeamLaunchConfirm.checked).toBe(false);
  elements.pipelineTeamLaunchConfirm.checked = true;
  controller.control.candidates[0].expectedAttemptCount = 1; draw();
  expect(elements.pipelineTeamLaunchConfirm.checked).toBe(false);
  controller.control.candidates = []; draw();
  expect(elements.pipelineTeamLaunchConfirm.checked).toBe(false);
  expect(elements.pipelineTeamLaunchButton.disabled).toBe(true);
});

test('live progress and worker identifiers stay out of the launch availability message', () => {
  const { elements } = setup({ stage: 'test', heartbeatAt: '2026-10-08T12:01:00Z', softRemainingSeconds: 120 });
  expect(elements.pipelineTeamLaunchAvailability.textContent).toBe('A run is already active. Follow it in the execution monitor.');
  expect(elements.pipelineWorkerMonitorEvidence.innerHTML).toContain('<dt>Host heartbeat</dt>');
  expect(elements.pipelineWorkerMonitorEvidence.innerHTML).toContain('<dd>2 min remaining</dd>');
  expect(elements.pipelineTeamLaunchDetail.textContent).not.toContain('Host heartbeat');
});

test('Follow and decide contains one monitor and the original Stop control, separate from preparation', () => {
  const view = fs.readFileSync(path.resolve(__dirname, '../../views/pages/pipeline.ejs'), 'utf8');
  const partial = fs.readFileSync(path.resolve(__dirname, '../../views/partials/pipeline-worker-monitor.ejs'), 'utf8');
  expect(view.indexOf("include('../partials/pipeline-worker-monitor')")).toBeGreaterThan(view.indexOf('id="pipelineFollow"'));
  expect(view).toContain('id="pipelineWorkerMonitor"');
  expect(view).toContain('id="pipelineExecution"');
  expect(view).not.toContain('id="pipelineTeamLaunchProgress"');
  expect(view).not.toContain('id="pipelineTeamLaunchDossier"');
  expect(partial.match(/id="pipelineTeamLaunchStop"/g)).toHaveLength(1);
  expect(partial).not.toContain('<section');
  expect(view).toContain('aria-live="polite"');
  expect(readPipelineScript('pipeline-delivery.js')).not.toContain('stop.addEventListener');
});
