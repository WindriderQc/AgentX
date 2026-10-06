import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildTool, fileToolGate, workerContext } from '../runner.js';

const context = { agentId: 'worker', sessionKey: 'agent:worker:task-0700' };
const agents = ['worker'];

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coding-verification-test-'));
  const repository = path.join(root, 'task'); await fs.mkdir(repository);
  const grant = { schema: 'agentx.coding-verification-grant/v1', agent: 'worker', sessionKey: 'task-0700',
    deadlineEpoch: Date.now()/1000+60, repository, scope: ['source.py'], sourceFiles: ['authority.md'], feedbackPath: path.join(root, 'feedback.md') };
  await fs.writeFile(path.join(root, 'worker.json'), JSON.stringify(grant), { mode: 0o600 });
  return { root, repository, config: { root, grantRoot: root, agentIds: agents, helperPath: '/product/coding_worker_verification.py' },
    close: () => fs.rm(root, { recursive: true, force: true }) };
}

test('only the configured worker in its own session gets a parameter-free tool', async () => {
  assert.equal(workerContext(context, agents), true);
  assert.equal(workerContext({ ...context, sessionKey: 'agent:main:x' }, agents), false);
  assert.equal(buildTool({ ...context, agentId: 'main' }, { agentIds: agents }), null);
  const f = await fixture();
  try {
    const calls = [];
    const tool = buildTool(context, f.config, async (...args) => { calls.push(args); return { stdout: '{"passed":false,"call":1}' }; });
    assert.equal(tool.parameters.additionalProperties, false);
    await assert.rejects(tool.execute('call', { command: 'touch /outside' }), /no command/);
    assert.equal(calls.length, 0);
    assert.equal((await tool.execute('call', {})).details.passed, false);
    assert.deepEqual(calls[0][1], ['/product/coding_worker_verification.py', 'run', '--agent', 'worker', '--session-key', context.sessionKey, '--grant-root', f.root]);
    assert.equal(calls[0][2].shell, false);
  } finally { await f.close(); }
});

test('file gate permits original authority and scoped edits, rejecting ignored dependencies and other tasks', async () => {
  const f = await fixture(), active = async () => {};
  const gate = (toolName, file) => fileToolGate({ toolName, params: { path: file } }, context, f.config, { assertActive: active });
  try {
    assert.equal(await gate('read', 'authority.md'), undefined);
    assert.equal(await gate('write', 'source.py'), undefined);
    assert.equal((await gate('edit', 'authority.md')).block, true);
    assert.equal((await gate('write', 'core/node_modules/jest/index.js')).block, true);
    assert.equal((await gate('write', '../other-task/source.py')).block, true);
    assert.equal((await gate('exec', 'source.py')).block, true);
    assert.equal((await fileToolGate({ toolName: 'apply_patch', params: {} }, context, f.config)).block, true);
  } finally { await f.close(); }
});

test('revoked authority, missing grants and symlinks block all worker file access', async () => {
  const f = await fixture();
  try {
    const event = { toolName: 'write', params: { path: 'source.py' } };
    const denied = await fileToolGate(event, context, f.config, { assertActive: async () => { throw new Error('lease revoked'); } });
    assert.match(denied.blockReason, /lease revoked/);
    await fs.symlink(path.join(f.root, 'outside'), path.join(f.repository, 'source.py'));
    const escaped = await fileToolGate(event, context, f.config, { assertActive: async () => {} });
    assert.equal(escaped.block, true);
    await fs.unlink(path.join(f.root, 'worker.json'));
    assert.equal((await fileToolGate(event, context, f.config)).block, true);
    assert.equal(await fileToolGate(event, { agentId: 'main' }, f.config), undefined);
  } finally { await f.close(); }
});
