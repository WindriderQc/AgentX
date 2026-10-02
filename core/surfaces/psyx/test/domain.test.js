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
  assert.match(controlSystemMessage(auto), /Mode: CHALLENGE[\s\S]*Chosen automatically after reviewing this conversation: A convenient story/);

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
