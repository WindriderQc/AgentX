'use strict';
const vm = require('vm');
const { readPipelineScript } = require('../helpers/pipelineScripts');

function render(progress, phase = 'running', extra = {}) {
  const elements = Object.fromEntries(['State', 'Detail', 'Task', 'Confirm', 'Button', 'Result', 'Stop'].map(name =>
    [`pipelineTeamLaunch${name}`, { dataset: {}, value: '', textContent: '', innerHTML: '' }]));
  const window = {};
  vm.runInNewContext(readPipelineScript('pipeline-delivery.js'), { window, URL });
  const control = { available: true, busy: phase === 'running', candidates: [], run: {
    pipelineId: '0001', phase, progress, message: 'Synthetic fixture' }, ...extra };
  window.PipelineDelivery.create({
    $: id => elements[id], state: { launchController: { control, pending: phase === 'finished' ? null : { pipelineId: '0001' }, canStop: () => control.run.canStop === true } },
    escapeHtml: value => String(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    formatDate: value => value, formatStatus: value => value
  }).renderDispatchControl();
  return elements;
}

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
  expect(render(progress, 'finished').pipelineTeamLaunchState.textContent).toContain('Host observed');
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
  expect(elements.pipelineTeamLaunchState.textContent).toBe('Host observed 2026-10-09T12:00:00Z · one local coding worker');
  expect(elements.pipelineTeamLaunchState.textContent).not.toContain('0001');
  expect(elements.pipelineTeamLaunchDetail.textContent).toContain('1 of 2 queued tasks eligible');
  expect(elements.pipelineTeamLaunchTask.disabled).toBe(false);
  expect(elements.pipelineTeamLaunchTask.innerHTML).toContain('0002');
  expect(elements.pipelineTeamLaunchResult.hidden).toBe(false);
  expect(elements.pipelineTeamLaunchResult.innerHTML).toContain('0001');
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
