'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { teamView, groupOf } = require('../agent-ops/team');
const { registerAgentOps } = require('../agent-ops/routes');

const agents = [
  { id: 'main', name: 'Main', runtime: 'openclaw', status: 'observed', type: 'openclaw_front_door' },
  { id: 'helper', name: 'Helper', runtime: 'openclaw', status: 'lead', type: 'openclaw_agent' },
  { id: 'sleeper', name: 'Sleeper', runtime: 'openclaw', status: 'unobserved', type: 'openclaw_worker_role' },
  { id: 'harness', name: 'Harness', runtime: null, status: 'registered', type: 'coding_agent' },
  { id: 'auditor', name: 'Auditor', runtime: null, status: 'registered', type: 'inspection_role' }
];
const personas = [
  { id: 'butler', version: 3, name: 'Butler', description: 'Synthetic host.', agentId: 'main', identity: 'Private personality text.',
    voice: { provider: 'kokoro', presentation: 'masculine', voices: { fr: 'synthetic_a', en: 'synthetic_b' }, source: 'instance' } },
  { id: 'butler_brief', version: 1, name: 'Butler · Brief', agentId: null, voice: { provider: 'kokoro', voices: { fr: 'synthetic_a' } } },
  { id: 'butler_bold', version: 1, name: 'Butler · Bold', agentId: null, styleOf: 'main', voice: {} },
  { id: 'ghost', version: 1, name: 'Ghost', agentId: 'departed', voice: {} }
];

test('a member is grouped by what it is: team, dormant, tool or role', () => {
  assert.deepEqual(agents.map(groupOf), ['team', 'team', 'dormant', 'tool', 'role']);
});

test('the Team view joins each agent with its persona and keeps the personality text out', () => {
  const view = teamView({ agents, summary: { registeredAgents: 5 } }, personas);
  assert.equal(view.summary.registeredAgents, 5, 'the projection is kept');
  const main = view.agents.find((agent) => agent.id === 'main');
  assert.deepEqual(main.persona, { id: 'butler', label: 'Butler', version: 3, description: 'Synthetic host.',
    voice: { provider: 'kokoro', presentation: 'masculine', voices: { fr: 'synthetic_a', en: 'synthetic_b' }, instance: true },
    visual: null, edited: false, promptHref: '/prompts?name=butler' });
  assert.equal(JSON.stringify(view).includes('Private personality text.'), false);
  assert.equal(view.agents.find((agent) => agent.id === 'helper').persona, null);
  assert.deepEqual(view.team.counts, { team: 2, dormant: 1, tool: 1, role: 1 });
  assert.deepEqual(view.team.styles.map((style) => style.id), ['butler_brief']);
  assert.deepEqual(main.styles.map((style) => style.id), ['butler_bold'], 'a style declared for a member sits on its card');
  assert.deepEqual(view.agents.find((agent) => agent.id === 'helper').styles, []);
  assert.deepEqual(view.team.orphans.map((orphan) => [orphan.id, orphan.agentId]), [['ghost', 'departed']]);
  assert.deepEqual(view.team.personas, { status: 'ok', issue: null });
});

async function get(options) {
  let handler;
  const express = { Router: () => ({ get(routePath, fn) { if (routePath === '/') handler = fn; } }) };
  registerAgentOps({ express, logger: {}, projectionProvider: async () => ({ agents }), ...options });
  const res = { set() {}, status() { return res; }, json(body) { res.body = body; return res; } };
  await handler({}, res);
  return res.body.data;
}

test('the roster is served without identities when the persona catalog is missing or fails', async () => {
  const joined = await get({ personaProvider: async () => personas });
  assert.equal(joined.agents[0].persona.label, 'Butler');
  const failed = await get({ personaProvider: async () => { throw new Error('synthetic outage'); } });
  assert.equal(failed.agents.length, 5);
  assert.equal(failed.agents[0].persona, null);
  assert.deepEqual(failed.team.personas, { status: 'unavailable', issue: 'The persona catalog could not be read.' });
  const absent = await get({});
  assert.equal(absent.team.personas.status, 'unavailable');
});

test('the identity editor sends only the fields the owner changed', () => {
  const window = { fetch: () => {} };
  new Function('window', 'document', require('node:fs').readFileSync(require('node:path').join(__dirname, '../../../public/js/agent-ops-team-editor.js'), 'utf8'))(window, {});
  const { changes } = window.AgentOpsTeamEditor.create({ esc: String, reload: async () => {} });
  const row = { name: 'butler', systemPrompt: 'Synthetic personality.', uiConfig: { layoutConfig: { label: 'Butler',
    voice: { provider: 'kokoro', voices: { fr: 'synthetic_a', en: 'synthetic_b' } }, visual: { style: 'orb', color: '#112233' } } } };
  const same = { label: 'Butler', personality: 'Synthetic personality.', provider: 'kokoro', voiceFr: 'synthetic_a', voiceEn: 'synthetic_b', style: 'orb', color: '#112233' };
  assert.deepEqual(changes(row, same), {});
  assert.deepEqual(changes(row, { ...same, label: 'Host' }), { label: 'Host' });
  assert.deepEqual(changes(row, { ...same, voiceFr: 'synthetic_c', voiceEn: '' }), { voice: { provider: 'kokoro', voices: { fr: 'synthetic_c' } } });
  assert.deepEqual(changes(row, { ...same, color: '#AABBCC' }), { visual: { style: 'orb', color: '#AABBCC' } });
  assert.deepEqual(changes(row, { ...same, style: '' }), { visual: null });
});
