'use strict';
jest.mock('../../src/services/pipelineFeedback', () => ({ recordFeedback: jest.fn() }));
const { recordFeedback } = require('../../src/services/pipelineFeedback');
const { TOOLS, handleOwnerMcp } = require('../../src/services/mcpOwnerTools');
const call = args => handleOwnerMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pipeline_feedback', arguments: args } });

beforeEach(() => recordFeedback.mockReset());

test('pipeline_feedback writes through the shared feedback record and returns a compact task', async () => {
  recordFeedback.mockResolvedValue({ status: 200, data: { task: { pipelineId: 'P-12', title: 'Fix', status: 'review', feedback: [{ by: 'a' }, { by: 'codex', text: 'done' }] } } });
  const reply = await call({ pipelineId: 'P-12', by: 'codex', text: 'done', status: 'done' });
  expect(recordFeedback).toHaveBeenCalledWith('P-12', { by: 'codex', text: 'done', status: 'done' });
  expect(reply.result).toMatchObject({ isError: false, structuredContent: { pipelineId: 'P-12', status: 'review', feedback: [{ by: 'codex', text: 'done' }], alreadyRecorded: false } });
  await call({ pipelineId: 'P-12', by: 'codex', text: 'note' });
  expect(recordFeedback).toHaveBeenLastCalledWith('P-12', { by: 'codex', text: 'note' });
});

test('refusals keep their Core code; lease and evidence fields cannot be passed', async () => {
  recordFeedback.mockResolvedValue({ status: 409, error: { message: 'Task is leased', code: 'TASK_LEASED' } });
  const refused = await call({ pipelineId: 'P-12', by: 'codex', text: 'x', status: 'done' });
  expect(refused.result).toMatchObject({ isError: true, structuredContent: { error: 'TASK_LEASED', message: 'Task is leased' } });
  const extra = await call({ pipelineId: 'P-12', by: 'codex', text: 'x', leaseId: 'abc' });
  expect(extra.result.structuredContent.error).toBe('INVALID_ARGUMENTS');
  expect(TOOLS.find(tool => tool.name === 'pipeline_feedback').annotations.readOnlyHint).toBe(false);
});
