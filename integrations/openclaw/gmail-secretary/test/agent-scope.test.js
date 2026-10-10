import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlugin } from '../lib/tools.js';

function registration(pluginConfig) {
  const tools = [], hooks = new Map();
  createPlugin(x => x).register({ config: {}, pluginConfig,
    registerTool: (tool, options) => tools.push({ tool, options }),
    on: (name, handler) => hooks.set(name, handler) });
  return { tools, hooks };
}

test('scoped Gmail tools belong to the same native mail agent in direct and delegated sessions', () => {
  const { tools, hooks } = registration({ agentIds: ['mail'] });
  assert.equal(tools.length, 8);
  for (const { tool, options } of tools) {
    assert.equal(typeof tool, 'function');
    for (const sessionKey of ['agent:mail:household:direct:synthetic', 'agent:mail:subagent:synthetic']) {
      const resolved = tool({ agentId: 'mail', sessionKey });
      assert.equal(resolved.name, options.name);
      assert.equal(typeof resolved.execute, 'function');
      assert.equal(options.optional, true);
    }
    for (const context of [undefined, {}, { agentId: 'main', sessionKey: 'agent:main:direct:synthetic' },
      { agentId: 'mail', sessionKey: 'agent:main:subagent:synthetic' }]) {
      assert.equal(tool(context), null);
      assert.equal(hooks.get('before_tool_call')({ toolName: options.name, params: {} }, context).block, true);
    }
  }
  assert.equal(hooks.get('before_tool_call')({ toolName: 'gmail_secretary_search', params: {} },
    { agentId: 'mail', sessionKey: 'agent:mail:subagent:synthetic' }), undefined);
});

test('omitting the scope preserves existing object registration and configured approvals', () => {
  const { tools } = registration({});
  assert.equal(tools.length, 8);
  for (const { tool, options } of tools) {
    assert.equal(typeof tool, 'object');
    assert.equal(typeof tool.execute, 'function');
    assert.equal(options.optional, true);
  }
});

test('an explicitly empty agent scope exposes no Gmail tools', () => {
  const { tools } = registration({ agentIds: [] });
  for (const { tool } of tools) assert.equal(tool({ agentId: 'mail', sessionKey: 'agent:mail:direct:synthetic' }), null);
});
