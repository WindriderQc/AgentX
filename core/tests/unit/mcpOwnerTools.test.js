'use strict';
const { TOOLS, handleOwnerMcp } = require('../../src/services/mcpOwnerTools');
const call = (name, args, deps) => handleOwnerMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, deps);
test('owner tools stay off shared and memory buses', async () => {
  const { handleMcpMessage } = require('../../src/services/mcpSkillBus');
  for (const profile of ['default', 'memory']) {
    const response = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, {}, { profile });
    expect(response.result.tools.some(tool => TOOLS.some(owner => owner.name === tool.name))).toBe(false);
  }
});
test('services preserve structured results and validate fields before effects', async () => {
  const team_brief = jest.fn(async () => ({ authority: 'agentx.core', amountDisplay: '12,34 $' }));
  expect((await call('team_brief', { member: 'comptable' }, { team_brief })).result.structuredContent.amountDisplay).toBe('12,34 $');
  expect((await call('team_brief', { member: 'comptable', collection: 'secrets' }, { team_brief })).result.isError).toBe(true);
  expect((await call('team_brief', { member: 'arbitrary-agent' }, { team_brief })).result.isError).toBe(true);
  expect(team_brief).toHaveBeenCalledTimes(1);
});
test('unknown failures never expose private transport details', async () => {
  const response = await call('web_search', { query: 'Synthetic' }, { web_search: async () => { throw new Error('private transport'); } });
  expect(response.result).toMatchObject({ isError: true, structuredContent: { error: 'OWNER_TOOL_UNAVAILABLE' } });
  expect(JSON.stringify(response)).not.toContain('private transport');
});
