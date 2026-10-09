'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');
const { createStateRepository, emptyState } = require('../../../src/domains/psyx/stateRepository');
const assessments = require('../../../src/domains/psyx/assessments');
const { TECHNIQUES, techniquesSystemMessage } = require('../../../src/domains/psyx/techniques');
const { composeSystemContext } = require('../../../src/domains/psyx/domain');
const { readDream, dreamMessages, normalizeStoredPortrait, INTAKE_DOMAINS } = require('../../../src/domains/psyx/dream');

const { createApp } = require('../src/app');

test('questionnaires are scored by code: totals, bands, the safety item, and nothing malformed', () => {
  assert.deepEqual(assessments.KINDS, ['phq9', 'gad7']);
  assert.deepEqual([assessments.ASSESSMENTS.phq9.items.length, assessments.ASSESSMENTS.gad7.items.length], [9, 7]);
  const band = (kind, score) => { const length = assessments.ASSESSMENTS[kind].items.length; const answers = Array(length).fill(0); for (let i = 0, left = score; left > 0; i = (i + 1) % length) { if (answers[i] < 3) { answers[i] += 1; left -= 1; } } return assessments.scoreAssessment(kind, answers); };
  assert.deepEqual([0, 4, 5, 9, 10, 14, 15, 19, 20, 27].map(score => band('phq9', score).band),
    ['minimal', 'minimal', 'léger', 'léger', 'modéré', 'modéré', 'modérément sévère', 'modérément sévère', 'sévère', 'sévère']);
  assert.deepEqual([4, 5, 10, 15, 21].map(score => band('gad7', score).band), ['minimal', 'léger', 'modéré', 'sévère', 'sévère']);
  assert.equal(band('phq9', 27).score, 27);
  assert.equal(assessments.scoreAssessment('phq9', [1, 1, 0, 0, 0, 0, 0, 0, 0]).safety, false);
  assert.equal(assessments.scoreAssessment('phq9', [0, 0, 0, 0, 0, 0, 0, 0, 1]).safety, true);
  assert.equal(assessments.scoreAssessment('gad7', [3, 3, 3, 3, 3, 3, 3]).safety, false);
  for (const answers of [[1, 2], Array(9).fill(4), Array(9).fill(-1), Array(9).fill(1.5), Array(9).fill('1'), 'x', null]) {
    assert.throws(() => assessments.scoreAssessment('phq9', answers), { statusCode: 400 });
  }
  for (const kind of ['isi', 'constructor', '__proto__', 'toString', ['phq9'], null]) assert.throws(() => assessments.scoreAssessment(kind, Array(9).fill(0)), { statusCode: 400 });
  // A stored score is recomputed from its answers; a tampered or broken entry is dropped.
  const stored = assessments.normalizeAssessments([{ id: 'a', kind: 'gad7', answers: [1, 1, 1, 1, 1, 1, 1], score: 99, band: 'x', at: '2026-10-01T00:00:00Z' }, { id: 'b', kind: 'gad7', answers: [9], at: '2026-10-01' }, { kind: 'gad7' }]);
  assert.deepEqual(stored.map(item => [item.id, item.score, item.band]), [['a', 7, 'léger']]);
});

test('a questionnaire is due when never taken or three weeks old, and its result reaches the reply and the dream', () => {
  const now = new Date('2026-10-03T12:00:00Z');
  const result = (kind, answers, at) => ({ id: `${kind}-${at}`, ...assessments.scoreAssessment(kind, answers), at });
  const state = { ...emptyState(), assessments: [
    result('phq9', [2, 2, 2, 2, 1, 1, 1, 1, 0], '2026-09-01T12:00:00.000Z'), result('phq9', [1, 1, 1, 1, 1, 1, 0, 0, 1], '2026-09-30T12:00:00.000Z')] };
  assert.deepEqual(assessments.dueAssessments(emptyState(), now), ['phq9', 'gad7']);
  assert.deepEqual(assessments.dueAssessments(state, now), ['gad7']);
  assert.deepEqual(assessments.dueAssessments(state, new Date('2026-10-21T12:00:00Z')), ['phq9', 'gad7']);

  const message = assessments.assessmentSystemMessage(state, now);
  assert.match(message, /never a diagnosis/);
  assert.match(message, /a severe one is a reason to suggest it now/);
  assert.match(message, /low mood 7\/27, léger, 3 days ago, was 12 before \(-5\)\. In the last three weeks he answered above "never" to thoughts of death or self-harm[^\n]*suggest professional help now/);
  // Retaking the questionnaire does not erase the flag; three weeks later it is gone.
  const retaken = { ...state, assessments: [...state.assessments, result('phq9', Array(9).fill(0), '2026-10-02T12:00:00.000Z')] };
  assert.match(assessments.assessmentSystemMessage(retaken, now), /low mood 0\/27, minimal, 1 day ago, was 7 before \(-7\)\. In the last three weeks he answered above "never"/);
  assert.doesNotMatch(assessments.assessmentSystemMessage(state, new Date('2026-11-15T12:00:00Z')), /thoughts of death/);
  assert.match(assessments.assessmentSystemMessage(state, 'not a date'), /low mood 7\/27/);
  assert.doesNotMatch(message, /anxiety/);
  assert.equal(assessments.assessmentSystemMessage(emptyState()), '');

  const control = { mode: 'talk', depth: 'normal', action: null, reason: '' };
  const local = composeSystemContext(state, control, { conversationId: 'c', time: { now } });
  assert.match(local, /QUESTIONNAIRES —[\s\S]*TECHNIQUES —[^\n]*Respiration lente; Ancrage 5-4-3-2-1/);
  assert.doesNotMatch(local, /Inspire par le nez/);
  const wide = composeSystemContext(state, control, { conversationId: 'c', budget: 'frontier', time: { now } });
  assert.match(wide, /- Réparer avec un enfant \(5 min\)\. When: [^\n]*Steps: Attends d’être calme/);
  assert.equal(techniquesSystemMessage({ full: true }).split('\n').length, TECHNIQUES.length + 1);
  assert.match(dreamMessages({ state, conversations: [] })[1].content, /"questionnaires":\[\{"kind":"phq9","score":12/);

  // Worst local case still fits the message contract.
  const heavy = { ...state, profile: { about: 'a'.repeat(3000), expectations: 'e'.repeat(1500) },
    assessments: [...state.assessments, result('gad7', [3, 3, 3, 3, 3, 3, 3], '2026-09-01T12:00:00.000Z'), result('gad7', [2, 2, 2, 2, 2, 2, 2], '2026-09-30T12:00:00.000Z')],
    portrait: normalizeStoredPortrait({ updatedAt: '2026-10-03T03:00:00Z', sections: ['situation', 'loops', 'triggers', 'relationships', 'strengths', 'values', 'whatWorks', 'blindSpots', 'health']
      .map(key => ({ key, statements: Array.from({ length: 8 }, (_, index) => ({ text: `${key} ${index} ${'s'.repeat(40 + index * 60)}`, evidence: ['p'] })) })),
      findings: Array.from({ length: 8 }, (_, index) => ({ text: 'f'.repeat(30 + index * 50), evidence: [] })), agenda: ['x'.repeat(60), 'x'.repeat(380)], questions: ['q'.repeat(40), 'q'.repeat(280)] }),
    notes: Array.from({ length: 100 }, (_, index) => ({ text: `note ${index} ${'n'.repeat(400)}`, source: 'user', evidence: [], status: 'active' })),
    goals: Array.from({ length: 20 }, (_, index) => ({ text: `goal ${index} ${'g'.repeat(60 + index * 20)}`, source: 'user', evidence: ['e'.repeat(240)], status: 'active' })),
    experiments: Array.from({ length: 10 }, (_, index) => ({ id: `e${index}`, hypothesis: 'h'.repeat(30 + index * 30), action: 'a'.repeat(30 + index * 30), expectedSignal: 's'.repeat(index * 30), status: 'active' })),
    sessionDigests: Array.from({ length: 5 }, (_, index) => ({ conversationId: `old${index}`, summary: 's'.repeat(100 + index * 100), movement: 'm'.repeat(80), commitment: 'c'.repeat(80), updatedAt: '2026-10-01T11:00:00Z' })),
    checkIns: Array.from({ length: 5 }, (_, index) => ({ id: `k${index}`, score: 5, phase: 'start', at: '2026-10-01T11:00:00Z' })) };
  const worst = composeSystemContext(heavy, { mode: 'plan', depth: 'deep', action: 'deep_reflection', reason: 'r'.repeat(300), auto: { mode: true } },
    { voice: true, safety: { kinds: ['suicide'] }, time: { now, lastTurnAt: '2026-10-03T11:00:00Z', lastSessionAt: '2026-10-01T11:00:00Z' } });
  assert.ok(worst.length < 15800, `worst local system context is ${worst.length}`);
});

test('the dream reports intake coverage, defaulting every unknown domain', () => {
  const dream = readDream({ portrait: { sections: [] }, intake: { sleep: 'known', work: 'partial', children: 'everything', invented: 'known' } });
  assert.equal(Object.keys(dream.intake).length, INTAKE_DOMAINS.length);
  assert.deepEqual([dream.intake.sleep, dream.intake.work, dream.intake.children, dream.intake.invented], ['known', 'partial', 'unknown', undefined]);
  assert.equal(normalizeStoredPortrait({ updatedAt: '2026-10-03', sections: [], intake: { sleep: 'known' } }).intake.sleep, 'known');
});

test('answers are stored with a server-side score, shown as due or not, and a safety answer returns the crisis resources', async () => {
  const mongo = await MongoMemoryServer.create();
  const client = await MongoClient.connect(mongo.getUri());
  const stateRepository = createStateRepository({ collection: client.db('psyx').collection('psyxstates'), logger: {} });
  const config = { env: 'test', accessMode: 'token', accessToken: 'toolbox-test-token', loopbackBypass: false, sessionTtlMs: 3600000, maxBodyBytes: 65536, requestTimeoutMs: 1000, voice: { mode: 'disabled' }, frontier: {} };
  const app = createApp({ config, database: { ping: async () => true, stateRepository, conversationRepository: {} }, provider: { id: 'x', probe: async () => ({}) }, logger: {},
    dreamer: { status: () => ({}), touch() {}, request: () => false, invalidate: async () => {} }, reviewer: { status: () => ({}), schedule: () => false } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/psyx`;
  const headers = { Authorization: 'Bearer toolbox-test-token', 'Content-Type': 'application/json' };
  const post = body => fetch(`${base}/state/assessments`, { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(`${base}/toolbox`)).status, 401);
    const toolbox = (await (await fetch(`${base}/toolbox`, { headers })).json()).data;
    assert.deepEqual([toolbox.due, toolbox.assessments.phq9.max, toolbox.assessments.gad7.items.length, toolbox.techniques.length], [['phq9', 'gad7'], 27, 7, 6]);
    assert.equal(toolbox.assessments.phq9.safetyItem, undefined);

    assert.equal((await post({ kind: 'phq9', answers: [1, 2] })).status, 400);
    const calm = (await (await post({ kind: 'gad7', answers: [1, 1, 1, 1, 1, 0, 0], score: 0 })).json()).data;
    assert.deepEqual([calm.assessment.score, calm.assessment.band, calm.safety, calm.due], [5, 'léger', undefined, ['phq9']]);
    const flagged = (await (await post({ kind: 'phq9', answers: [0, 0, 0, 0, 0, 0, 0, 0, 2] })).json()).data;
    assert.equal(flagged.assessment.safety, true);
    assert.ok(flagged.safety.resources.some(item => item.contact === '9-8-8'));
    assert.deepEqual([flagged.due, flagged.state.assessments.length], [[], 2]);
    assert.equal((await stateRepository.reset('default')).assessments.length, 0);
  } finally { server.close(); await client.close(); await mongo.stop(); }
});
