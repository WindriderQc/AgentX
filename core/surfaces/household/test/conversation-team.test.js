'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Team = require('../public/conversation-team');
const presentation = require('../public/persona-presentation');
const catalog = require('../persona-catalog');

const esc = (value) => String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const personas = [
  { id: 'nestor', name: 'Nestor · Majordome', agentId: 'main' },
  { id: 'nestor_strategist', name: 'Nestor · Stratège', agentId: null },
  { id: 'secretary', name: 'Secretary', agentId: 'secretary' },
  { id: 'ghost', name: 'Ghost', agentId: 'not-configured' }
];
const agents = [{ id: 'main', name: 'Main' }, { id: 'secretary', name: 'Secrétaire' }, { id: 'leadx', name: 'LeadX' }];

test('only personalities that declare a configured agent become team cards', () => {
  assert.deepEqual(Team.members(personas, agents), [
    { agentId: 'main', personaId: 'nestor', name: 'Nestor' },
    { agentId: 'secretary', personaId: 'secretary', name: 'Secrétaire' }
  ]);
  assert.equal(Team.memberName(Team.members(personas, agents), agents, 'leadx'), 'LeadX');
});

test('the active member is marked, the others are locked during a conversation, and the reason is said', () => {
  const nav = { hidden: true, innerHTML: '' };
  const list = Team.members(personas, agents);
  Team.render(nav, { list, activeAgentId: 'secretary', locked: true, esc });
  assert.equal(nav.hidden, false);
  assert.match(nav.innerHTML, /^<span class="team-label">Parler avec<\/span>/);
  assert.match(nav.innerHTML, /data-agent="secretary" data-persona="secretary" aria-pressed="true">Secrétaire</);
  assert.match(nav.innerHTML, /data-agent="main" data-persona="nestor" aria-pressed="false" disabled>Nestor</);
  assert.match(Team.lockNotice({ locked: true, name: 'Secrétaire' }), /Conversation en cours avec Secrétaire\..*« Nouvelle conversation »/);
  assert.match(Team.lockNotice({ busy: true }), /pendant que Nestor travaille/);
  assert.equal(Team.lockNotice({ locked: false }), '');
  Team.render(nav, { list: list.slice(0, 1), activeAgentId: 'main', locked: false, esc });
  assert.equal(nav.hidden, true);
});

test('the saved agent survives a reload and a personality carries its agent to the browser', () => {
  const store = new Map();
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  presentation.save(storage, { personaId: 'secretary', agentId: 'secretary', interruption: true, profiles: {} });
  assert.equal(presentation.read(storage, personas).agentId, 'secretary');
  presentation.save(storage, { personaId: 'secretary', agentId: 'bad id;', profiles: {} });
  assert.equal(presentation.read(storage, personas).agentId, null);
  const generated = catalog.generatedPersonas();
  assert.equal(generated.find((row) => row.name === 'secretary').uiConfig.layoutConfig.agentId, 'secretary');
  assert.equal(generated.find((row) => row.name === 'nestor').uiConfig.layoutConfig.agentId, 'main');
  assert.equal(generated.find((row) => row.name === 'jarvis').uiConfig.layoutConfig.agentId, null);
  const row = { name: 'secretary', version: 3, _id: 'x', systemPrompt: 'p', uiConfig: { layoutConfig: { label: 'Secretary', agentId: 'secretary' } } };
  assert.equal(catalog.snapshot(row).agentId, 'secretary');
});
