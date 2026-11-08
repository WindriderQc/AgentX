'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { qualifiedToolExecution } = require('../../../src/services/qualifiedToolExecution');
const profile = { think: false, sampling: { temperature: 0, top_p: 0.9, top_k: 40, repeat_penalty: 1.1 } };
const target = { inferenceContract: { capabilities: { tools: {
  supported: true, qualified: true, qualifiedExecution: profile
} } } };
test('ordinary chat, legacy evidence and unknown qualifications keep their behavior', () => {
  assert.equal(qualifiedToolExecution({ messages: [{ role: 'user' }] }, target), null);
  assert.equal(qualifiedToolExecution({ tools: [{}] }, {}), null);
  const unknown = structuredClone(target); unknown.inferenceContract.capabilities.tools.qualified = false;
  assert.equal(qualifiedToolExecution({ tools: [{}] }, unknown), null);
});
test('a final turn after tool results keeps the same execution even without offered tools', () => {
  assert.equal(qualifiedToolExecution({ messages: [{ role: 'tool' }] }, target).temperature, 0);
});
test('malformed execution evidence is refused before inference', () => {
  const bad = structuredClone(target); bad.inferenceContract.capabilities.tools.qualifiedExecution.sampling.top_k = -1;
  assert.throws(() => qualifiedToolExecution({ tools: [{}] }, bad), { code: 'TOOL_EXECUTION_PROFILE_UNAVAILABLE' });
});
