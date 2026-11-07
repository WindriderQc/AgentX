'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { sync } = require('../runtime-usage-sync.cjs');
const { hermesUsageReceipt, instanceIdFor } = require('../../../shared/runtimeUsageReceipts.cjs');

test('OpenClaw collector exports native metadata only and replays the same identities after a lost response', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agentx-usage-sync-'));
  t.after(() => rm(directory, { recursive: true }));
  const at = new Date().toISOString();
  const message = (id, provider, usage) => ({ type: 'message', id, timestamp: at,
    message: { role: 'assistant', provider, model: 'vendor/synthetic', stopReason: 'stop',
      content: [{ type: 'text', text: 'PRIVATE_TEXT' }], usage } });
  const usage = { input: 10, output: 2, cacheRead: 5, cacheWrite: 1, cost: { total: 0.02 } };
  await writeFile(path.join(directory, 'synthetic.jsonl'), [
    { type: 'session', id: 'native-session' }, message('one', 'openrouter', usage), message('local', 'ollama', usage),
    message('two', 'openai-codex', usage), message('missing', 'openrouter', null)
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const config = { '--core-url': 'http://core.invalid', '--sessions-dir': directory,
    '--instance-id': 'synthetic', '--direct-providers': 'openrouter,openai-codex' };
  const posts = [];
  const fetchImpl = async (_url, init) => { posts.push(JSON.parse(init.body)); return Response.json({ status: 'success', result: { receiptId: 'synthetic' } }); };
  await assert.rejects(sync(config, async (url, init) => { await fetchImpl(url, init); throw new Error('Lost response'); }));
  assert.deepEqual(await sync(config, fetchImpl), { submitted: 2, skipped: 2 });
  assert.deepEqual(posts[0], posts[1]);
  assert.equal(posts[1].inputTokens, 16);
  assert.equal(posts[1].nativeCost.amount, 0.02);
  assert.equal(posts[2].billing, 'subscription');
  assert.equal(posts[2].nativeCost, undefined);
  assert.doesNotMatch(JSON.stringify(posts), /PRIVATE_TEXT|content|directory/);
});

test('Hermes translation preserves its native identity and excludes Core/local or incomplete usage', () => {
  const state = { runId: 'run_synthetic', settledAt: new Date().toISOString(), receipt: { status: 'completed',
    runtime: { provider: 'openai-codex', model: 'synthetic' }, usage: { input_tokens: 5, output_tokens: 2 } } };
  assert.equal(hermesUsageReceipt(state, 'http://hermes.invalid').instanceId, instanceIdFor('http://hermes.invalid/'));
  assert.equal(hermesUsageReceipt({ ...state, receipt: { ...state.receipt, runtime: { provider: 'custom' } } }, 'http://hermes.invalid'), null);
  assert.equal(hermesUsageReceipt({ ...state, receipt: { ...state.receipt, usage: { input_tokens: 5 } } }, 'http://hermes.invalid'), null);
});
