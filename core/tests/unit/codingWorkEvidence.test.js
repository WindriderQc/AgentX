'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ui = require('../../public/js/coding-work-evidence');
const graph = require('../../public/js/pipeline-code-step-graph');
function documentFor(task) {
  const module = { exports: {} };
  const mocks = {
    '../../models/PipelineTask': {}, '../helpers/workerTaskScope': () => ({}),
    './pipelineTaskProjectionReadService': {},
    './pipelineEvidenceReferences': { taskEvidenceReferences: () => ({}) },
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../src/services/pipelineWorkReadService.js'), 'utf8'), {
    module, require: name => name in mocks ? mocks[name] : name === '../../../shared/codeStepGraphSummary'
      ? require('../../../shared/codeStepGraphSummary') : require(name),
  });
  return module.exports.documentFor(task);
}
const executor = { id: 'executor-a', label: 'Executor A', harness: 'opencode' };
function summary(overrides = {}) {
  return {
    schema: 'agentx.code-step-graph-summary/v1', graphId: 'graph-0001', planFingerprint: 'a'.repeat(64), state: 'running',
    activeSteps: ['step-02'],
    counts: { pending: 0, waiting: 0, running: 1, passed: 1, failed: 0, uncertain: 0, blocked: 0 },
    budget: {
      reserved: { workSeconds: 300, testSeconds: 60, modelSeconds: 120, modelCalls: 8, ciSeconds: 0 },
      spent: { workSeconds: 90, testSeconds: 12, modelSeconds: 40, modelCalls: 3, ciSeconds: 0 },
    },
    steps: [
      { id: 'step-01', title: 'Build the graph contract', state: 'passed', dependsOn: [], attempt: 1, executor,
        commit: 'b'.repeat(40), tests: [{ profile: 'core-unit', outcome: 'passed', durationMs: 1200 }],
        adoption: { state: 'adopted', assemblyCommit: 'c'.repeat(40), receiptFingerprint: 'd'.repeat(64) } },
      { id: 'step-02', title: 'Render <multi-host> evidence', state: 'running', dependsOn: ['step-01'], attempt: 1,
        executor: { id: 'executor-b', label: 'Executor B', harness: 'opencode' }, tests: [] },
    ],
    assembly: { state: 'assembling', executor, baseCommit: 'e'.repeat(40), headCommit: 'c'.repeat(40), adoptedSteps: 1 },
    ...overrides,
  };
}


test('projection retains valid bounded graphs and marks malformed data without leaking unknown fields', () => {
  const valid = summary(); valid.secret = 'PRIVATE'; valid.steps[0].privatePath = 'PRIVATE';
  const doc = documentFor({pipelineId:'1234', automationAttempts:[{attempt:1,evidence:{codeStepGraph:valid}},{attempt:2,evidence:{codeStepGraph:{secret:'PRIVATE',schema:'bad'}}},{attempt:3}]});
  expect(doc.attempts[0].codeStepGraph.steps).toHaveLength(2);
  expect(doc.attempts[1].codeStepGraph).toEqual({invalid:true});
  expect(JSON.stringify(doc)).not.toContain('PRIVATE');
  expect(doc.attempts[2].codeStepGraph).toBeNull();
});
test('latest recorded attempt wins, never an older successful graph', () => {
  const html = ui.render([{attempt:9},{attempt:2,codeStepGraph:summary()}]);
  expect(html).toContain('9'); expect(html).toContain('Aucun plan');
  expect(html).not.toContain('Build the graph contract');
});
test('missing and malformed evidence are distinct, with no fabricated steps', () => {
  expect(ui.render([])).toContain('Aucune tentative');
  expect(ui.render([{attempt:1,codeStepGraph:{invalid:true}}])).toContain('malformed evidence');
});
test('read-only views use an exact task link while Pipeline keeps its native button', () => {
  const value = summary();
  value.steps[1].nativeSession = {pipelineId:'1234',requestId:'00000000-0000-4000-8000-000000000001',executorId:'executor-b'};
  const html = ui.render([{attempt:1,codeStepGraph:value}]);
  expect(html).toContain('/pipeline?task=1234');
  expect(html).not.toContain('data-native-step-pipeline');
  expect(graph.render(value)).toContain('data-native-step-pipeline="1234"');
  expect(html).toContain('Render &lt;multi-host&gt; evidence');
});
test('Studio loads shared contracts before renderers and the consuming page', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../../public/css/coding-work.css'), 'utf8');
  expect(css).toMatch(/\.pipeline-code-graph-meta\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
  const page = fs.readFileSync(path.resolve(__dirname, '../../views/pages/coding-work.ejs'), 'utf8');
  const paths=['code-step-summary.js','code-step-graph-summary.js','pipeline-code-steps.js','pipeline-code-step-graph.js','coding-work-evidence.js','coding-work.js'];
  paths.forEach((p,i)=>{expect(page).toContain(p); if(i)expect(page.indexOf(paths[i-1])).toBeLessThan(page.indexOf(p));});
});
