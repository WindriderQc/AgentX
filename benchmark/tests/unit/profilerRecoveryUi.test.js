'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const panel = { querySelectorAll: () => [], contains: () => false };
const window = {};
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../public/js/model-profiler/recovery.js'), 'utf8'), {
  window, document: { getElementById: () => panel }, Date
});
const view = fields => ({ schema: 'agentx.profiler-recovery-view/v1', observedAt: new Date().toISOString(), operations: [], ...fields });
test.each([null, view({ observedAt: new Date(Date.now() - 120000).toISOString() }), view({ observedAt: new Date(Date.now() + 120000).toISOString() })])('missing or stale recovery views remain visible and unknown', value => {
  expect(window.ProfilerRecovery.render(value)).toEqual({ unknown: true });
  expect(panel.hidden).toBe(false); expect(panel.innerHTML).toContain('Runtime recovery status unknown');
});
test('an empty current view hides the panel while overflow cannot clear it', () => {
  expect(window.ProfilerRecovery.render(view())).toEqual({ pending: 0, attention: 0, unknown: false });
  expect(panel.hidden).toBe(true);
  expect(window.ProfilerRecovery.render(view({ truncated: true })).unknown).toBe(true);
  expect(panel.hidden).toBe(false);
});
test('renders interrupted operations with escaped identifiers and no effect controls', () => {
  expect(window.ProfilerRecovery.render(view({ operations: [{ hostId: 'synthetic', hostLabel: '<synthetic>', operationId: '<operation>',
    unresolved: true, attention: true, label: 'Runtime request outcome unknown', action: 'Inspect terminality', serverTerminalObserved: false }] }))).toEqual({ pending: 1, attention: 1, unknown: false });
  expect(panel.innerHTML).toContain('&lt;synthetic&gt;'); expect(panel.innerHTML).toContain('&lt;operation&gt;');
  expect(panel.innerHTML).toContain('Not recorded; runtime activity remains unknown');
  expect(panel.innerHTML).not.toContain('<button');
});
