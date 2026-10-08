'use strict';
const vm = require('vm');
const { readPipelineScript } = require('../helpers/pipelineScripts');

function render(progress, phase = 'running') {
  const elements = Object.fromEntries(['State', 'Detail', 'Task', 'Confirm', 'Button', 'Result'].map(name =>
    [`pipelineTeamLaunch${name}`, { dataset: {}, value: '', textContent: '', innerHTML: '' }]));
  const window = {};
  vm.runInNewContext(readPipelineScript('pipeline-delivery.js'), { window, URL });
  const control = { available: true, busy: phase === 'running', candidates: [], run: {
    pipelineId: '0001', phase, progress, message: 'Synthetic fixture' } };
  window.PipelineDelivery.create({
    $: id => elements[id], state: { launchController: { control } },
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

test('a stopped blocked attempt and an unknown host are never presented as successful delivery', () => {
  const progress = { stage: 'checkpoint', result: 'blocked', stopReason: 'soft_budget_no_progress' };
  expect(render(progress, 'finished').pipelineTeamLaunchState.textContent).toContain('Blocked');
  expect(render(progress, 'unknown').pipelineTeamLaunchState.textContent).toContain('Host outcome unknown');
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
