'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { VoiceHealth } = require('../../../public/js/voice/voice-health');

test('a normal turn shows nothing; slow recognition and a slow answer are named with their time', () => {
  const health = new VoiceHealth();
  health.turn('t1', { sttServer: 620, requestSent: 300, firstDelta: 4500 });
  assert.equal(health.notice(), '');
  health.turn('t2', { sttServer: 26834, requestSent: 300, firstDelta: 28999 });
  assert.equal(health.notice(), 'Performance réduite : transcription lente (27 s), réponse lente (29 s).');
  health.turn('t3', { sttServer: 600, requestSent: 300, firstDelta: 4000 });
  assert.equal(health.notice(), '', 'the next normal turn clears it');
  health.turn('t4', { requestSent: 300 });
  assert.equal(health.notice(), '', 'a turn without a reply or a measure is not judged');
});

test('a long wait behind a tool is work, not degraded performance, also when the turn is reported twice', () => {
  const health = new VoiceHealth();
  health.activity();
  health.turn('t1', { sttServer: 500, requestSent: 300, firstDelta: 45000 });
  health.turn('t1', { sttServer: 500, requestSent: 300, firstDelta: 45000 });
  assert.equal(health.notice(), '');
  health.turn('t2', { sttServer: 500, requestSent: 300, firstDelta: 45000 });
  assert.equal(health.notice(), 'Performance réduite : réponse lente (45 s).', 'the tool belongs to its own turn only');
});

test('speech is choppy once two of the last four clauses left the player waiting', () => {
  const health = new VoiceHealth();
  health.segment({ buffer_gap_ms: 900, buffer_gaps: 12 });
  assert.equal(health.notice(), '', 'one clause is not a pattern');
  health.segment({ buffer_gap_ms: 0 });
  health.segment({ buffer_gap_ms: 450 });
  assert.equal(health.notice(), 'Performance réduite : voix saccadée.');
  for (let i = 0; i < 3; i += 1) health.segment({ buffer_gap_ms: 20 });
  assert.equal(health.notice(), '', 'smooth clauses clear it');
  health.segment({});
  assert.equal(health.notice(), '');
});
