const test = require('node:test');
const assert = require('node:assert/strict');
const { describe } = require('../../../public/js/voice/voice-workshop-view');

test('STT-only diagnostics never present the adapter bookkeeping as brain execution', () => {
  const view = describe({ phase:'thinking',hasAudio:true,recognition:{text:'Bonjour'} });
  assert.equal(view.response,'Hors de cet essai');
  assert.equal(view.tones.response,'off');
  assert.equal(view.title,'Transcription reçue.');
});
test('voice metadata and scheduling do not attest completed or audible playback', () => {
  const idle = describe({ receipt:{provider:'voxcpm',voice:'test'} });
  assert.equal(idle.voice,'À essayer');
  const scheduled = describe({ speech:'scheduled' });
  assert.equal(scheduled.voice,'Lecture programmée');
  assert.equal(scheduled.tones.voice,'active');
  assert.equal(scheduled.active,true);
  assert.equal(describe({speech:'done'}).tones.voice,'complete');
});
test('Stop and an unavailable player remain distinct from successful completion', () => {
  for (const speech of ['stopped','error']) {
    const view = describe({ speech });
    assert.equal(view.tones.voice,'caution');
    assert.equal(view.active,false);
    assert.notEqual(view.title,'Lecture terminée');
  }
});
test('an attached conversation displays only its observed phase and keeps other work unclaimed', () => {
  const thinking = describe({ phase:'thinking',embedded:true,hasAudio:true });
  assert.equal(thinking.response,'En cours');
  const paused = describe({ phase:'paused',embedded:true });
  assert.equal(paused.response,'Suivi de l’échange');
  assert.equal(paused.tones.response,'idle');
  assert.equal(paused.active,false);
  assert.equal(paused.capture,'Au repos');
});
