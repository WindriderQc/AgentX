'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { boundedContext, composeSystemContext, normalizeControl } = require('../../../src/domains/psyx/domain');

test('trusted provider context stays inside external consumer message budgets', () => {
  const context = boundedContext(Array.from({ length: 40 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user', content: `m${index}-${'x'.repeat(11990)}`
  })));
  assert.ok(context.length < 40);
  assert.ok(context.every((item) => item.content.length <= 12000));
  assert.ok(context.reduce((sum, item) => sum + item.content.length, 0) <= 35000);
  const system = composeSystemContext({ activeThreads: [], notes: Array(100).fill('large '.repeat(300)), patterns: [], hypotheses: [], openLoops: [], experiments: [] }, normalizeControl({}));
  assert.ok(system.length < 16000);
});

test('auto stance and depth follow the review recommendation, explicit choices win', () => {
  const { resolveControl, controlSystemMessage, MODE_CONFIG, DEPTH_CONFIG } = require('../../../src/domains/psyx/domain');
  const { STANCES, DEPTHS } = require('../../../src/domains/psyx/proposals');
  assert.deepEqual(STANCES, Object.keys(MODE_CONFIG));
  assert.deepEqual(DEPTHS, Object.keys(DEPTH_CONFIG));

  assert.deepEqual(normalizeControl({}), { mode: 'auto', depth: 'auto', action: null });
  const next = { stance: 'challenge', depth: 'deep', reason: 'A convenient story is forming.' };
  const auto = resolveControl(normalizeControl({}), next);
  assert.deepEqual([auto.mode, auto.depth, auto.auto, auto.reason], ['challenge', 'deep', { mode: true, depth: true }, next.reason]);
  assert.match(controlSystemMessage(auto), /Mode: CHALLENGE[\s\S]*Chosen automatically after reviewing this conversation [^:]*: A convenient story/);

  const manual = resolveControl(normalizeControl({ mode: 'talk', depth: 'auto' }), next);
  assert.deepEqual([manual.mode, manual.depth, manual.auto, manual.reason], ['talk', 'deep', { mode: false, depth: true }, '']);
  const firstTurn = resolveControl(normalizeControl({ mode: 'auto', depth: 'auto' }), null);
  assert.deepEqual([firstTurn.mode, firstTurn.depth, firstTurn.reason], ['talk', 'normal', '']);
  assert.doesNotMatch(controlSystemMessage(normalizeControl({})), /Chosen automatically/);
});

test('crisis detection favours explicit phrasing over figures of speech', () => {
  const { detectCrisis } = require('../../../src/domains/psyx/safety');
  for (const text of ['Je pense à me suicider', 'J’ai envie d’en finir.', 'je n’ai plus envie de vivre', 'tout le monde serait mieux sans moi',
    'je me coupe encore', 'I want to kill myself', 'j’ai peur de lui faire du mal', 'J’ai pris tous mes médicaments',
    'Des fois je me dis que tout serait plus simple si je n’étais plus là', 'J’aimerais ne pas me réveiller demain']) {
    assert.ok(detectCrisis(text), text);
  }
  for (const text of ['Ça me tue de rire', 'Je veux en finir avec ce projet', 'le travail me tue', 'I need to end my shift', 'je suis crevé',
    'je ne serai plus là la semaine prochaine', 'ce serait plus simple sans mon boss']) {
    assert.equal(detectCrisis(text), null, text);
  }
  assert.ok(detectCrisis('Je veux mourir').resources.some(item => item.contact === '9-8-8'));
});

test('a new session is invited to connect to recent sessions and open experiments, never forced', () => {
  const base = { activeThreads: [], notes: [], patterns: [], hypotheses: [], openLoops: [], experiments: [], sessionDigests: [] };
  const control = normalizeControl({});
  assert.doesNotMatch(composeSystemContext(base, control), /first message of a new session/);
  const withHistory = { ...base, sessionDigests: [{ conversationId: 'old', summary: 'Hard week.', commitment: 'Pause before replying' }] };
  assert.match(composeSystemContext(withHistory, control), /first message of a new session[\s\S]*Never force it/);
  assert.doesNotMatch(composeSystemContext(withHistory, control, { conversationId: 'old' }), /first message of a new session/);
});

test('the review prompt example parses into a digest with its next-turn recommendation', () => {
  const { REVIEW_SYSTEM_PROMPT, readReview } = require('../../../src/domains/psyx/review');
  const example = REVIEW_SYSTEM_PROMPT.slice(REVIEW_SYSTEM_PROMPT.indexOf('{'), REVIEW_SYSTEM_PROMPT.indexOf('\n\nRules:'))
    .replace('talk|analyze|challenge|plan', 'plan').replace('normal|deep', 'deep');
  const review = readReview(example, { conversationId: 'c1' });
  assert.deepEqual([review.digest.conversationId, review.digest.next.stance, review.digest.next.depth], ['c1', 'plan', 'deep']);
});

test('crisis phrasing found by the adversarial review is detected, and the safety stance carries over', () => {
  const { detectCrisis, detectRecentCrisis } = require('../../../src/domains/psyx/safety');
  for (const text of ['J’ai envie de mourir', 'je veux en finir avec ma vie', 'je ne veux plus vivre', 'je n’en peux plus de vivre',
    'je voudrais être mort', 'I don’t want to live anymore', 'I want to disappear', 'I have a plan to end it',
    'je me suis coupé hier', 'je me suis fait du mal', 'je veux pas me réveiller demain']) {
    assert.ok(detectCrisis(text), text);
  }
  assert.equal(detectCrisis('il devait le tuer, ce boss'), null, 'whole words only');
  assert.equal(detectCrisis('je vais crever de faim'), null);

  const context = [{ role: 'user', content: 'Je veux mourir.' }, { role: 'assistant', content: 'Es-tu en sécurité?' }];
  const carried = detectRecentCrisis('pas vraiment', context);
  assert.deepEqual([carried.kinds, carried.carriedOver], [['suicide'], true]);
  const later = [...context, { role: 'user', content: 'ok' }, { role: 'assistant', content: '…' }, { role: 'user', content: 'merci' }];
  assert.equal(detectRecentCrisis('on parle d’autre chose', later), null, 'two calmer messages end it');
});

test('crisis detection after the second review: past intent caught, everyday cuts and bruises not', () => {
  const { detectCrisis } = require('../../../src/domains/psyx/safety');
  assert.ok(detectCrisis('j’ai pensé à en finir'));
  assert.ok(detectCrisis('je me coupe, je sais pas pourquoi'));
  assert.ok(detectCrisis('je me suis coupée hier soir'));
  for (const text of ['je me coupe les cheveux demain', 'je me suis blessé au genou', 'je me suis coupé avec un couteau en cuisinant']) {
    assert.equal(detectCrisis(text), null, text);
  }
});

test('explicit danger with intent, wrist injury and feminine medication quantities reaches the safety path', () => {
  const { detectCrisis } = require('../../../src/domains/psyx/safety');
  for (const [text, kind] of [
    ['Je me suis coupé les poignets.', 'self_harm'],
    ['Je me suis coupée les veines.', 'self_harm'],
    ['I cut my wrists.', 'self_harm'],
    ['J’ai avalé toutes mes pilules.', 'immediate_danger'],
    ['J’ai pris tous les comprimés.', 'immediate_danger'],
    ['I swallowed all my tablets.', 'immediate_danger'],
    ['J’ai décidé d’en finir ce soir.', 'suicide'],
    ['Je compte en finir demain.', 'suicide'],
    ['I decided to end my life.', 'suicide']
  ]) assert.ok(detectCrisis(text)?.kinds.includes(kind), text);
  for (const text of ['J’ai décidé d’en finir avec ce projet.', 'Je me suis coupé les cheveux.',
    'J’ai avalé ma pilule habituelle.', 'I took my medication.', 'Je me suis coupé avec un couteau en cuisinant.']) {
    assert.equal(detectCrisis(text), null, text);
  }
});

test('spoken turns request short unformatted replies without overriding crisis safety or typed behavior', () => {
  const base = { activeThreads: [], notes: [], patterns: [], hypotheses: [], openLoops: [], experiments: [] };
  const control = normalizeControl({ mode: 'talk', depth: 'normal' });
  assert.doesNotMatch(composeSystemContext(base, control), /This is a spoken turn/);
  const spoken = composeSystemContext(base, control, { voice: true, safety: {} });
  assert.match(spoken, /30 to 90 words/); assert.match(spoken, /without headings, Markdown/);
  assert.match(spoken, /Preserve all necessary crisis resources/);
  assert.match(spoken, /SAFETY|immediate safety/i);
});

test('memory written to the user is marked as such for the chat model', () => {
  const state = { activeThreads: [], notes: [], patterns: [{ text: 'Tu évites le conflit quand tu te sens jugé.' }], hypotheses: [], openLoops: [], experiments: [], sessionDigests: [] };
  const system = composeSystemContext(state, { mode: 'plan', depth: 'normal', action: null, reason: 'Tu es prêt à passer à l’action.' }, { conversationId: 'c' });
  assert.match(system, /"tu"\/"you" in them means the user, never you/);
  assert.match(system, /a note written to the user, whose "tu"\/"you" is the user\): Tu es prêt/);
});

test('profile, goals, time and the wide frontier budget reach the prompt within each lane limit', () => {
  const { timeSystemMessage, CONTEXT_BUDGETS, SYSTEM_PROMPT } = require('../../../src/domains/psyx/domain');
  const item = text => ({ text, source: 'user', evidence: [], status: 'active' });
  const state = {
    activeThreads: [], patterns: [], hypotheses: [], openLoops: [], experiments: [],
    notes: Array.from({ length: 100 }, (_, index) => item(`note ${index} ${'x'.repeat(400)}`)),
    goals: [item('Crier moins le soir avec les enfants')],
    sessionDigests: Array.from({ length: 12 }, (_, index) => ({ conversationId: `c${index}`, summary: `session ${index}`, updatedAt: '2026-10-01T10:00:00Z' })),
    profile: { about: 'Père seul de deux enfants. '.repeat(120), expectations: 'Être confronté quand je me raconte des histoires.' }
  };
  const control = { mode: 'talk', depth: 'normal', action: null, reason: '' };
  const time = { now: new Date('2026-10-03T23:30:00Z'), lastTurnAt: '2026-10-03T23:10:00Z', lastSessionAt: '2026-10-01T10:00:00Z' };

  const local = composeSystemContext(state, control, { conversationId: 'now', time, voice: true, safety: { kinds: ['suicide'] } });
  assert.ok(local.length < 16000, `local system context is ${local.length}`);
  assert.match(local, /USER PROFILE — written by the user about himself/);
  assert.match(local, /"goals":\[\{"text":"Crier moins le soir/);
  assert.match(local, /TIME — now: [A-Za-z]+, October 3, 2026[^\n]*Previous message of this conversation: 20 minutes ago\. Previous session: 3 days ago\./);
  assert.equal((local.match(/"summary":"session/g) || []).length, 3);

  const wide = composeSystemContext(state, control, { conversationId: 'now', time, budget: 'frontier' });
  assert.ok(wide.length > local.length * 2 && wide.length < SYSTEM_PROMPT.length + 46000);
  assert.equal((wide.match(/"summary":"session/g) || []).length, 10);
  assert.ok(CONTEXT_BUDGETS.frontier.maxTotalCharacters > CONTEXT_BUDGETS.local.maxTotalCharacters);
  assert.equal(timeSystemMessage({ now: new Date('2026-10-03T12:00:00Z') }).includes('Previous'), false);
  assert.match(SYSTEM_PROMPT, /Guichet d'accès à la première ligne \(811, option 3\)/);
});

test('a local prompt keeps what he expects, the open experiments and recent sessions whatever the rest weighs', () => {
  const { profileSystemMessage, timeSystemMessage } = require('../../../src/domains/psyx/domain');
  const item = text => ({ text, source: 'psyx', evidence: ['a quote '.repeat(20), 'autre-preuve'], status: 'active' });
  const experiment = (id, size) => ({ id, hypothesis: 'h'.repeat(size), action: 'a'.repeat(size), expectedSignal: 's'.repeat(size), result: '', status: 'active', checkInAt: null });
  const state = {
    activeThreads: [], patterns: [], hypotheses: [], openLoops: [], notes: [],
    goals: Array.from({ length: 20 }, (_, index) => item(`objectif ${index} ${'g'.repeat(120)}`)),
    // The newest experiment is the longest one; the older ones must survive it.
    experiments: [experiment('e1', 40), experiment('e2', 40), experiment('e3', 1000)],
    sessionDigests: [{ conversationId: 'c1', summary: 'session passée', updatedAt: '2026-10-01T10:00:00Z' }],
    profile: { about: 'Père seul. '.repeat(250), expectations: 'CONFRONTE-MOI' }
  };
  const local = composeSystemContext(state, { mode: 'talk', depth: 'normal', action: null, reason: '' }, { conversationId: 'now' });
  assert.ok(local.length < 16000);
  assert.match(local, /What he wants from PsyX: CONFRONTE-MOI/);
  assert.ok(profileSystemMessage(state, 1200).length <= 1200);
  for (const id of ['e1', 'e2', 'e3']) assert.match(local, new RegExp(`"id":"${id}"`));
  assert.match(local, /"summary":"session passée"/);
  assert.match(local, /"goals":\[/);
  assert.doesNotMatch(local, /autre-preuve/, 'a local item carries one short quote');
  assert.match(timeSystemMessage({ now: new Date('2026-10-03T12:00:30Z'), lastTurnAt: '2026-10-03T12:00:00Z' }), /a minute ago/);
});
