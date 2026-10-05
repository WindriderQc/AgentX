'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../public/js/pipeline-phase-durations.js'), 'utf8');
const { buildPipelineAutomationPerformance } = require('../../src/services/pipelineAutomationPerformanceService');

function load() {
  const window = {};
  vm.runInNewContext(source, { window });
  return window.PipelinePhaseDurations;
}

const NOW = '2026-09-27T00:00:00.000Z';
const performanceFor = (attempts, createdAt = '2026-09-20T09:00:00.000Z', resourceWaits = new Map()) => buildPipelineAutomationPerformance(
  [{ pipelineId: '0710', createdAt, updatedAt: '2026-09-26T00:00:00.000Z', automationAttempts: attempts }],
  { now: NOW, windowDays: 30, resourceWaits }
);

describe('pipeline phase durations view', () => {
  test('renders every phase with its clock, coverage and empty uninstrumented phases', () => {
    const api = load();
    const performance = performanceFor([{
      attempt: 1, acquiredAt: '2026-09-20T10:00:00.000Z', completedAt: '2026-09-20T10:20:00.000Z',
      reviewedAt: '2026-09-20T11:20:00.000Z', finalState: 'review', reviewOutcome: 'accepted',
      evidence: { source: 'clawdx-guarded/v1', verification: { status: 'passed', durationMs: 120_000 }, usage: { durationMs: 1_020_000 } },
    }], undefined, new Map([['0710#1', { calls: 3, measuredCalls: 3, waitMs: 420 }]]));
    const html = api.summaryMarkup(performance);
    expect(html).toContain('Where attempt time goes');
    expect(html).toContain('agentx.pipeline-attempt-phases/v1');
    expect(html).toMatch(/data-phase="before_claim"[\s\S]*?<strong>1h<\/strong>/);
    expect(html).toMatch(/data-phase="worker"[\s\S]*?Worker clock[\s\S]*?<strong>15m<\/strong>/);
    expect(html).toMatch(/data-phase="verification"[\s\S]*?<strong>2m<\/strong>/);
    expect(html).toMatch(/data-phase="decision"[\s\S]*?Core clock[\s\S]*?<strong>1h<\/strong>[\s\S]*?1\/1 observed/);
    expect(html).toMatch(/data-phase="resource_wait" data-instrumented="true"[\s\S]*?Core clock[\s\S]*?<strong>420ms<\/strong>/);
    expect(api.attemptMarkup(performance.attempts[0])).toContain('Resource wait <b>420ms</b>');
    expect(html).toMatch(/data-phase="startup" data-instrumented="false"[\s\S]*?Not measured/);
    expect(html).not.toContain('clock mismatch');
  });

  test('keeps unknown phases empty and reports incoherent clocks', () => {
    const api = load();
    const performance = performanceFor([
      { attempt: 1, acquiredAt: '2026-09-20T10:00:00.000Z', completedAt: '2026-09-20T10:01:00.000Z', finalState: 'blocked',
        evidence: { source: 'clawdx-guarded/v1', verification: { status: 'failed', durationMs: 1_000 }, usage: { durationMs: 3_600_000 } } },
    ], null);
    const html = api.summaryMarkup(performance);
    expect(html).toContain('1 attempt has incoherent clocks');
    expect(html).toMatch(/data-phase="before_claim"[\s\S]*?<strong>Unknown<\/strong>[\s\S]*?0\/1 observed · 1 unknown/);
    expect(html).toMatch(/data-phase="decision"[\s\S]*?<strong>Unknown<\/strong>[\s\S]*?1 pending/);
    const row = api.attemptMarkup(performance.attempts[0]);
    expect(row).toContain('data-status="inconsistent"');
    expect(row).toContain('Worker <b>clock mismatch</b>');
    expect(row).toContain('Before claim <b>unknown</b>');
    expect(row).toContain('Decision <b>pending</b>');
    expect(row).toContain('title="The worker duration exceeds the Core attempt window"');
  });

  test('shows empty, missing-projection and unavailable states without inventing values', () => {
    const api = load();
    expect(api.summaryMarkup(performanceFor([]))).toContain('No attempt in this window');
    expect(api.summaryMarkup({ state: 'observed' })).toContain('Phase durations are unknown');
    expect(api.stateMarkup('unavailable', 'x<y')).toBe('<p class="pipeline-phase-state" data-tone="unavailable">x&lt;y</p>');
    expect(api.attemptMarkup({})).toContain('Phases unknown');
  });

  test('omits a decision that no ending expects and escapes unexpected values', () => {
    const api = load();
    const row = api.attemptMarkup({ phases: {
      before_claim: { status: 'observed', durationMs: 90_000 },
      worker: { status: '"><script>', durationMs: null },
      verification: { status: 'missing', durationMs: null, reason: 'not_recorded' },
      decision: { status: 'not_applicable', durationMs: null },
    } });
    expect(row).toContain('Before claim <b>2m</b>');
    expect(row).not.toContain('Decision');
    expect(row).not.toContain('<script>');
    expect(row).toContain('Worker <b>unknown</b>');
  });
});
