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
