import test from 'node:test';
import assert from 'node:assert/strict';
import { financeContext } from '../core-finance.js';

test('only the finance persona, unsandboxed, in its own session sees the ledger', () => {
  assert.equal(financeContext({ agentId: 'comptable', sessionKey: 'agent:comptable:telegram:group:-100123' }), true);
  assert.equal(financeContext({ agentId: 'main', sessionKey: 'agent:main:telegram:direct:1' }), false);
  assert.equal(financeContext({ agentId: 'comptable', sessionKey: 'agent:main:telegram:direct:1' }), false);
  assert.equal(financeContext({ agentId: 'comptable', sessionKey: 'agent:comptable:main', sandboxed: true }), false);
  assert.equal(financeContext({ agentId: 'tresor', sessionKey: 'agent:tresor:main' }, ['tresor']), true);
  assert.equal(financeContext(null), false);
});

test('the plugin entry parses (the OpenClaw SDK import is stubbed)', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const body = source.replace(/^import .*$/gm, '').replace('export default', 'return');
  assert.doesNotThrow(() => new Function('definePluginEntry', 'createCoreAlertsClient', 'createCoreFinanceClient',
    'createCorePlanClient', 'createCoreRulesClient', 'financeContext', body));
});
