'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');
const { SECRETARY_TOOLS, callSecretaryTool } = require('../secretary-mcp');

test('Local and Hermes receive the same Core dossier result through the shared tool, without an apply operation', async () => {
  const tool = SECRETARY_TOOLS.find(tool => tool.name === 'personal_task_dossier');
  const validate = new Ajv({ strict: false }).compile(tool.inputSchema);
  assert.equal(validate({ action: 'read', ref: '0001', threadIds: ['aaaaaaaaaaaaaaa1'] }), true);
  assert.equal(validate({ action: 'apply', ref: '0001' }), false);
  assert.equal(tool.annotations.destructiveHint, false);
  const receipt = { schema: 'agentx.personal-task-dossier/v1', sources: [], coverage: { mail: 'unavailable' }, gaps: ['Read the source before concluding.'] };
  const calls = [];
  const result = await callSecretaryTool('personal_task_dossier', { action: 'get', id: 'a'.repeat(24) }, {
    dossiers: { operate: async input => { calls.push(input); return receipt; } }
  });
  assert.deepEqual(result.structuredContent, receipt);
  assert.deepEqual(calls, [{ action: 'get', id: 'a'.repeat(24) }]);
});
