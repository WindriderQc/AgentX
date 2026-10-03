'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { agentForPersona } = require('../persona-selection');

test('bound personalities select their agent and tone overlays retain the selected agent', () => {
  assert.equal(agentForPersona({ id: 'secretary', agentId: 'secretary' }), 'secretary');
  assert.equal(agentForPersona({ id: 'jarvis', agentId: null }, { agentId: 'secretary' }), 'secretary');
  assert.equal(agentForPersona(null, { agentId: 'main' }), 'main');
  assert.throws(() => agentForPersona({ id: 'secretary', agentId: 'secretary' }, { agentId: 'main' }),
    { statusCode: 400, code: 'VOICE_PERSONA_AGENT_MISMATCH' });
});

test('Family retains its family agent with Nestor or no personality and rejects every other overlay', () => {
  for (const persona of [null, { id: 'nestor', agentId: 'main' }]) {
    assert.equal(agentForPersona(persona, { agentId: 'secretary', family: true }), 'family');
  }
  for (const persona of [{ id: 'secretary', agentId: 'secretary' }, { id: 'jarvis' }]) {
    assert.throws(() => agentForPersona(persona, { family: true }), { statusCode: 400, code: 'VOICE_PERSONA_FAMILY_PERSONA_REQUIRED' });
  }
});
