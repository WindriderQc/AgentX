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
  const context = { window: { location: { search: '' } }, document, Toast, fetch, URLSearchParams };
  loadPipelineParts(context);
  const source = fs.readFileSync(path.resolve(__dirname, '../../public/js/pipeline.js'), 'utf8');
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, 'globalThis.handoffTest = { state, giveTaskToTeam, handleDrawerAction, renderDrawer };\n})();'), context);
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
