'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { loadPipelineParts } = require('../helpers/pipelineScripts');
const read = name => fs.readFileSync(path.resolve(__dirname, '../../public/js', name), 'utf8');
const escape = value => String(value).replace(/[<>&"]/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[character]));
function task(pipelineId, extra = {}) {
  return { pipelineId, title: pipelineId, service: 'agentx-coding', status: 'blocked', dependsOn: [], timeline: [], ...extra };
}
const archive = { disposition: { kind: 'qualification', outcome: 'abandoned', reason: 'UNKNOWN retained' } };
function board(tasks) {
  const nodes = {}, context = { window: {}, document: { querySelectorAll: () => [] } };
  vm.runInNewContext(read('pipeline-board.js'), context);
  const state = { tasks, filters: {}, expandedStages: new Set(), view: 'board', includeDone: true, includeArchivedQualifications: false };
  const api = context.window.PipelineBoard.create({ state, $: id => nodes[id] ||= {}, sortTasks: rows => rows,
    matchesContext: () => true, matchesFilters: row => !state.filters.status || row.status === state.filters.status,
    escapeHtml: escape, formatStatus: value => value, statusBadge: value => value, priorityChip: () => '', isStale: () => false,
    STATUS_ORDER: ['blocked', 'done'], hasActiveFilters: () => Boolean(state.filters.status), summaryCount: (_name, fallback) => fallback,
    unmetDependencies: (row, byId) => row.dependsOn.filter(id => byId.get(id)?.status !== 'done'), riskChip: () => '', dueCell: () => '', activityCell: () => '' });
  return { api, state, nodes };
}
test('archived qualifications leave active rows and board while dependent work stays blocked', () => {
  const rows = [task('0001', { codingAutonomy: archive }), task('0002', { dependsOn: ['0001'] })];
  const original = JSON.stringify(rows), { api, state, nodes } = board(rows);
  api.renderProgression(); api.renderOpenWork();
  expect(nodes.pipelineProgression.innerHTML).not.toContain('data-pipeline-task="0001"');
  expect(nodes.pipelineOpenRows.innerHTML).not.toContain('data-pipeline-task="0001"');
  expect(nodes.pipelineOpenRows.innerHTML).toContain('waits on 0001');
  expect(nodes.pipelineOverviewMeta.textContent).toContain('1 archived qualification hidden');
  expect(nodes.pipelineOpenMeta.textContent).toContain('2 open tasks across 2 exact all-time records');
  state.filters.status = 'blocked'; api.renderProgression();
  expect(nodes.pipelineProgression.innerHTML).not.toContain('data-pipeline-task="0001"');
  state.includeArchivedQualifications = true; api.renderProgression(); api.renderOpenWork();
  expect(nodes.pipelineProgression.innerHTML).toContain('data-pipeline-task="0001"');
  expect(nodes.pipelineProgression.innerHTML).toContain('Archived qualification · abandoned');
  expect(nodes.pipelineOpenRows.innerHTML).toContain('data-pipeline-task="0001"');
  expect(JSON.stringify(rows)).toBe(original);
});
test('timeline history remains available without changing recorded dates or statuses', () => {
  const { api, state, nodes } = board([task('0001', { codingAutonomy: archive, timeline: [{ at: '2030-01-01T00:00:00Z', label: 'Original blocked result' }] })]);
  state.view = 'timeline'; api.renderProgression();
  expect(nodes.pipelineProgression.innerHTML).not.toContain('Original blocked result');
  state.includeArchivedQualifications = true; state.timelineLimit = 60;
  // Timeline dates use the same formatter supplied by the actual page.
  const context = { window: {}, document: { querySelectorAll: () => [] } };
  vm.runInNewContext(read('pipeline-board.js'), context);
  const realBoard = context.window.PipelineBoard.create({ state, $: id => nodes[id] ||= {}, sortTasks: value => value,
    matchesContext: () => true, matchesFilters: () => true, escapeHtml: escape, formatDate: value => value,
    statusBadge: value => value });
  realBoard.renderProgression();
  expect(nodes.pipelineProgression.innerHTML).toContain('Original blocked result');
  expect(nodes.pipelineProgression.innerHTML).toContain('2030-01-01T00:00:00Z');
  expect(nodes.pipelineProgression.innerHTML).toContain('Archived qualification · abandoned');
  expect(state.tasks[0].status).toBe('blocked');
});
test.each(['blocked', 'review'])('an archived %s dossier preserves its receipts and offers no resume or product acceptance', status => {
  const body = { innerHTML: '' }, state = { drawer: {} }, context = { window: {} };
  vm.runInNewContext(read('pipeline-dossier-activity.js'), context);
  vm.runInNewContext(read('pipeline-drawer.js'), context);
  const api = context.window.PipelineDrawer.create({ state, drawerEls: () => ({ body }), readStorage: () => '',
    reviewContext: () => ({ label: 'Archived qualification', detail: 'UNKNOWN retained', action: 'Read original receipts' }),
    escapeHtml: escape, statusBadge: value => value, priorityChip: () => '', riskChip: () => '', latestTeamUpdate: () => 'Original result',
    metaRow: () => '', formatDate: () => '', relativeTime: () => '', renderAttemptDossier: () => '<p>UNKNOWN original receipt</p>' });
  api.renderDrawer(task('0001', { status, codingAutonomy: archive, feedback: [{ text: 'Original result' }] }));
  expect(body.innerHTML).toContain('UNKNOWN original receipt');
  expect(body.innerHTML).toContain('Archived qualification · abandoned');
  for (const action of ['reply-resume', 'confirm-done', 'request-correction', 'requeue', 'supersede-preview'])
    expect(body.innerHTML).not.toContain(`data-drawer-action="${action}"`);
  expect(body.innerHTML).not.toContain('Your team needs an answer');
  expect(body.innerHTML).toContain('data-drawer-action="add-note"');
});
test('summary normalization retains only qualification metadata and archive switch updates both views', () => {
  const document = { addEventListener() {}, getElementById: () => null }, context = { document, window: { location: { search: '' } }, URLSearchParams };
  loadPipelineParts(context);
  vm.runInNewContext(read('pipeline.js').replace(/\}\)\(\);\s*$/, 'globalThis.archiveTest = { normalizePayload, state };\n})();'), context);
  const payload = context.archiveTest.normalizePayload({ data: { tasks: [task('0001', { codingAutonomy: { ...archive, runs: [{ private: 'excluded' }] } })] } });
  expect(payload.tasks[0].codingAutonomy).toEqual({ disposition: { kind: 'qualification', outcome: 'abandoned' } });
  expect(context.archiveTest.state.includeArchivedQualifications).toBe(false);
  expect(read('pipeline.js')).toContain('state.includeArchivedQualifications = event.target.checked; renderProgression(); renderOpenWork(); renderRecentlyDone();');
});
