'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PlaybackHold } = require('../public/playback-hold');

function harness() {
  const played = [];
  const context = { currentTime: 0, state: 'running', createBufferSource() {
    const node = { playbackRate: { value: 1 }, links: [],
      connect(...args) { this.links.push(args); }, disconnect() { this.disconnected = true; },
      start(...args) { this.started = args; played.push(this); },
      stop() { this.stopped = true; this.onended?.(); } };
    return node;
  } };
  const hold = new PlaybackHold(context);
  return { context, played, hold, source(at = 0, rate = 1) {
    const source = hold.playerContext.createBufferSource();
    source.buffer = { duration: 5 }; source.playbackRate.value = rate;
    source.connect({ destination: true }); source.start(at); return source;
  } };
}

test('a hold freezes the playback clock while capture continues and resumes the exact sample offset', () => {
  const h = harness(); let ends = 0;
  const source = h.source(); source.onended = () => ends++;
  h.context.currentTime = 1.25; h.hold.hold();
  assert.equal(h.played[0].stopped, true); assert.equal(ends, 0);
  h.context.currentTime = 3.25;
  assert.equal(h.hold.playerContext.currentTime, 1.25);
  assert.equal(h.context.state, 'running', 'the microphone context was never suspended');
  h.hold.resume();
  assert.deepEqual(h.played[1].started, [3.25, 1.25]);
  assert.deepEqual(h.played[1].links, h.played[0].links);
  h.played[1].onended(); assert.equal(ends, 1); assert.equal(h.hold.sources.size, 0);
});

test('future buffers preserve their order and repeated holds respect playback rate', () => {
  const h = harness(); h.source(0, .75); h.source(5);
  h.context.currentTime = 1; h.hold.hold(); h.context.currentTime = 2; h.hold.resume();
  assert.deepEqual(h.played[2].started, [2, .75]);
  assert.deepEqual(h.played[3].started, [6, 0]);
  h.context.currentTime = 3; h.hold.hold(); h.context.currentTime = 5; h.hold.resume();
  assert.deepEqual(h.played[4].started, [5, 1.5]);
  assert.deepEqual(h.played[5].started, [8, 0]);
});

test('a confirmed Stop cancels held and future sources without restarting them', () => {
  const h = harness(); let ends = 0;
  const source = h.source(); source.onended = () => ends++;
  h.context.currentTime = 1; h.hold.hold(); source.stop(); h.context.currentTime = 4; h.hold.resume();
  assert.equal(ends, 1); assert.equal(h.played.length, 1); assert.equal(h.hold.sources.size, 0);
});

test('buffers queued during a hold wait and keep their buffers until playback resumes', () => {
  const h = harness(); h.hold.hold(); const source = h.source();
  assert.equal(h.played.length, 0);
  h.context.currentTime = 1; h.hold.resume();
  assert.deepEqual(h.played[0].started, [1, 0]); assert.equal(source.buffer.duration, 5);
});
