'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');
const { SECRETARY_TOOLS } = require('../secretary-mcp');
const { TOOLS, handleOwnerMcp } = require('../../../src/services/mcpOwnerTools');

test('Local and Hermes receive the same Core dossier result through the shared tool, without an apply operation', async () => {
  assert.equal(SECRETARY_TOOLS.some(tool => tool.name === 'personal_task_dossier'), false);
  const tool = TOOLS.find(tool => tool.name === 'personal_task_dossier');
  const validate = new Ajv({ strict: false }).compile(tool.inputSchema);
  assert.equal(validate({ action: 'read', ref: '0001', threadIds: ['aaaaaaaaaaaaaaa1'] }), true);
  assert.equal(validate({ action: 'apply', ref: '0001' }), false);
  assert.equal(validate({ action: 'propose', id: 'a'.repeat(24), proposal: { state: 'uncertain', action: 'keep',
    summary: 'Missing details are questions, not a duty to send.', actor: '', citations: [], openQuestions: ['Room unknown.'] } }), true);
  assert.equal(tool.annotations.destructiveHint, false);
  const receipt = { schema: 'agentx.personal-task-dossier/v1', sources: [], coverage: { mail: 'unavailable' }, gaps: ['Read the source before concluding.'] };
  const calls = [];
  const reply = await handleOwnerMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'personal_task_dossier', arguments: { action: 'get', id: 'a'.repeat(24) } } }, {
    personal_task_dossier: async input => { calls.push(input); return receipt; }
  });
  const result = reply.result;
  assert.deepEqual(result.structuredContent, receipt);
  assert.deepEqual(calls, [{ action: 'get', id: 'a'.repeat(24) }]);
});
