'use strict';
const vm = require('vm');
const { readPipelineScript } = require('../helpers/pipelineScripts');

function setup(progress, phase = 'running', extra = {}) {
  const elements = Object.fromEntries(['State', 'Detail', 'Task', 'Confirm', 'Button', 'Result', 'Stop', 'Availability', 'Progress'].map(name =>
    [`pipelineTeamLaunch${name}`, { dataset: {}, value: '', textContent: '', innerHTML: '' }]));
  elements.pipelineTeamAdmissionDetail = { textContent: '', innerHTML: '' };
  const window = {};
  vm.runInNewContext(readPipelineScript('pipeline-delivery.js'), { window, URL });
  const control = { available: true, busy: phase === 'running', candidates: [], run: {
    pipelineId: '0001', phase, progress, message: 'Synthetic fixture' }, ...extra };
  const controller = { control, pending: phase === 'finished' ? null : { pipelineId: '0001' }, canStop: () => control.run.canStop === true };
  const api = window.PipelineDelivery.create({
    $: id => elements[id], state: { launchController: controller },
    escapeHtml: value => String(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    formatDate: value => value, formatStatus: value => value
  });
  api.renderDispatchControl();
  return { elements, controller, draw: api.renderDispatchControl };
}
const render = (...args) => setup(...args).elements;

test('shows heartbeat, useful progress, budgets, test result and checkpoint separately', () => {
  const elements = render({ stage: 'test', heartbeatAt: '2026-10-08T12:01:00Z', progressAt: '2026-10-08T12:00:00Z',
    softRemainingSeconds: 1800, hardRemainingSeconds: 9000, currentTest: 'jest',
    lastTest: { name: 'pytest', outcome: 'failed' }, checkpoint: 'a'.repeat(40) });
  expect(elements.pipelineTeamLaunchState.textContent).toContain('Tests running');
  expect(elements.pipelineTeamLaunchDetail.textContent).toContain('Host heartbeat: 2026-10-08T12:01:00Z');
  expect(elements.pipelineTeamLaunchDetail.textContent).toContain('Last useful progress: 2026-10-08T12:00:00Z');
  expect(elements.pipelineTeamLaunchDetail.textContent).toContain('Soft budget: 30 min');
  expect(elements.pipelineTeamLaunchDetail.textContent).toContain('Hard budget: 150 min');
  expect(elements.pipelineTeamLaunchDetail.textContent).toContain('pytest failed');
  expect(elements.pipelineTeamLaunchDetail.textContent).toContain('Local checkpoint: aaaaaaaaaaaa');
});

test('a historical blocked attempt stays in its receipt and an unknown host stays visible', () => {
  const progress = { stage: 'checkpoint', result: 'blocked', stopReason: 'soft_budget_no_progress' };
  expect(render(progress, 'finished').pipelineTeamLaunchState.textContent).toContain('finished');
  expect(render(progress, 'unknown').pipelineTeamLaunchState.textContent).toContain('Host outcome unknown');
});

test('offers Stop worker only for the current stoppable request and shows a pending stop', () => {
  const active = render({}, 'running', { run: { pipelineId: '0001', phase: 'running', canStop: true } }).pipelineTeamLaunchStop;
  expect(active.hidden).toBe(false);
  expect(active.disabled).toBe(false);
  expect(active.textContent).toBe('Stop worker #0001');
  const stopping = render({}, 'stopping', { run: { pipelineId: '0001', phase: 'stopping', canStop: false } }).pipelineTeamLaunchStop;
  expect(stopping.hidden).toBe(false);
  expect(stopping.disabled).toBe(true);
  expect(stopping.textContent).toBe('Stopping worker…');
  expect(render({}, 'finished').pipelineTeamLaunchStop.hidden).toBe(true);
});

test('a completed earlier task cannot replace current admission or disable a new candidate', () => {
  const elements = render({ stage: 'publishing', result: 'review', heartbeatAt: '2026-10-08T12:01:00Z' }, 'finished', {
    observedAt: '2026-10-09T12:00:00Z',
    candidates: [{ pipelineId: '0002', title: 'Next synthetic task' }],
    summary: { queuedTasks: 2, eligibleTasks: 1, privateQueuedTasks: 1 }
  });
  expect(elements.pipelineTeamLaunchState.textContent).toContain('Task 0001 · finished');
  expect(elements.pipelineTeamLaunchAvailability.textContent).toContain('1 eligible task');
  expect(elements.pipelineTeamAdmissionDetail.textContent).toContain('1 of 2 queued tasks eligible');
  expect(elements.pipelineTeamLaunchTask.disabled).toBe(false);
  expect(elements.pipelineTeamLaunchTask.innerHTML).toContain('0002');
  expect(elements.pipelineTeamLaunchResult.hidden).toBe(false);
  expect(elements.pipelineTeamLaunchResult.innerHTML).toContain('0001');
});

test('a status refresh preserves consent for the same candidate while disabling submission until it completes', () => {
  const { elements, controller, draw } = setup(null, 'finished', { candidates: [{ pipelineId: '0002', title: 'Synthetic task' }] });
  elements.pipelineTeamLaunchTask.value = '0002';
  draw();
  elements.pipelineTeamLaunchConfirm.checked = true;
  controller.checking = true; draw();
  expect(elements.pipelineTeamLaunchConfirm.checked).toBe(true);
  expect(elements.pipelineTeamLaunchButton.disabled).toBe(true);
  controller.checking = false; draw();
  expect(elements.pipelineTeamLaunchTask.value).toBe('0002');
  expect(elements.pipelineTeamLaunchButton.disabled).toBe(false);
  controller.control.candidates[0].expectedAttemptCount = 1; draw();
  expect(elements.pipelineTeamLaunchConfirm.checked).toBe(false);
  expect(elements.pipelineTeamLaunchButton.disabled).toBe(true);
  controller.control.candidates = []; draw();
  expect(elements.pipelineTeamLaunchConfirm.checked).toBe(false);
  expect(elements.pipelineTeamLaunchButton.disabled).toBe(true);
});

test('live progress and worker identifiers stay out of the launch availability message', () => {
  const elements = render({ stage: 'test', heartbeatAt: '2026-10-08T12:01:00Z', softRemainingSeconds: 120 });
  expect(elements.pipelineTeamLaunchAvailability.textContent).toBe('A run is already active. Follow it in the execution monitor.');
  expect(elements.pipelineTeamLaunchProgress.innerHTML).toContain('<dt>Host heartbeat</dt>');
  expect(elements.pipelineTeamLaunchProgress.innerHTML).toContain('<dd>2 min</dd>');
});

test('untrusted labels, raw fields and injected markup do not enter progress text or HTML', () => {
  const privateText = '<img src=x onerror=privateFixture>';
  const elements = render({ stage: privateText, currentTest: privateText, heartbeatAt: privateText,
    progressAt: privateText, lastTest: { name: privateText, outcome: privateText },
    stopReason: privateText, checkpoint: privateText, rawOutput: privateText, command: privateText });
  for (const element of Object.values(elements)) {
    expect(element.textContent).not.toContain('privateFixture');
    expect(element.innerHTML).not.toContain('privateFixture');
  }
});
