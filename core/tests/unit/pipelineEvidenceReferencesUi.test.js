'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../public/js/pipeline-evidence-references.js'), 'utf8');
const { taskEvidenceReferences } = require('../../src/services/pipelineEvidenceReferences');

const FIRST = '10000000-0000-4000-8000-000000000001';
const SECOND = '10000000-0000-4000-8000-000000000002';
const OTHER = '10000000-0000-4000-8000-000000000003';
const RECEIPT_ONE = '1'.repeat(64), RECEIPT_TWO = '2'.repeat(64);
const BOUND = { exactPullRequest: true, exactHead: true, sealedReceipt: true };

function load(search = '') {
  const listeners = {};
  const window = { location: { origin: 'http://agentx.test', search } };
  vm.runInNewContext(source, { window, URL, URLSearchParams, document: { addEventListener: (name, fn) => { listeners[name] = fn; } } });
  return { api: window.PipelineEvidenceReferences, listeners };
}

function task(attempts, status = 'in_progress') {
  const record = { pipelineId: '0307', status, automationLease: { leaseId: 'raw-lease-2' }, automationAttempts: attempts };
  return { pipelineId: '0307', evidenceReferences: taskEvidenceReferences(record) };
}

const twoAttempts = () => task([
  { attempt: 1, leaseId: 'raw-lease-1', dispatchRequestId: FIRST, finalState: 'review', reviewOutcome: 'accepted', evidence: { workerReceiptFingerprint: RECEIPT_ONE } },
  { attempt: 2, leaseId: 'raw-lease-2', dispatchRequestId: SECOND, finalState: 'active' },
]);

function attemptSection(html, attempt) {
  const start = html.indexOf(`data-evidence-attempt="${attempt}"`);
  const end = html.indexOf('</article>', start);
  return html.slice(start, end);
}

test('each attempt shows its own request and receipt and never the raw lease id', () => {
  const html = load().api.markup(twoAttempts(), { deliveryItems: [] });
  expect(attemptSection(html, 2)).toContain(SECOND);
  expect(attemptSection(html, 2)).not.toContain(FIRST);
  expect(attemptSection(html, 2)).toContain('no receipt recorded for this attempt');
  expect(attemptSection(html, 2)).not.toContain(RECEIPT_ONE);
  expect(attemptSection(html, 1)).toContain(RECEIPT_ONE);
  expect(attemptSection(html, 1)).toContain('Historical — attempt 2 is current');
  expect(attemptSection(html, 2)).toContain('Active lease');
  expect(html).toContain('http://agentx.test/pipeline?task=0307&amp;attempt=1');
  expect(html).not.toMatch(/raw-lease/);
});

test('links a PR only for the exact attempt and its own sealed receipt', () => {
  const { api } = load();
  const pr = { number: 42, url: 'https://github.com/example/AgentX/pull/42', headSha: 'a'.repeat(40) };
  const exact = api.markup(twoAttempts(), { deliveryItems: [{ pipelineId: '0307', attempt: 1, stage: 'pr_ready_to_merge', receipt: { fingerprint: RECEIPT_ONE }, receiptBinding: BOUND, pullRequest: pr }] });
  expect(attemptSection(exact, 1)).toContain('href="https://github.com/example/AgentX/pull/42"');
  expect(attemptSection(exact, 2)).toContain('Not this attempt — the delivery observation concerns attempt 1');
  expect(attemptSection(exact, 2)).not.toContain('pull/42');

  const stale = api.markup(twoAttempts(), { deliveryItems: [{ pipelineId: '0307', attempt: 2, stage: 'pr_ready_to_merge', receipt: { fingerprint: RECEIPT_ONE }, pullRequest: pr }] });
  expect(stale).not.toContain('href="https://github.com');
  expect(attemptSection(stale, 2)).toContain('does not match this attempt’s receipt');

  const mismatch = api.markup(twoAttempts(), { deliveryItems: [{ pipelineId: '0307', attempt: 1, stage: 'receipt_mismatch', receipt: { fingerprint: RECEIPT_ONE }, pullRequest: pr }] });
  expect(mismatch).not.toContain('href="https://github.com');

  const forged = api.markup(twoAttempts(), { deliveryItems: [{ pipelineId: '0307', attempt: 1, stage: 'product_review', receipt: { fingerprint: RECEIPT_ONE }, pullRequest: { number: 42, url: 'javascript:alert(1)' } }] });
  expect(forged).not.toContain('javascript:');
  expect(api.markup(twoAttempts(), {})).toContain('delivery status is not loaded');
});

test('merged, Product and mismatched PRs without a proven receipt binding are never linked', () => {
  const { api } = load();
  const pr = { number: 42, url: 'https://github.com/example/AgentX/pull/42', headSha: 'a'.repeat(40), state: 'merged' };
  const item = (overrides) => ({ pipelineId: '0307', attempt: 1, receipt: { fingerprint: RECEIPT_ONE }, pullRequest: pr, ...overrides });
  const cases = {
    mergedWithoutGate: item({ stage: 'deployed', gate: null }),
    mergedFailedBinding: item({ stage: 'deployed', gate: null, receiptBinding: { ...BOUND, sealedReceipt: false } }),
    productPr: item({ stage: 'product_review', receiptBinding: null }),
    wrongHead: item({ stage: 'pr_ready_to_merge', receiptBinding: { ...BOUND, exactHead: false } }),
  };
  for (const [name, delivery] of Object.entries(cases)) {
    const html = attemptSection(api.markup(twoAttempts(), { deliveryItems: [delivery] }), 1);
    expect({ name, linked: html.includes('href="https://github.com') }).toEqual({ name, linked: false });
    expect(html).toContain('PR #42 — receipt binding not proven; no link is made');
  }
  const proven = api.markup(twoAttempts(), { deliveryItems: [item({ stage: 'deployed', gate: null, receiptBinding: BOUND })] });
  expect(attemptSection(proven, 1)).toContain('href="https://github.com/example/AgentX/pull/42"');
});

test('a launch request missing from every attempt is shown without inferring an attempt', () => {
  const { api } = load();
  const html = api.markup(twoAttempts(), { deliveryItems: [], launchRun: { requestId: OTHER, pipelineId: '0307', phase: 'rejected' } });
  expect(html).toContain(`Latest launch request <code>${OTHER}</code>`);
  expect(html).toContain('No attempt is inferred from it.');
  expect(attemptSection(html, 2)).not.toContain(OTHER);
  const bound = api.markup(twoAttempts(), { deliveryItems: [], launchRun: { requestId: SECOND, pipelineId: '0307', phase: 'finished' } });
  expect(bound).not.toContain('Latest launch request');
  expect(attemptSection(bound, 2)).toContain('host phase finished');
  expect(api.launchMarkup({ requestId: SECOND })).toContain(SECOND);
  expect(api.launchMarkup({ requestId: '<script>' })).toBe('');
});

test('colliding requests stay unknown and are announced as conflicts', () => {
  const html = load().api.markup(task([
    { attempt: 1, leaseId: 'a', dispatchRequestId: FIRST },
    { attempt: 2, leaseId: 'b', dispatchRequestId: FIRST, evidence: { workerReceiptFingerprint: RECEIPT_TWO } },
  ]), { deliveryItems: [] });
  expect(html).toContain('Reference conflict: request reused');
  expect(attemptSection(html, 1)).toContain('the same value appears on several attempts');
  expect(attemptSection(html, 2)).not.toContain(FIRST);
});

test('a stale lease on a task no longer in progress is never labelled active', () => {
  const html = load().api.markup(task([
    { attempt: 2, leaseId: 'raw-lease-2', dispatchRequestId: SECOND, finalState: 'review' },
  ], 'review'), { deliveryItems: [] });
  expect(attemptSection(html, 2)).not.toContain('Active lease');
  expect(attemptSection(html, 2)).toContain('Lease inactive');
});

test('renders nothing without a matching reference projection', () => {
  const { api } = load();
  expect(api.markup({ pipelineId: '0307' })).toBe('');
  expect(api.markup({ pipelineId: '0308', evidenceReferences: twoAttempts().evidenceReferences })).toBe('');
  expect(api.markup(task([]), { deliveryItems: [] })).toBe('');
});
