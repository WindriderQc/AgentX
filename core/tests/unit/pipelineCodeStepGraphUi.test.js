'use strict';

const Graph = require('../../public/js/pipeline-code-step-graph');

const executor = { id: 'ugalien-open', label: 'UGAlien', harness: 'opencode' };
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
        executor: { id: 'ugbrutal-open', label: 'UGBrutal', harness: 'opencode' }, tests: [] },
    ],
    assembly: { state: 'assembling', executor, baseCommit: 'e'.repeat(40), headCommit: 'c'.repeat(40), adoptedSteps: 1 },
    ...overrides,
  };
}

test('renders ordered dependencies, public executor identity, budgets, tests and adoption without private transport data', () => {
  const value = summary({ sshTarget: 'private@10.0.0.1', workspacePath: '/private/worktree', rawOutput: 'private output' });
  value.steps[0].executor.sshTarget = 'private@10.0.0.2';
  const html = Graph.render(value);

  expect(html.indexOf('Build the graph contract')).toBeLessThan(html.indexOf('Render &lt;multi-host&gt; evidence'));
  expect(html).toContain('UGAlien (ugalien-open) · opencode');
  expect(html).toContain('step-01');
  expect(html).toContain('1,200 ms');
  expect(html).toContain('Adopted as');
  expect(html).toContain('Reserved: 300s work');
  expect(html).not.toMatch(/10\.0\.0|private output|private\/worktree|sshTarget/);
});

test('supports several active steps and fails closed on dependency or active-state drift', () => {
  const value = summary();
  value.steps[0] = { ...value.steps[0], state: 'uncertain', commit: undefined, adoption: undefined,
    tests: [], waitCode: 'host_outcome_unknown' };
  value.activeSteps = ['step-01', 'step-02'];
  value.counts = { pending: 0, waiting: 0, running: 1, passed: 0, failed: 0, uncertain: 1, blocked: 0 };
  value.assembly = { state: 'pending', adoptedSteps: 0 };
  expect(Graph.summaryText(value)).toContain('2 steps');
  expect(Graph.render(value)).toContain('host_outcome_unknown');

  value.steps[1].dependsOn = ['missing-step'];
  const html = Graph.render(value);
  expect(html).toContain('malformed evidence was not displayed');
  expect(html).not.toContain('missing-step');
});

test('renders final verification and one published draft PR without implying acceptance', () => {
  const value = summary({ state: 'published', activeSteps: [],
    counts: { pending: 0, waiting: 0, running: 0, passed: 2, failed: 0, uncertain: 0, blocked: 0 } });
  value.steps[1] = { ...value.steps[1], state: 'passed', commit: 'f'.repeat(40),
    tests: [{ profile: 'core-unit', outcome: 'passed' }],
    adoption: { state: 'adopted', assemblyCommit: '1'.repeat(40), receiptFingerprint: '2'.repeat(64) } };
  value.assembly = { state: 'published', executor, baseCommit: 'e'.repeat(40), headCommit: '1'.repeat(40), adoptedSteps: 2,
    verification: { profile: 'core-full', outcome: 'passed', durationMs: 4500 },
    publication: { state: 'published', prNumber: 946, url: 'https://github.com/example/project/pull/946', headCommit: '1'.repeat(40) },
    receiptFingerprint: '3'.repeat(64) };
  const html = Graph.render(value);
  expect(html).toContain('Draft PR #946');
  expect(html).toContain('core-full');
  expect(html).not.toMatch(/accepted|merged|deployed/i);
});
