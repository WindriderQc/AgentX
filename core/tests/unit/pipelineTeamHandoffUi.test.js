'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadPipelineParts } = require('../helpers/pipelineScripts');

function fixture() {
  const body = { innerHTML: '', scrollTop: 0, querySelectorAll: () => [], querySelector: () => null };
  const document = { addEventListener() {}, getElementById: id => id === 'pipelineDrawerBody' ? body : null };
  const Toast = { info: jest.fn(), success: jest.fn(), error: jest.fn() };
  const fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { ready: true } }) });
  const context = { window: { location: { search: '' }, setTimeout, clearTimeout }, document, Toast, fetch, URLSearchParams, AbortController,
    FormData: class { get() { return 'Save a first report, then extend the verified findings.'; } } };
  loadPipelineParts(context);
  const source = fs.readFileSync(path.resolve(__dirname, '../../public/js/pipeline.js'), 'utf8');
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, 'loadTasks = async () => {}; globalThis.handoffTest = { state, giveTaskToTeam, handleDrawerAction, renderDrawer };\n})();'), context);
  const api = context.handoffTest;
  api.state.drawer.pipelineId = '0700';
  api.state.drawer.task = { pipelineId: '0700', title: 'Documentation review', status: 'queued', feedback: [] };
  const controller = { refresh: jest.fn().mockResolvedValue(undefined), launch: jest.fn().mockResolvedValue(true), lastSubmission: { requestId: 'new-request', pipelineId: '0700' }, control: { run: { requestId: 'new-request', pipelineId: '0700', phase: 'accepted' } }, error: null };
  api.state.launchController = controller;
  return { ...api, controller, fetch, Toast, body };
}

test('a handoff prepares the exact task before refreshing admission and launching once', async () => {
  const f = fixture();
  await f.giveTaskToTeam('0700');
  expect(JSON.parse(f.fetch.mock.calls[0][1].body)).toEqual({ pipelineId: '0700', answer: '' });
  expect(f.controller.refresh).toHaveBeenCalledTimes(1);
  expect(f.controller.launch).toHaveBeenCalledWith('0700');
  expect(f.Toast.success).toHaveBeenCalledWith('Task 0700 handed to the team.');
});

test.each([
  { launched: false, error: 'Host status unavailable' },
  { launched: true, error: 'Response lost. Checking the same request; nothing was resubmitted.' },
  { launched: true, phase: 'rejected', message: 'Task admission changed' },
  { launched: true, phase: 'not_received', message: 'Launch not yet received; reconcile this request.' },
])('a failed or uncertain handoff remains visible inside the drawer: %j', async scenario => {
  const f = fixture();
  f.controller.launch.mockResolvedValue(scenario.launched);
  f.controller.error = scenario.error || null;
  Object.assign(f.controller.control.run, scenario);
  await f.handleDrawerAction('give-to-team', null);
  expect(f.Toast.success).not.toHaveBeenCalled();
  expect(f.state.drawer.actionError.message).toBe(scenario.error || scenario.message);
  expect(f.body.innerHTML).toContain('role="alert"');
  expect(f.body.innerHTML).toContain(scenario.error || scenario.message);
  f.renderDrawer(f.state.drawer.task, { preserveDraft: true });
  expect(f.body.innerHTML).toContain('role="alert"');
  expect(f.controller.launch).toHaveBeenCalledTimes(1);
});

test('an admission refusal makes no success claim and a preparation conflict never launches', async () => {
  const f = fixture();
  f.fetch.mockResolvedValue({ ok: false, json: async () => ({ message: 'Another worker owns this task.' }) });
  await expect(f.giveTaskToTeam('0700')).rejects.toThrow('Another worker owns this task.');
  expect(f.controller.launch).not.toHaveBeenCalled();
  expect(f.Toast.success).not.toHaveBeenCalled();
});
test('a finished receipt for an older execution of the same task cannot certify a new handoff', async () => {
  const f = fixture();
  f.controller.control.run = { requestId: 'old-request', pipelineId: '0700', phase: 'finished' };
  await f.handleDrawerAction('give-to-team', null);
  expect(f.Toast.success).not.toHaveBeenCalled();
  expect(f.state.drawer.actionError.message).toContain('new launch has not been confirmed');
  expect(f.controller.launch).toHaveBeenCalledTimes(1);
});

const stoppedObservation = () => ({ schema: 'agentx.pipeline-worker-outcome/v1', requestId: '11111111-2222-4333-8444-555555555555',
  pipelineId: '0700', claimSeq: 2, result: 'blocked', reason: 'no_useful_progress', source: 'worker_report',
  startedAt: new Date(Date.now() - 2700000).toISOString(), finishedAt: new Date().toISOString(), usage: { workSeconds: 2700, modelCalls: 20 } });
test.each(['unknown', 'finished'])('resume rechecks the original native request before any preparation: %s', async phase => {
  const f = fixture(); const observation = stoppedObservation();
  Object.assign(f.state.drawer.task, { status: 'blocked', assignee: 'coding-team',
    transitions: [{ kind: 'claimed', seq: 2, at: observation.startedAt }], feedback: [{ workerOutcome: observation, text: 'Raw reasoning', by: 'coding-team' }] });
  const native = { available: true, observedAt: new Date().toISOString(), busy: false, run: {
    phase, requestId: observation.requestId, pipelineId: '0700', progress: { ...observation,
      phase, stopReason: observation.reason, activityAt: observation.finishedAt } } };
  f.fetch.mockImplementation(async url => ({ ok: true, json: async () => ({ data: url.includes('coding-dispatch/status') ? native : { ready: true } }) }));
  await f.handleDrawerAction('reply-resume', null);
  expect(f.fetch.mock.calls[0][0]).toContain(`requestId=${observation.requestId}`);
  const writes = f.fetch.mock.calls.filter(([, options]) => options?.method === 'POST');
  if (phase === 'unknown') {
    expect(writes).toHaveLength(0); expect(f.controller.launch).not.toHaveBeenCalled();
    expect(f.state.drawer.actionError.message).toContain('not been confirmed');
  } else {
    expect(writes).toHaveLength(1); expect(f.controller.launch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writes[0][1].body).answer).toContain('Save a first report');
  }
  expect(f.body.innerHTML).toContain('Stopped without saved progress');
  expect(f.body.innerHTML).not.toContain('Your team needs an answer');
  expect(f.body.innerHTML).toContain('<summary>Technical details and history</summary>');
});

test('a failed native reread cannot reuse a previously finished cached receipt', async () => {
  const f = fixture(); const observation = stoppedObservation();
  Object.assign(f.state.drawer.task, { status: 'blocked', assignee: 'coding-team',
    transitions: [{ kind: 'claimed', seq: 2, at: observation.startedAt }], feedback: [{ workerOutcome: observation }] });
  f.state.drawer.workerControl = { available: true, observedAt: new Date().toISOString(), busy: false,
    run: { phase: 'finished', requestId: observation.requestId, pipelineId: '0700', progress: {
      ...observation, phase: 'finished', stopReason: observation.reason, activityAt: observation.finishedAt } } };
  f.fetch.mockRejectedValue(new Error('Native read failed'));
  await f.handleDrawerAction('reply-resume', null);
  expect(f.state.drawer.workerControl).toBeNull(); expect(f.controller.launch).not.toHaveBeenCalled();
  expect(f.fetch.mock.calls).toHaveLength(1); expect(f.Toast.success).not.toHaveBeenCalled();
});
