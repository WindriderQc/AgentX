import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { agentxRead } from '../harness.js';

test('nestor_network reads the Core network_devices tool and nothing broader', async () => {
  let captured;
  const inventory = { freshness: 'Dernier scan il y a 4 min.', stale: false, devices: [] };
  const data = await agentxRead('http://127.0.0.1:3180', 'network_devices', { scope: 'unknown' }, async (url, options) => {
    captured = { url: String(url), body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 'nestor-read', result: { structuredContent: inventory } }) };
  });
  assert.deepEqual(data, inventory);
  assert.equal(captured.url, 'http://127.0.0.1:3180/mcp');
  assert.deepEqual(captured.body.params, { name: 'network_devices', arguments: { scope: 'unknown' } });
  await assert.rejects(agentxRead('http://127.0.0.1:3180', 'network_scan', {}, async () => assert.fail('must not call')), /Unsupported Nestor read/);
});

test('a Core tool error is not relayed as an inventory', async () => {
  await assert.rejects(agentxRead('http://127.0.0.1:3180', 'network_devices', {}, async () => ({
    ok: true, json: async () => ({ jsonrpc: '2.0', id: 'nestor-read', result: { isError: true, structuredContent: { error: 'DATA_UNAVAILABLE' } } }),
  })), /AgentX source unavailable/);
});

test('the manifest declares nestor_network as an optional plugin tool', async () => {
  const manifest = JSON.parse(await readFile(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.ok(manifest.contracts.tools.includes('nestor_network'));
  assert.deepEqual(manifest.toolMetadata.nestor_network, { optional: true });
});
