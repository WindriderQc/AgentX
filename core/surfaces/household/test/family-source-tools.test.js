'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../family-tool-registry');
const { familyToolset } = require('../family-tools');
test('family source registry rejects private sources and audience injection before any provider I/O', async () => {
  let reads = 0;
  const deps = { livingSources: { ambient: { weather: async () => { reads++; } }, brief: async () => { reads++; },
    reportsClient: { fetchBenchmarkAnalyticsSummary: async () => { reads++; }, fetchRagStatus: async () => { reads++; } } } };
  for (const arguments_ of [{ source: 'secretary' }, { source: 'comptable' }, { source: 'weather', audience: 'owner' },
    { source: 'agentx', section: 'balances' }, { source: 'weather', expectedHash: 'invalid' }]) {
    const result = await registry.callTool({ name: 'source_read', arguments: arguments_ }, deps);
    assert.equal(result.isError, true);
  }
  assert.equal(reads, 0);
  const catalogue = await registry.callTool({ name: 'source_catalogue', arguments: {} }, deps);
  assert.deepEqual(catalogue.structuredContent.sources.map(row => row.source), ['weather', 'agentx']);
  assert.equal(reads, 0);
});
test('family source tools are explicit opt-ins and share the injected safe weather provider', async () => {
  assert.equal(familyToolset({}), null);
  let reads = 0;
  const tools = familyToolset({ HOUSEHOLD_FAMILY_TOOLS: 'source_catalogue,source_read,consult_team' }, {
    toolDeps: { ambient: { weather: async () => { reads++; return { fetchedAt: new Date().toISOString(), temperatureC: 0, private: 'sentinel' }; } } }
  });
  assert.deepEqual(tools.names, ['source_catalogue', 'source_read']);
  const result = await tools.execute({ function: { name: 'source_read', arguments: { source: 'weather' } } });
  const data = JSON.parse(result.message.content);
  assert.equal(data.audience, 'household'); assert.equal(data.source, 'weather');
  assert.equal(data.status, 'available'); assert.equal(reads, 1);
  assert.doesNotMatch(result.message.content, /sentinel/);
  const denied = await tools.execute({ function: { name: 'source_read', arguments: { source: 'secretary' } } });
  assert.equal(denied.receipt.status, 'failed'); assert.equal(reads, 1);
});

test('normal source continuation errors return failed tool receipts instead of rejecting the turn', async () => {
  const tools = familyToolset({ HOUSEHOLD_FAMILY_TOOLS: 'source_read' }, {
    toolDeps: { ambient: { weather: async () => ({ fetchedAt: new Date().toISOString(), temperatureC: 0 }) } }
  });
  for (const [args, code] of [
    [{ source: 'weather', offset: 1 }, 'SOURCE_ARGUMENT_INVALID'],
    [{ source: 'weather', expectedHash: '0'.repeat(64) }, 'SOURCE_CHANGED']
  ]) {
    const result = await tools.execute({ function: { name: 'source_read', arguments: args } });
    assert.equal(result.receipt.status, 'failed');
    const data = JSON.parse(result.message.content);
    assert.equal(data.error, code);
    if (code === 'SOURCE_CHANGED') {
      assert.equal(data.retry.offset, 0);
      assert.equal(Object.hasOwn(data.retry, 'expectedHash'), false);
    }
  }
});
test('oversized pages preserve the undelivered offset and revision in a bounded retry envelope', async () => {
  const service = require('../../../src/services/livingSourceService');
  const original = service.forAudience;
  const hash = 'a'.repeat(64);
  service.forAudience = () => ({ read: async () => ({ text: 'x'.repeat(9000), contentHash: hash, nextOffset: 24500 }) });
  try {
    const tools = familyToolset({ HOUSEHOLD_FAMILY_TOOLS: 'source_read' });
    const result = await tools.execute({ function: { name: 'source_read',
      arguments: { source: 'weather', pageChars: 24000, offset: 500, expectedHash: hash } } });
    const data = JSON.parse(result.message.content);
    assert.equal(result.receipt.status, 'failed');
    assert.equal(data.error, 'SOURCE_RESULT_TOO_LARGE');
    assert.deepEqual(data.retry, { source: 'weather', offset: 500, pageChars: 1000, expectedHash: hash });
    assert.ok(result.message.content.length < 8000);
    assert.equal(Object.hasOwn(data, 'nextOffset'), false);
    service.forAudience = () => { throw Error('private-provider-sentinel'); };
    const failed = await tools.execute({ function: { name: 'source_read', arguments: { source: 'weather' } } });
    assert.equal(JSON.parse(failed.message.content).error, 'SOURCE_READ_UNAVAILABLE');
    assert.doesNotMatch(failed.message.content, /private-provider-sentinel/);
  } finally { service.forAudience = original; }
});
