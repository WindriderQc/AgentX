'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { callSecretaryTool, SECRETARY_TOOLS } = require('../secretary-mcp');
const { readNetworkInventory, projectInventory } = require('../../../src/services/networkInventory');

const now = new Date('2026-01-10T12:00:00Z');
const devicesBody = {
  summary: { onlineTtlMs: 30 * 60000 },
  devices: [
    { mac: 'AA:AA:AA:00:00:01', ip: '192.0.2.1', hostname: 'router', alias: 'Router', observation: { state: 'online', lastSeenAt: '2026-01-10T11:55:00Z' } },
    { mac: 'AA:AA:AA:00:00:02', ip: '192.0.2.2', hostname: '', vendor: 'Example Vendor', observation: { state: 'online' } },
    { mac: 'AA:AA:AA:00:00:03', ip: '192.0.2.3', knownAt: '2026-01-01T00:00:00Z', observation: { state: 'historical' } },
  ],
};

function fakeData(lastScanAt) {
  return async (route) => ({
    response: { ok: true, status: 200 },
    body: { data: route.endsWith('/agents') ? { scanners: lastScanAt ? [{ lastScanAt }] : [] } : devicesBody },
  });
}

test('the tool is declared read-only with a bounded scope', () => {
  const tool = SECRETARY_TOOLS.find((item) => item.name === 'network_devices');
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.deepEqual(tool.inputSchema.properties.scope.enum, ['online', 'unknown', 'all']);
});

test('a fresh scan lists online devices and states its age', async () => {
  const result = await readNetworkInventory({}, { fetchData: fakeData('2026-01-10T11:56:00Z'), now: () => now });
  assert.equal(result.stale, false);
  assert.equal(result.freshness, 'Dernier scan il y a 4 min.');
  assert.deepEqual(result.devices.map((device) => device.name), ['Router', null]);
  assert.deepEqual(result.counts, { total: 3, online: 2, unknown: 1 });
});

test('a stale or missing scan is said, never presented as current', () => {
  const stale = projectInventory({ devicesBody, agentsBody: { scanners: [{ lastScanAt: '2026-01-10T09:00:00Z' }] }, now });
  assert.equal(stale.stale, true);
  assert.match(stale.freshness, /^Inventaire périmé : dernier scan il y a 3 h\./);
  const none = projectInventory({ devicesBody, agentsBody: { scanners: [] }, now });
  assert.equal(none.stale, true);
  assert.match(none.freshness, /Aucun scan réseau connu/);
});

test('scope selects unknown or all devices', () => {
  const unknown = projectInventory({ devicesBody, agentsBody: {}, scope: 'unknown', now });
  assert.deepEqual(unknown.devices.map((device) => device.mac), ['AA:AA:AA:00:00:02']);
  assert.equal(projectInventory({ devicesBody, agentsBody: {}, scope: 'all', now }).returned, 3);
});

test('the MCP call relays the projection and rejects an unknown scope', async () => {
  const deps = { networkInventory: (input) => readNetworkInventory(input, { fetchData: fakeData('2026-01-10T11:56:00Z'), now: () => now }) };
  const ok = await callSecretaryTool('network_devices', { scope: 'unknown' }, deps);
  assert.equal(ok.isError, false);
  assert.equal(ok.structuredContent.devices.length, 1);
  const bad = await callSecretaryTool('network_devices', { scope: 'everything' }, deps);
  assert.equal(bad.isError, true);
  assert.equal(bad.structuredContent.error, 'INVALID_ARGUMENTS');
});

test('an unavailable Data service is an explicit tool error', async () => {
  const fetchData = async () => ({ response: { ok: false, status: 502 }, body: {} });
  const result = await callSecretaryTool('network_devices', {}, { networkInventory: (input) => readNetworkInventory(input, { fetchData }) });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error, 'DATA_UNAVAILABLE');
});
