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
test('the owner Janitor reader reuses its domain service and rejects extra capabilities', async () => {
  const service = require('../../src/services/janitorReportView');
  const read = jest.spyOn(service, 'readJanitorReportView').mockResolvedValueOnce({ readOnly: true, screenPage: 'diskx' });
  expect((await call('janitor_report_view', {})).result.structuredContent.readOnly).toBe(true);
  expect((await call('janitor_report_view', { approve: true })).result.isError).toBe(true);
  expect((await call('janitor_report_view', { group: 'bad' })).result.isError).toBe(true);
  expect(read).toHaveBeenCalledTimes(1); read.mockRestore();
});
test('unknown failures never expose private transport details', async () => {
  const response = await call('web_search', { query: 'Synthetic' }, { web_search: async () => { throw new Error('private transport'); } });
  expect(response.result).toMatchObject({ isError: true, structuredContent: { error: 'OWNER_TOOL_UNAVAILABLE' } });
  expect(JSON.stringify(response)).not.toContain('private transport');
});
test('relationship inspection uses the same Core owner and rejects ambiguous reads', async () => {
  const service = require('../../src/services/pipelineWorkReferences');
  const lookup = jest.spyOn(service, 'lookup').mockResolvedValueOnce({ matchedCount: 2, tasks: [], truncated: true });
  const reference = { kind: 'github_issue', repository: 'example/project', number: 42 };
  expect((await call('work_relationships', { action: 'lookup', reference, limit: 1 })).result.structuredContent.matchedCount).toBe(2);
  expect(lookup).toHaveBeenCalledWith(reference, 1);
  const invalid = await call('work_relationships', { action: 'lookup', reference, pipelineId: '0001' });
  expect(invalid.result.isError).toBe(true); expect(lookup).toHaveBeenCalledTimes(1);
  lookup.mockRestore();
});
test('authority inspection reuses Core and cannot add a caller identity or grant', async () => {
  const service = require('../../src/services/pipelineWorkAuthorityView');
  const read = jest.spyOn(service, 'read').mockResolvedValueOnce({ schema: 'agentx.work-authority/v1', authorization: 'none' });
  const result = await call('work_authority', { pipelineId: '0991' });
  expect(result.result.structuredContent.authorization).toBe('none');
  expect(read).toHaveBeenCalledWith('0991');
  expect((await call('work_authority', { pipelineId: '0991', authenticated: 'operator' })).result.isError).toBe(true);
  expect(read).toHaveBeenCalledTimes(1);
});
