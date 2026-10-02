'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const team = require('../team-address');
const { sessionHistoryMessages } = require('../persona-records');

const members = team.teamMembers({ HOUSEHOLD_TEAM_MEMBERS: JSON.stringify({
  secretary: ['Secrétaire', 'secretary'], comptable: ['comptable'], family: ['famille'], 'bad id': ['x'] }) });

test('team members come only from the instance map, never the family agent', () => {
  assert.deepEqual(members, [{ agentId: 'secretary', names: ['secretaire', 'secretary'] }, { agentId: 'comptable', names: ['comptable'] }]);
  assert.deepEqual(team.teamMembers({}), []);
  assert.deepEqual(team.teamMembers({ HOUSEHOLD_TEAM_MEMBERS: 'not json' }), []);
});

test('only a turn that addresses a member by name, or asks it something, goes to that member', () => {
  const to = (text, current = 'main') => team.addressedMember(text, members, current)?.agentId || null;
  assert.equal(to('Secrétaire, ai-je des factures à payer?'), 'secretary');
  assert.equal(to('Hey secrétaire: mes courriels urgents?'), 'secretary');
  assert.equal(to('Bonjour Nestor, est-ce que tu peux demander à secrétaire si j\'ai des factures à payer?'), 'secretary');
  assert.equal(to('Demande à la Secrétaire mes courriels'), 'secretary');
  assert.equal(to('Ask the secretary for my unread mail'), 'secretary');
  assert.equal(to('Comptable! Combien ai-je dépensé ce mois-ci?'), 'comptable');
  assert.equal(to('Est-ce que la secrétaire a trié mes courriels hier?'), null);
  assert.equal(to('Le comptable de mon père est malade.'), null);
  assert.equal(to('Secrétaire, encore une question', 'secretary'), null);
});

test("a member's turn keeps its own native session and the conversation agent hears about it once", () => {
  const session = { sessionId: 's1', agentId: 'main', agentSessionKey: 'agent:main:household:direct:s1', voice: { selections: { fr: 'voxcpm|example' } },
    agentSessionKeys: { secretary: 'agent:secretary:household:direct:s1' }, persona: { id: 'nestor' } };
  const persona = { id: 'secretary', name: 'Secretary' };
  const turn = team.memberSession(session, members[0], persona);
  assert.deepEqual({ agentId: turn.agentId, key: turn.agentSessionKey, persona: turn.persona, voice: turn.voice },
    { agentId: 'secretary', key: 'agent:secretary:household:direct:s1', persona, voice: null });
  assert.equal(session.agentSessionKey, 'agent:main:household:direct:s1');
  assert.equal(team.memberSession({ ...session, agentSessionKeys: undefined }, members[0], null).agentSessionKey, null);
  const exchange = team.exchangeRecord(members[0], 'Secretary', 'Ai-je des factures?', 'Deux factures attendent.');
  assert.match(team.exchangeContext(exchange), /Reference data.*just asked Secretary directly: «Ai-je des factures\?».*Secretary answered: «Deux factures attendent\.»/s);
  assert.equal(team.exchangeContext(null), '');
  assert.match(team.memberInstruction('Secretary'), /addressed you \(Secretary\) directly/);
});

test('a direct answer is labelled in the history the conversation agent reads', () => {
  const rows = [{ inputText: 'Secrétaire, mes factures?', replyText: 'Deux factures attendent.', speakerAgentId: 'secretary' }];
  const history = sessionHistoryMessages(rows, { historyTurns: 4, historyMessageCharacters: 500 });
  assert.equal(history[1].content, '[Answered directly by team member secretary] Deux factures attendent.');
});
