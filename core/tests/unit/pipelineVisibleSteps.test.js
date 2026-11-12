'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const steps = require('../../public/js/pipeline-code-steps');
const graph = require('../../public/js/pipeline-code-step-graph');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function draw(attempts = [], status = 'review') {
  const body = { innerHTML: '', querySelector: () => null };
  const window = { PipelineCodeSteps: steps, PipelineCodeStepGraph: graph,
    PipelineDossierActivity: {read: () => ({}), markup: () => ''} };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../public/js/pipeline-drawer.js'), 'utf8'), {window});
  const api = window.PipelineDrawer.create({drawerEls: () => ({body}), state: {drawer: {}},
    readStorage: () => '', reviewContext: () => ({code: 'human_review'}), escapeHtml: esc,
    renderSupersedePreview: () => '', statusBadge: s => s, priorityChip: () => '', riskChip: () => '',
    latestTeamUpdate: () => '', formatDate: s => s, metaRow: () => '', relativeTime: () => '',
    renderAttemptDossier: () => '<div>Expert attempt dossier</div>'});
  api.renderDrawer({pipelineId:'1234', title:'Synthetic task', status, automationAttempts: attempts, feedback: []});
  return body.innerHTML;
}
const plan = {
  schema:'agentx.code-step-summary/v1', planFingerprint:'a'.repeat(64), stepContext:24576,
  budgetSource:'default', currentStep:null, counts:{pending:0,running:0,passed:1,failed:0},
  steps:[{id:'one', title:'Verified synthetic change', state:'passed',commit:'b'.repeat(40), tests:[{profile:'synthetic-unit',outcome:'passed'}]}]
};
test('places evidence before technical details and does not invent a plan', () => {
  const html=draw();
  expect(html.indexOf('Execution and steps')).toBeLessThan(html.indexOf('Technical details and history'));
  expect(html).toContain('No recorded attempt');
  expect(html).toContain('No code-step plan recorded');
  expect(html).toContain('does not mean no work was done');
});
test('uses latest numbered attempt rather than old passing evidence', () => {
  const html=draw([{attempt:9,evidence:{}},{attempt:2,evidence:{codeSteps:plan}}]);
  expect(html).toContain('Latest recorded attempt 9');
  expect(html).not.toContain('Verified synthetic change');
});
test('renders actual step evidence without implying deployment', () => {
  const html=draw([{attempt:2,completedAt:'2026-01-01',evidence:{codeSteps:plan}}], 'done');
  expect(html).toContain('Verified synthetic change');
  expect(html).toContain('1/1 passed');
  expect(html).toContain('Task status, human review and delivery remain separate');
  expect(html).not.toMatch(/100%|deployed successfully/i);
});
test('malformed graph is explicit, not replaced by an old step success', () => {
  const html=draw([{attempt:2,evidence:{codeSteps:plan,codeStepGraph:{schema:'invalid'}}}]);
  expect(html).toContain('malformed evidence was not displayed');
  expect(html).not.toContain('Verified synthetic change');
});
test('escapes receipt identity and does not interpolate unsafe markup', () => {
  const html=draw([{attempt:'<img src=x>',completedAt:'<unsafe>',evidence:{}}]);
  expect(html).not.toContain('<img src=x>');
  expect(html).toContain('&lt;img src=x&gt;');
  expect(html).toContain('&lt;unsafe&gt;');
});
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

test('shows valid graph summary and retains dependencies behind one disclosure', () => {
  const html = draw([{attempt: 3, evidence: {codeStepGraph: summary()}}], 'in_progress');
  expect(html).toContain('2 steps');
  expect(html).toContain('1 verified');
  expect(html).toContain('View steps, dependencies and evidence');
  expect(html).toContain('data-drawer-section="visible-steps"');
  expect(html).toContain('Build the graph contract');
  expect(html).toContain('Render &lt;multi-host&gt; evidence');
  expect(html).toContain('No attempt end recorded');
});
