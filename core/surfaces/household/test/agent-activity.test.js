'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { describe } = require('../public/agent-activity');

test('Nestor names the agent it consults and waits for', () => {
  const name = id => ({ comptable: 'Comptable' })[id] || id;
  assert.deepEqual(describe({ kind: 'tool', tool: 'sessions_spawn', agentId: 'comptable' }, name), { text: 'J’envoie ta question à Comptable.', spoken: true });
  assert.deepEqual(describe({ kind: 'waiting_agent', agentId: 'comptable' }, name), { text: 'J’attends la réponse de Comptable. Ça peut prendre une minute.', spoken: true });
  assert.equal(describe({ kind: 'waiting_agent' }).spoken, true);
  assert.deepEqual(describe({ kind: 'tool', tool: 'image_generate' }), { text: 'Je crée l’image.', spoken: true });
  assert.equal(describe({ kind: 'waiting_image' }).spoken, false);
});

test('known tools are spoken, unknown tools stay quiet and yields say nothing', () => {
  assert.equal(describe({ kind: 'tool', tool: 'personal_memory' }).text, 'Je consulte tes notes.');
  assert.equal(describe({ kind: 'tool', tool: 'agentx__list_personal_tasks' }).text, 'Je regarde tes tâches.');
  assert.deepEqual(describe({ kind: 'tool', tool: 'exec' }), { text: 'Outil : exec', spoken: false });
  assert.equal(describe({ kind: 'tool', tool: 'sessions_yield' }), null);
  assert.equal(describe(null), null);
});
