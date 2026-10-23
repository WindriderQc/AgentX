'use strict';
const ui = require('../../public/js/pipeline-report-resume');

const SHA = 'f17bda9381816738d17d3e35f53a7bb6b79f17d9a9e0249f530c6dca8f9ebe7a';
const stopped = { requestId: 'r1', kind: 'blocked', reason: 'runner_error', partial: { sha256: SHA } };
const task = (extra = {}) => ({ pipelineId: '0939', status: 'blocked', codingResult: { profile: 'report', reportName: 'REVIEW.md' },
  feedback: [{ reportOutcome: stopped }], ...extra });
const view = (extra = {}) => ({ pipelineId: '0939', checkpoint: { parentRequestId: 'r1', parentSha256: SHA },
  work: { total: 76, reviewed: 62, remaining: 14, partial: 5, blocked: 0 },
  budget: { modelCalls: 135, executions: 2, minutes: 107 }, route: { model: 'coder:27b', host: 'http://h:11434' },
  escalation: { enabled: false, maxCostNanodollars: 10e9 }, resume: null, campaign: null, ...extra });

it('offers the one-click resume only for a stopped or new report the owner manages', () => {
  expect(ui.eligible(task())).toBe(true);
  expect(ui.eligible(task({ status: 'running' }))).toBe(false);
  expect(ui.eligible(task({ feedback: [{ reportOutcome: { requestId: 'r1', sha256: SHA } }] }))).toBe(false);
  expect(ui.eligible(task({ codingAutonomy: {} }))).toBe(false);
  expect(ui.eligible(task({ codingResult: { profile: 'report' } }))).toBe(false);
  expect(ui.placeholder(task())).toContain('data-report-resume="0939"');
});

it('shows the remaining work, the When choice and the safety budget, with no number to type', () => {
  const html = ui.render(view());
  expect(html).toContain('<strong>62 of 76</strong> documents reviewed · <strong>14</strong> left (5 partial)');
  expect(html).toContain('<code>f17bda93</code>');
  for (const choice of ['asap', 'tonight', 'at']) expect(html).toContain(`value="${choice}"`);
  expect(html).toContain('Up to <strong>135</strong> model calls in <strong>2</strong> executions, about <strong>1 h 47</strong>');
  expect(html).toContain('stops with an alert when a pass saves nothing new');
  expect(html).toContain('cap 10 $ per task');
  expect(html).toContain('cloud escalation is off globally');
  expect(html).not.toMatch(/name="(reportCalls|reportWorkSeconds|reportCampaign|reportRuns)"/);
});

it('says where a planned, running or stopped resume stands', () => {
  const planned = ui.render(view({ resume: { state: 'planned' }, campaign: { state: 'reserved', reservation: { start: '2026-10-20T03:00:00Z', end: '2026-10-20T04:47:00Z' } } }));
  expect(planned).toContain('starts automatically');
  expect(planned).toContain('>Replan<');
  const running = ui.render(view({ resume: { state: 'launched' }, campaign: { state: 'running' } }));
  expect(running).toContain('Running now');
  expect(running).not.toContain('name="when"');
  const stalled = ui.render(view({ resume: { state: 'stopped', result: { decision: 'no_progress' } }, campaign: { state: 'failed' } }));
  expect(stalled).toContain('the last pass saved nothing new');
  expect(stalled).toContain('name="when"');
  const neverStarted = ui.stateText({ resume: { state: 'stopped' }, campaign: { state: 'failed', releaseReceipt: { receiptRef: 'core:not-started: x' } } });
  expect(neverStarted).toContain('The worker never started');
});

it('binds the retry button to the exact unstarted campaign and explains its refusal', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const html = ui.render(view({ retryCampaignId: id, resume: { state: 'planned' },
    campaign: { state: 'failed', releaseReceipt: { receiptRef: 'core:not-started: Checkpoint storage is full' } } }));
  expect(html).toContain(`data-retry-campaign-id="${id}"`);
  expect(html).toContain('Checkpoint storage is full');
});
