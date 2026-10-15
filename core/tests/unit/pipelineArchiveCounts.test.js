'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { loadPipelineParts } = require('../helpers/pipelineScripts');
function fixture() {
  const nodes = {}, document = { addEventListener() {}, getElementById: id => nodes[id] ||= { classList: { add() {}, remove() {} } }, querySelectorAll: () => [] };
  const context = { window: { location: { search: '' } }, document, URLSearchParams };
  loadPipelineParts(context);
  const script = fs.readFileSync(path.resolve(__dirname, '../../public/js/pipeline.js'), 'utf8');
  vm.runInNewContext(script.replace(/\}\)\(\);\s*$/, 'globalThis.countsTest = { state, statusCounts, renderCounts, renderEvidence };\n})();'), context);
  const api = context.countsTest;
  api.state.summary = { byStatus: { queued: 4, in_progress: 0, review: 7, blocked: 5, done: 23 }, matchedCount: 39, openCount: 16, doneCount: 23,
    archivedQualifications: { byStatus: { queued: 1, in_progress: 0, review: 3, blocked: 2, done: 0 }, matchedCount: 6 } };
  api.state.evidence = { authority: 'core.pipeline', source: { store: 'mongodb' }, scope: { includesDone: true,
    statuses: ['queued', 'in_progress', 'review', 'blocked', 'done'], timeWindow: { kind: 'all_time' } }, rows: { matchedCount: 39, returnedCount: 1, truncated: true } };
  api.state.tasks = [{ status: 'done' }];
  return { ...api, nodes };
}
test('summary cards exclude archived qualifications even when their rows are outside the page', () => {
  const f = fixture(); f.renderCounts(); f.renderEvidence();
  expect(f.statusCounts()).toEqual({ queued: 3, in_progress: 0, review: 4, blocked: 3, done: 23 });
  expect(f.nodes.pipelineCountReview.textContent).toBe('4');
  expect(f.nodes.pipelineCountEvidence.textContent).toContain('6 archived qualifications excluded');
  f.state.includeArchivedQualifications = true; f.renderCounts(); f.renderEvidence();
  expect(f.nodes.pipelineCountReview.textContent).toBe('7');
  expect(f.nodes.pipelineCountEvidence.textContent).toContain('archived qualifications included');
  expect(f.state.summary.byStatus.review).toBe(7);
});
test('an old server without exact archive counts labels a truncated fallback as a sample', () => {
  const f = fixture(); delete f.state.summary.archivedQualifications; f.renderCounts(); f.renderEvidence();
  expect(f.nodes.pipelineCountReview.textContent).toBe('0');
  expect(f.nodes.pipelineCountEvidence.textContent).toContain('loaded sample counts');
  f.state.includeArchivedQualifications = true; f.renderCounts();
  expect(f.nodes.pipelineCountReview.textContent).toBe('7');
});
