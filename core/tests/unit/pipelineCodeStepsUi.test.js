'use strict';

const CodeSteps = require('../../public/js/pipeline-code-steps');

function summary(overrides = {}) {
  return {
    schema: 'agentx.code-step-summary/v1', planFingerprint: 'a'.repeat(64), stepContext: 24576,
    budgetSource: 'speed_knee', currentStep: null,
    counts: { pending: 0, running: 0, passed: 2, failed: 0 },
    steps: [
      { id: 'step-1', title: 'Update the contract', state: 'passed', commit: 'b'.repeat(40),
        tests: [{ profile: 'shared-unit', outcome: 'passed', durationMs: 1200 }] },
      { id: 'step-2', title: 'Render <ordered> evidence', state: 'passed', commit: 'c'.repeat(40),
        tests: [{ profile: 'core-unit', outcome: 'passed' }] },
    ],
    ...overrides,
  };
}

test('renders ordered titles, states, commits and focused-test profiles without raw fields', () => {
  const value = summary({ command: 'private command', rawOutput: 'private output', hostPath: '/private/path' });
  value.steps[0].toolPayload = 'private payload';
  const html = CodeSteps.render(value);

  expect(html.indexOf('Update the contract')).toBeLessThan(html.indexOf('Render &lt;ordered&gt; evidence'));
  expect(html).toContain('Passed');
  expect(html).toContain('bbbbbbbbbbbb');
  expect(html).toContain('shared-unit');
  expect(html).toContain('1,200 ms');
  expect(html).toContain('24k-token steps (measured speed knee)');
  expect(html).not.toMatch(/private command|private output|private payload|private\/path/);
});

test('fails closed without displaying malformed nested evidence', () => {
  const value = summary({ counts: { pending: 0, running: 0, passed: 1, failed: 1 } });
  value.steps[0].title = '<img src=x onerror=privateFixture>';
  const html = CodeSteps.render(value);

  expect(html).toContain('malformed evidence was not displayed');
  expect(html).not.toContain('privateFixture');
  expect(CodeSteps.safe(null)).toBeNull();
});
