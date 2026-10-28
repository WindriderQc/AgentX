'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FAMILY_ELIGIBLE_TOOLS, familyToolNames, familyToolset, parseArguments } = require('../family-tools');

test('Famille is offered only family-eligible Core tools the instance turned on', () => {
  assert.deepEqual(FAMILY_ELIGIBLE_TOOLS, ['iss_passes', 'web_search', 'network_devices']);
  assert.equal(familyToolset({}), null);
  assert.equal(familyToolset({ HOUSEHOLD_FAMILY_TOOLS: 'photo_search, create_todo' }), null);
  assert.deepEqual(familyToolNames({ HOUSEHOLD_FAMILY_TOOLS: ' iss_passes ,create_todo,iss_passes' }), ['iss_passes']);
  const toolset = familyToolset({ HOUSEHOLD_FAMILY_TOOLS: 'iss_passes' });
  assert.deepEqual(toolset.definitions.map(d => [d.type, d.function.name]), [['function', 'iss_passes']]);
  assert.match(toolset.instructions, /iss_passes/);
  assert.match(toolset.instructions, /never invent a tool result/);
});

test('family reads dispatch the existing web and network handlers, without owner capabilities', async () => {
  const calls = [];
  const toolset = familyToolset({ HOUSEHOLD_FAMILY_TOOLS: 'web_search,network_devices,mail_journal,personal_memory,create_todo' }, {
    toolDeps: { web_search: async input => { calls.push(['web', input]); return { results: [{ title: 'Source', url: 'https://science.example', snippet: 'Reference data' }] }; },
      networkInventory: async input => { calls.push(['network', input]); return { observedAt: '2026-01-01T00:00:00Z', devices: [], freshness: 'stale; not confirmed now' }; } }
  });
  assert.deepEqual(toolset.names, ['web_search', 'network_devices']);
  const web = await toolset.execute({ function: { name: 'web_search', arguments: { query: 'ISS orbit' } } });
  assert.equal(web.receipt.status, 'completed'); assert.match(web.message.content, /science.example/);
  const net = await toolset.execute({ function: { name: 'network_devices', arguments: { scope: 'online' } } });
  assert.equal(net.receipt.status, 'completed'); assert.match(net.message.content, /stale/);
  assert.deepEqual(calls, [['web', { query: 'ISS orbit' }], ['network', { scope: 'online' }]]);
  const bad = await toolset.execute({ function: { name: 'web_search', arguments: { query: 'ISS', url: 'file:///private' } } });
  assert.equal(bad.receipt.status, 'failed'); assert.equal(calls.length, 2);
  assert.equal((await toolset.execute({ function: { name: 'personal_memory', arguments: {} } })).receipt.status, 'refused');
});

test('Famille cannot choose coordinates for the ISS: the household location is always used', async () => {
  const calls = [];
  const toolset = familyToolset({ HOUSEHOLD_FAMILY_TOOLS: 'iss_passes' }, {
    callTool: async (params, _deps, tools) => { calls.push({ params, tools: tools.map(t => t.name) });
      return { isError: false, structuredContent: { status: 'ok', passes: [] } }; },
    now: () => new Date('2026-10-26T12:00:00Z') });
  const parameters = toolset.definitions[0].function.parameters;
  assert.equal(parameters.properties.lat, undefined);
  assert.equal(parameters.properties.lon, undefined);
  assert.ok(parameters.properties.visible_only);
  assert.match(toolset.definitions[0].function.description, /household location/);
  const answered = await toolset.execute({ function: { name: 'iss_passes', arguments: '{"visible_only":true,"lat":48.85,"lon":2.35}' } });
  assert.deepEqual(calls, [{ params: { name: 'iss_passes', arguments: { visible_only: true } }, tools: ['iss_passes'] }]);
  assert.deepEqual(answered.message, { role: 'tool', tool_name: 'iss_passes', content: '{"status":"ok","passes":[]}' });
  assert.deepEqual(answered.receipt, { tool: 'iss_passes', status: 'completed', at: '2026-10-26T12:00:00.000Z' });
});

test('unknown tools, unreadable arguments and failures are answered without running anything else', async () => {
  let ran = 0;
  const toolset = familyToolset({ HOUSEHOLD_FAMILY_TOOLS: 'iss_passes' }, {
    callTool: async () => { ran += 1; return { isError: true, structuredContent: { error: 'ISS_DATA_UNAVAILABLE', message: 'Data holds no ISS orbital elements' } }; } });
  const unknown = await toolset.execute({ function: { name: 'create_todo', arguments: {} } });
  assert.equal(unknown.receipt.status, 'refused');
  assert.match(unknown.message.content, /UNKNOWN_TOOL/);
  const garbled = await toolset.execute({ function: { name: 'iss_passes', arguments: 'not json' } });
  assert.equal(garbled.receipt.status, 'refused');
  assert.equal(ran, 0);
  const failed = await toolset.execute({ function: { name: 'iss_passes' } });
  assert.deepEqual([failed.receipt.status, failed.receipt.error], ['failed', 'ISS_DATA_UNAVAILABLE']);
  assert.match(failed.message.content, /no ISS orbital elements/);
  assert.deepEqual([parseArguments(undefined), parseArguments('[1]'), parseArguments({ a: 1 })], [{}, null, { a: 1 }]);
});
