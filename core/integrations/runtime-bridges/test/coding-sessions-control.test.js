'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CodingDispatchControl } = require('../coding-dispatch-control');
const { CodingSessionsControl, registerCodingSessionsRoutes } = require('../coding-sessions-control');
const key = '11111111-2222-4333-8444-555555555555';
const invocation = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const handoff = '12345678-abcd-4abc-8def-123456789abc';
const selection = { pipelineId: '0001', requestId: key, executorId: 'native-open', invocationId: invocation };
function configured(runner) {
  return new CodingSessionsControl(new CodingDispatchControl({ executors: [
    { id: 'native-dsh', harness: 'dsh', sshTarget: 'worker@first.example' },
    { id: 'native-open', harness: 'opencode', sshTarget: 'worker@second.example' },
  ], sshRunner: runner }));
}

test('native reads bind the original executor/task/request/invocation without failover or a worker launch', async () => {
  const commands = [];
  const control = configured(async (target, command) => {
    assert.equal(target, 'worker@second.example'); commands.push(command);
    return { stdout: JSON.stringify({ status: 'success', data: { ...selection, messages: [], nextOffset: null } }) };
  });
  await control.call('read', { ...selection, offset: 20, revision: 'a'.repeat(64) });
  assert.equal(commands[0], `/usr/bin/python3 /opt/agentx/integrations/coding/coding_sessions_control.py read 0001 ${key} native-open ${invocation} 20 ${'a'.repeat(64)}`);
  assert.equal(commands.length, 1);
});

test('invalid selections and DSH executors cannot contact a host through this adapter', async () => {
  for (const change of [{ executorId: undefined }, { executorId: 'native-dsh' }, { requestId: 'x;false' },
    { invocationId: '../outside' }, { offset: '0; false' }, { revision: 'not-a-hash' }]) {
    await assert.rejects(configured(() => assert.fail('must not contact a host')).call('read', { ...selection, ...change }));
  }
  await assert.rejects(configured(() => assert.fail('must not contact a host')).call('read; false', selection));
});

test('handoff keeps the same action identity and rejects responses for another source', async () => {
  const payload = { ...selection, handoffRequestId: handoff, revision: 'a'.repeat(64), confirm: true };
  const commands = [];
  const control = configured(async (target, command) => {
    commands.push(command);
    return { stdout: JSON.stringify({ status: 'success', data: { ...selection, handoffRequestId: handoff, state: 'ready' } }) };
  });
  await control.call('handoff', payload); await control.call('handoff', payload);
  assert.equal(commands[0], commands[1]);
  assert.ok(commands[0].endsWith(`${invocation} ${handoff} ${'a'.repeat(64)}`));
  await assert.rejects(configured(async () => ({ stdout: JSON.stringify({ status: 'success', data: {
    ...selection, requestId: handoff } }) })).call('read', selection));
  await assert.rejects(control.call('handoff', { ...payload, confirm: false }));
});

test('route path identities override conflicting body values and no GET can hand off', async () => {
  const routes = {};
  const router = { get: (p, h) => { routes['GET ' + p] = h; }, post: (p, h) => { routes['POST ' + p] = h; } };
  const control = configured(async () => ({ stdout: JSON.stringify({ status: 'success', data: {
    ...selection, handoffRequestId: handoff, state: 'ready' } }) })).control;
  registerCodingSessionsRoutes({ router, control });
  const response = { json(body) { this.body = body; return this; }, status() { return this; } };
  await routes['POST /runs/:requestId/sessions/:invocationId/handoff']({
    params: { requestId: key, invocationId: invocation }, body: { pipelineId: '0001', executorId: 'native-open',
      requestId: handoff, invocationId: handoff, handoffRequestId: handoff, revision: 'a'.repeat(64), confirm: true } }, response);
  assert.equal(response.body.status, 'success');
  assert.equal(routes['GET /runs/:requestId/sessions/:invocationId/handoff'], undefined);
});
