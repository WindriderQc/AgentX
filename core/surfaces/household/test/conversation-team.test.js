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

test('a member offers its own personality, its declared styles and the personalities that belong to nobody', () => {
  const offered = [...personas, { id: 'nestor_concise', name: 'Nestor · Bref', agentId: null, styleOf: 'main' },
    { id: 'native_personality', name: 'Agent personality', agentId: null, kind: 'personality' },
    { id: 'default_chat', name: 'default_chat', agentId: null }];
  // nestor_strategist carries no owner and no kind in this fixture: like a general library prompt, it is not offered.
  assert.deepEqual(Team.stylesFor(offered, 'main').map((p) => p.id), ['nestor', 'nestor_concise', 'native_personality']);
  assert.deepEqual(Team.stylesFor(offered, 'secretary').map((p) => p.id), ['secretary', 'native_personality']);
  // In the shared catalog every Nestor style names its member, so another member never borrows Nestor's voice.
  const shared = catalog.generatedPersonas().map((row) => catalog.snapshot({ ...row, version: 1, _id: 'catalog' }));
  assert.deepEqual(Team.stylesFor(shared, 'secretary').map((p) => p.id), ['native_personality', 'secretary']);
  assert.ok(Team.stylesFor(shared, 'main').length >= 6);
  // A voice chosen on the Team page is spoken as chosen, whatever presentation the browser last used.
  assert.deepEqual(presentation.speechFor({ voice: { provider: 'voxcpm', voices: { fr: 'synthetic' }, source: 'team' } }, 'fr', { presentation: 'feminine' }),
    { provider: 'voxcpm', language: 'fr', voice: 'synthetic', presentation: 'feminine' });
});
