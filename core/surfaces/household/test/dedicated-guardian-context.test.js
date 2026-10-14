'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { selectedContext, LIMITS } = require('../dedicated-guardian');

test('the Guardian context retains complete selected advice and only its actual references', () => {
  const brain = { text: '\nB'.repeat(3400), refs: [{ source: 'brain', adviceId: 'brain-1', version: 1 }] };
  const work = { text: '\nWork result: verified.', refs: [{ source: 'work', workId: 'work-1', version: 2 }] };
  const selected = selectedContext({ base: 'Current context. '.repeat(400), brain, work, tail: '\nSafety note.' });
  assert.ok(selected.text.length <= LIMITS.context);
  assert.match(selected.text, /Current context/);
  assert.match(selected.text, /Work result: verified/);
  assert.match(selected.text, /Safety note/);
  assert.doesNotMatch(selected.text, /\nB\nB/);
  assert.deepEqual(selected.refs, work.refs);
});

test('an uncut Guardian context keeps both advice references', () => {
  const brain = { text: 'Brain advice.', refs: [{ source: 'brain', adviceId: 'brain-1' }] };
  const work = { text: 'Work advice.', refs: [{ source: 'work', workId: 'work-1' }] };
  assert.deepEqual(selectedContext({ base: 'Context.', brain, work, tail: 'Safety.' }), {
    text: 'Context.Brain advice.Work advice.Safety.', refs: [...brain.refs, ...work.refs] });
});
