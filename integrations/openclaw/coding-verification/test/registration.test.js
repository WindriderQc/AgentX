import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../registration.js';

test('Gateway readiness requires the actual hook registration and an explicitly allowed optional tool', () => {
  let status;
  const hooks = [], config = { agentIds: ['worker'], helperPath: '/srv/product/verifier.py' };
  const api = { pluginConfig: config, config: { agents: { entries: { worker: { tools: { alsoAllow: [] } } } } },
    on: (...args) => hooks.push(args), registerTool() {},
    registerGatewayMethod: (_method, handler) => { status = handler; } };
  register(api);
  assert.equal(hooks[0][0], 'before_tool_call');
  let receipt;
  const check = () => status({ params: { agentId: 'worker' }, respond: (_ok, value) => { receipt = value; } });
  check(); assert.equal(receipt.ready, false);
  api.config.agents.entries.worker.tools.alsoAllow.push('agentx_coding_verify');
  check(); assert.equal(receipt.ready, true); assert.equal(receipt.fileScopeHook, true);
  assert.equal(receipt.helperPath, config.helperPath);
  assert.throws(() => register({ ...api, on: undefined }), /requires file hooks/);
});
