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

test('every registered finance tool is declared optional in the native manifest and remains finance-only', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
  const body = source.replace(/^import .*$/gm, '').replace('export default', 'return');
  const clients = ['createCoreAlertsClient', 'createCoreDocumentLinkClient', 'createCoreFinanceClient',
    'createCorePlanClient', 'createCoreRulesClient', 'createCoreStatementDepositClient'];
  const client = () => () => assert.fail('Discovery cannot invoke a finance operation');
  const plugin = new Function('definePluginEntry', ...clients, 'financeContext', body)(value => value,
    ...clients.map(() => client), financeContext);
  const registered = [];
  plugin.register({ config: {}, pluginConfig: { agentxUrl: 'http://core.invalid' },
    registerTool(factory, declaration) { registered.push({ factory, declaration }); } });
  assert.ok(registered.length >= 6);
  for (const { factory, declaration } of registered) {
    const tool = factory({ agentId: 'comptable', sessionKey: 'agent:comptable:main' });
    assert.equal(tool.name, declaration.name);
    assert.equal(declaration.optional, true);
    assert.ok(manifest.contracts.tools.includes(tool.name), tool.name);
    assert.deepEqual(manifest.toolMetadata[tool.name], { optional: true }, tool.name);
    assert.equal(factory({ agentId: 'main', sessionKey: 'agent:main:main' }), null);
    assert.equal(factory({ agentId: 'comptable', sessionKey: 'agent:comptable:main', sandboxed: true }), null);
  }
});

test('Core attributes finance decisions to each admitted session agent', async () => {
  const { readFile } = await import('node:fs/promises');
  const { createCoreRulesClient, createCoreDocumentLinkClient } = await import('../core-finance.js');
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const body = source.replace(/^import .*$/gm, '').replace('export default', 'return');
  const sent = [];
  const fetchImpl = async (url, opts) => {
    sent.push({ path: url.pathname, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ status: 'success', data: { saved: [] } }) };
  };
  const other = () => () => assert.fail('Unexpected finance operation');
  const plugin = new Function('definePluginEntry', 'createCoreAlertsClient', 'createCoreDocumentLinkClient',
    'createCoreFinanceClient', 'createCorePlanClient', 'createCoreRulesClient', 'createCoreStatementDepositClient',
    'financeContext', body)(value => value, other, o => createCoreDocumentLinkClient({ ...o, fetchImpl }),
    other, other, o => createCoreRulesClient({ ...o, fetchImpl }), other, financeContext);
  const factories = {};
  plugin.register({ pluginConfig: { agentxUrl: 'http://core.invalid', agentIds: ['books', 'accounts'] },
    registerTool(factory, { name }) { factories[name] = factory; } });
  for (const id of ['books', 'accounts']) {
    const context = { agentId: id, sessionKey: 'agent:' + id + ':main' };
    await factories.finance_categorize(context).execute('rule', {
      rules: [{ pattern: 'FOOD', category: 'food' }], transactions: [{ id: 'fixture' }], createdBy: 'untrusted'
    });
    await factories.finance_document_link(context).execute('link', { decision: 'confirm', ids: ['fixture'], createdBy: 'untrusted' });
    assert.deepEqual(sent.splice(0).map(({ path, body }) => [path, body.createdBy]), [
      ['/api/finance/transactions/decisions', id], ['/api/finance/rules', id], ['/api/finance/documents/links/decide', id]
    ]);
  }
});
