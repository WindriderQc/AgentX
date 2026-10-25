import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTerminalEvidenceStore } from '../terminal-evidence.mjs';
import { createExecutionService } from '../service.mjs';

const descriptor = { model: 'fixture/model', fingerprint: 'a'.repeat(64), contextWindow: 8192, maxTokens: 1024,
  isolation: { singleCallQualified: true }, billing: { kind: 'paid', rates: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } } };
function fixture({ recordTerminal, incomplete = false } = {}) {
  const calls = [], spend = [];
  const value = { provider: 'fixture', model: 'model', content: [{ type: 'text', text: '{"answer":"retained"}' }],
    stopReason: 'stop', usage: { input: 31, output: 11, cacheRead: 0, cacheWrite: 0, totalTokens: 100,
      reasoningTokens: 58, cost: { total: 0.002 } } };
  const backend = { catalogue: async () => ({ models: [descriptor], agents: [] }), prepare: async () => ({
    model: { provider: 'fixture', id: 'model', api: 'openai-completions' }, descriptor, runtimeVersion: 'fixture',
    stream: (context, options) => (async function* () {
      calls.push(context); await options.onPayload({ messages: context.messages, max_tokens: 64 });
      yield { type: 'text_delta', delta: value.content[0].text };
      if (incomplete) yield { type: 'error' }; else yield { type: 'done', message: value };
    })() }) };
  const service = createExecutionService({ backend, recordTerminal, maxRequestCostNanodollars: 20_000_000,
    ledger: { read: async () => ({}), record: async cost => spend.push(cost) } });
  return { calls, spend, value, service, request: { schema: 'agentx.openclaw-model-request/v1', requestId: 'original-call',
    model: descriptor.model, messages: [{ role: 'user', content: 'private input' }], parameters: { maxTokens: 64 },
    budget: { maxCalls: 1, maxCostNanodollars: 20_000_000 } } };
}

test('rejected final result survives a new store with exact usage, private bytes and no retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentx-terminal-'));
  try {
    const store = createTerminalEvidenceStore({ directory }), f = fixture({ recordTerminal: store.record });
    let failure;
    await assert.rejects(f.service.execute(f.request), error => {
      failure = error; return error.code === 'OPENCLAW_USAGE_UNOBSERVED' && error.executionState === 'unknown';
    });
    assert.equal(f.calls.length, 1); assert.deepEqual(f.spend, [null]);
    assert.equal(failure.terminalEvidence.usageValidated, false);
    const saved = await createTerminalEvidenceStore({ directory }).read(failure.terminalEvidence.ref);
    assert.equal(saved.sha256, failure.terminalEvidence.sha256);
    assert.deepEqual(saved.evidence.nativeResult, f.value);
    assert.equal(saved.evidence.errorCode, 'OPENCLAW_USAGE_UNOBSERVED');
    assert.equal(saved.evidence.cost, 'unverified');
    assert.equal(saved.evidence.requestId, f.request.requestId);
    assert.equal(saved.evidence.targetFingerprint, descriptor.fingerprint);
    assert.equal(JSON.stringify(saved).includes('private input'), false);
    const files = await readdir(directory); assert.equal(files.length, 1);
    assert.equal((await stat(join(directory, files[0]))).mode & 0o777, 0o600);
    for (const ref of ['../../secret', 'openclaw-model-terminal:../../secret', null])
      await assert.rejects(store.read(ref), { statusCode: 400 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('evidence write failure preserves the original unknown and its unknown paid charge', async () => {
  const f = fixture({ recordTerminal: async () => { throw new Error('disk unavailable'); } });
  await assert.rejects(f.service.execute(f.request), error => error.code === 'OPENCLAW_USAGE_UNOBSERVED'
    && error.executionState === 'unknown' && !error.terminalEvidence);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.spend, [null]);
});

test('partial stream without a native done event never receives terminal evidence', async () => {
  let records = 0; const f = fixture({ incomplete: true, recordTerminal: async () => { records++; } });
  await assert.rejects(f.service.execute(f.request), error => error.executionState === 'unknown' && !error.terminalEvidence);
  assert.equal(records, 0); assert.equal(f.calls.length, 1); assert.deepEqual(f.spend, [null]);
});

test('a zero-cost continuation budget refuses a paid native target before dispatch', async () => {
  const f = fixture(); f.request.budget.maxCostNanodollars = 0;
  await assert.rejects(f.service.execute(f.request), { code: 'OPENCLAW_SPEND_LIMIT_REQUIRED' });
  assert.equal(f.calls.length, 0); assert.deepEqual(f.spend, []);
});
