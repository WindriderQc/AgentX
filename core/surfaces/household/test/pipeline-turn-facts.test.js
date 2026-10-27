'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { requestsPipelineRead, pipelineTurn } = require('../native-pipeline-policy');
const spoken = require('../../../src/services/pipelineSpokenFacts');
const { factsFor, answerFor } = require('../pipeline-turn-facts');
const { createReplyChannels } = require('../reply-channels');

const facts = {
  authority: 'core.pipeline', observedAt: '2026-10-26T19:00:00.000Z',
  counts: { queued: 3, in_progress: 0, review: 6, blocked: 9, done: 661 },
  keyTasks: { blocked: [{ pipelineId: '0917', title: 'Label normalization', status: 'blocked', priority: 1 },
    { pipelineId: '0921', title: 'Active model check', status: 'blocked', priority: 2 }], review: [] },
  tasks: [{ pipelineId: '0918', title: 'Review correction', status: 'review', priority: 1 }], missingTasks: []
};

test('showing, opening and blocked-task requests are Pipeline turns; a follow-up counts while Pipeline is on screen (#924)', () => {
  for (const text of ['Montre-moi le pipeline de code AgentX.', 'Ouvre-moi la tâche 0918 dans le pipeline.', 'Affiche les tâches bloquées du pipeline.']) {
    assert.equal(requestsPipelineRead(text), true, text);
  }
  assert.equal(pipelineTurn('Lesquelles sont bloquées ?', null), false);
  assert.equal(pipelineTurn('Lesquelles sont bloquées ?', { page: 'pipeline', status: 'visible' }), true);
  assert.equal(pipelineTurn('Lesquelles sont bloquées ?', { page: 'analytics', status: 'visible' }), false);
  assert.equal(pipelineTurn('Ne regarde pas mon pipeline.', null), false);
});

test('the spoken sentence gives the count and key tasks for the shown focus', () => {
  assert.equal(spoken.sentence(facts, { status: 'blocked' }), '9 tâches bloquées. Les premières : 0917, Label normalization ; 0921, Active model check.');
  assert.equal(spoken.sentence(facts, { task: '0918' }), 'La tâche 0918, Review correction, est en revue, priorité 1.');
  assert.equal(spoken.sentence(facts, {}), 'Le pipeline compte 3 en file, 0 en cours, 6 en revue et 9 bloquées. Bloquées en premier : 0917, Label normalization ; 0921, Active model check.');
  assert.equal(spoken.sentence(facts, { status: 'review' }), '6 tâches en revue.');
  assert.match(spoken.sentence(facts, { task: '0999' }), /0999 n’est pas/);
  const archived = { ...facts, tasks: [{ ...facts.tasks[0], archivedQualification: true }] };
  assert.equal(spoken.sentence(archived, { task: '0918' }), 'La tâche 0918, Review correction, est en revue, priorité 1. C’est une qualification archivée, hors des compteurs.');
  assert.match(spoken.sentence(facts, { status: 'blocked' }, 'en'), /^9 tasks blocked\. First: 0917/);
  assert.match(spoken.context(facts), /never answer with a screen pointer alone/);
  assert.equal(spoken.context(null), '');
});

test('the read uses the page scope: engineering tasks without archived qualifications', async () => {
  const calls = [];
  const chain = rows => ({ sort: () => ({ limit: () => ({ select: () => ({ lean: async () => rows }) }) }), select: () => ({ lean: async () => rows }) });
  const PipelineTask = {
    aggregate: async pipeline => { calls.push(pipeline[0].$match); return [{ _id: 'blocked', count: 9 }, { _id: 'review', count: 6 }, { _id: 'weird', count: 1 }]; },
    find: query => { calls.push(query); return query.pipelineId ? chain([{ pipelineId: '0918', title: 'Review correction', status: 'review', priority: 1,
      codingAutonomy: { disposition: { kind: 'qualification' } } }])
      : chain(query.status === 'blocked' ? [{ pipelineId: '0917', title: 'x'.repeat(200), status: 'blocked', priority: 1 }] : []); }
  };
  const result = await spoken.read({ PipelineTask, taskIds: ['0918', '0999', 'abc'], now: () => 0 });
  assert.deepEqual(result.counts, { queued: 0, in_progress: 0, review: 6, blocked: 9, done: 0 });
  assert.equal(result.keyTasks.blocked[0].title.length, 80);
  assert.deepEqual(result.tasks, [{ pipelineId: '0918', title: 'Review correction', status: 'review', priority: 1, archivedQualification: true }]);
  assert.deepEqual(result.missingTasks, ['0999']);
  const named = calls.find(query => query.pipelineId);
  assert.equal(named.$and.length, 1, 'a named archived qualification is still found');
  assert.ok(named.$and[0].service.$not.test('family'));
  for (const query of calls.filter(query => !query.pipelineId)) {
    assert.deepEqual(query.$and[1], { 'codingAutonomy.disposition.kind': { $ne: 'qualification' } });
    assert.ok(query.$and[0].service.$not.test('personal'));
  }
});

test('facts are read only for a Pipeline turn, and a failed read changes nothing', async () => {
  assert.equal(await factsFor('Raconte une blague.', null, { read: async () => facts }), null);
  let asked;
  assert.equal(await factsFor('Montre-moi la tâche 0918 du pipeline.', null, { read: async options => { asked = options; return facts; } }), facts);
  assert.deepEqual(asked.taskIds, ['0918']);
  assert.equal(await factsFor('Montre-moi le pipeline.', null, { read: async () => { throw new Error('db down'); } }), null);
  assert.equal(answerFor(null), null);
});

function turn(reply, answerForPage) {
  const said = [];
  const channels = createReplyChannels({ allowPages: true, answerForPage, onSay: text => said.push(text) });
  channels.push(reply);
  return { ...channels.end(), streamed: said.join('') };
}

test('a screen pointer alone gets the answer Core read; a reply with figures is left as spoken', () => {
  const catalog = require('../../../public/js/screen-pages');
  const answer = answerFor(facts, catalog, 'fr');
  const pointer = turn('Je filtre le pipeline pour afficher seulement les tâches bloquées. <show kind="page">pipeline status=blocked</show>', answer);
  assert.match(pointer.say, /^Je filtre le pipeline.*\. 9 tâches bloquées\. Les premières : 0917/);
  assert.equal(pointer.streamed, pointer.say, 'the added sentence is streamed to speech too');
  const answered = turn('Il y a 9 tâches bloquées, dont la 0917. <show kind="page">pipeline status=blocked</show>', answer);
  assert.equal(answered.say, 'Il y a 9 tâches bloquées, dont la 0917.');
  const other = turn('Voici les stats. <show kind="page">analytics</show>', answer);
  assert.doesNotMatch(other.say, /tâches/);
});
