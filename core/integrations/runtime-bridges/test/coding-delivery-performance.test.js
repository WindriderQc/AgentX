'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { CodingDeliveryControl, GitHubRepositoryClient } = require('../coding-delivery-control');

function promoted(id) {
  return { pipelineId: id, status: 'done', automationAttempts: [{ attempt: 1, reviewOutcome: 'accepted', evidence: {
    verification: { status: 'passed' }, failureCodes: [], workerReceiptFingerprint: 'a'.repeat(64)
  } }], feedback: [{ text: `agentx.coding-promotion/v1 task=${id} attempt=1 https://github.com/WindriderQc/AgentX/pull/42` }] };
}

test('status bounds receipt concurrency, shares observation reads, and never caches later observations', async () => {
  let active = 0, peak = 0, pulls = 0, receipts = 0;
  const control = new CodingDeliveryControl({
    taskReader: async () => ['0701','0702','0703','0704','0705'].map(promoted),
    productionReader: async () => ({}),
    receiptReader: async () => {
      receipts++; active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 10)); active--; return null;
    },
    github: { configured: true, getPull: async () => { pulls++; throw new Error('Unavailable upstream'); } }
  });
  const result = await control.status();
  assert.equal(peak, 3);
  assert.equal(receipts, 5);
  assert.equal(pulls, 1);
  assert.equal(result.items.length, 5);
  assert.ok(result.items.every(item => item.stage === 'delivery_unavailable' && item.gate === null));
  await control.status();
  assert.equal(pulls, 2);
  assert.equal(receipts, 10);
});

test('GitHub requests cancel a hung upstream and omit secrets from errors', async () => {
  let cancelled = false;
  const github = new GitHubRepositoryClient({ token: 'test-secret', timeoutMs: 20, fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => { cancelled = true; reject(new Error('test-secret')); });
  }) });
  await assert.rejects(() => github.getPull(42), error => {
    assert.match(error.message, /timed out/);
    assert.ok(!error.message.includes('test-secret')); return true;
  });
  assert.equal(cancelled, true);
});

test('a status observation cannot authorize a merge after task evidence drifts', async () => {
  let taskReads = 0, mutations = 0;
  const control = new CodingDeliveryControl({
    taskReader: async () => { taskReads++; return taskReads === 1 ? [promoted('0701')] : []; },
    productionReader: async () => ({}), receiptReader: async () => null,
    github: { configured: true, getPull: async () => { throw new Error('offline'); }, mergePull: async () => { mutations++; } }
  });
  await control.status();
  await assert.rejects(() => control.merge({ pipelineId: '0701', pullRequestNumber: 42, expectedHeadSha: 'b'.repeat(40), confirmation: `MERGE PR #42 @ ${'b'.repeat(40)}` }), { code: 'CODING_DELIVERY_IDENTITY_MISMATCH' });
  assert.equal(taskReads, 2);
  assert.equal(mutations, 0);
});
