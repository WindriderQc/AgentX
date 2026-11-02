'use strict';

// Nestor knows the household's time on every turn, beside the request, not in the
// stable instructions the prompt cache keeps.
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./fixtures/persona-journey.cjs');
const { localTimeContext, systemPromptFor } = require('../persona-prompt');

test('the turn context carries the household local time with its zone', () => {
  const at = new Date('2026-11-01T19:05:00Z');
  const line = localTimeContext(at, 'America/Toronto');
  assert.match(line, /^\n\nCurrent local time in the household: /);
  assert.match(line, /Sunday/);
  assert.match(line, /November 1, 2026/);
  assert.match(line, /14:05/);
  assert.match(line, /\(America\/Toronto\)\.$/);
  assert.match(localTimeContext(new Date('2026-07-01T04:30:00Z'), 'America/Toronto'), /00:30/, 'summer time, 24-hour');
});

test('the stable instructions never carry the clock', () => {
  assert.doesNotMatch(systemPromptFor(null, { latestUserText: 'Quelle heure est-il?' }), /Current local time/);

});

for (const backend of ['agentx','openclaw']) for (const packId of ['kidx_nestor','personal_operator','kidx_reader']) {
 test('one clock beside the request, never stable prefix: '+backend+'/'+packId,async()=>{
  const h=harness({packId,backend});await h.turn('Quelle heure est-il?','voice');
  const request=h.sent[0].request,prefix=h.sent[0].prefix;
  const structured=(request.match(/Household clock observed/g)||[]).length,legacy=(request.match(/Current local time in the household/g)||[]).length;
  assert.equal(structured,packId==='kidx_nestor'?1:0);assert.equal(legacy,packId==='kidx_nestor'?0:1);
  assert.doesNotMatch(prefix,/Household clock observed|Current local time in the household/);
 });
}
