'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Decoder, Player, Speech } = require('../app/web/voice-audio.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const meta = { type: 'meta', protocol: 'voix-pcm-v1', encoding: 'f32le', channels: 1, sample_rate: 24000, provider: 'voxcpm', voice: 'nestor-a', language: 'fr' };
const frame = (sequence = 1) => ({ type: 'audio', sequence, samples: 2400, pcm: Buffer.from(new Float32Array(2400).fill(.2).buffer).toString('base64') });
const done = { type: 'done', frames: 1, samples: 2400 };
function stream() {
  let controller, cancelled = false;
  const body = new ReadableStream({ start(value) { controller = value; }, cancel() { cancelled = true; } });
  return { response: new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } }),
    send: event => controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n')),
    close: () => controller.close(), cancelled: () => cancelled };
}
class Context {
  constructor() { this.nodes = []; this.state = 'running'; this.currentTime = 0; this.destination = {}; }
  async resume() {} async close() { this.state = 'closed'; }
  createBuffer(_channels, length, sampleRate) { return { duration: length / sampleRate, sampleRate, copyToChannel() {} }; }
  createBufferSource() {
    const node = { playbackRate: { value: 1 }, connections: [], connect(...args) { this.connections.push(args); }, disconnect() {},
      start(at) { this.at = at; }, stop() { this.stopped = true; this.onended?.(); } };
    this.nodes.push(node); return node;
  }
}
test('PCM decoder rejects reordered, non-finite and truncated streams', () => {
  const decoder = new Decoder(); decoder.accept(meta);
  assert.throws(() => decoder.accept(frame(2)), /reordered/);
  assert.throws(() => decoder.accept({ ...frame(), samples: 1, pcm: Buffer.from(new Float32Array([NaN]).buffer).toString('base64') }), /samples/);
  decoder.accept(frame()); assert.throws(() => decoder.accept({ ...done, samples: 1 }), /Incomplete/);
  decoder.accept(done); assert.throws(() => decoder.accept(frame(2)), /completion/);
});
test('playback starts before synthesis completes and preserves rate and echo reference', async () => {
  const context = new Context(), source = stream(), controller = new AbortController(), reference = {}, receipts = [];
  const playing = new Player(context, { destinations: [context.destination, { node: reference, input: 1 }], onReceipt: value => receipts.push(value) })
    .play(source.response, controller.signal, { rate: .8 });
  source.send(meta); source.send(frame()); await tick();
  assert.equal(context.nodes.length, 1, 'no terminal event or closed HTTP body needed to schedule the first sound');
  assert.equal(context.nodes[0].playbackRate.value, .8);
  assert.deepEqual(context.nodes[0].connections[1], [reference, 0, 1]);
  assert.equal(receipts[0].voice, 'nestor-a');
  source.send(done); source.close(); context.nodes[0].onended();
  const metrics = await playing; assert.equal(metrics.buffer_gaps, 0);
});
test('cancellation aborts an unfinished reader and stops scheduled sound', async () => {
  const context = new Context(), source = stream(), controller = new AbortController();
  const playing = new Player(context).play(source.response, controller.signal);
  const rejected = assert.rejects(playing, { name: 'AbortError' });
  source.send(meta); source.send(frame()); await tick(); controller.abort(); await rejected;
  assert.equal(source.cancelled(), true); assert.equal(context.nodes[0].stopped, true);
});
test('a missing terminal receipt fails and clears already scheduled sound', async () => {
  const context = new Context(), source = stream();
  const rejected = assert.rejects(new Player(context).play(source.response, new AbortController().signal), /before completion/);
  source.send(meta); source.send(frame()); source.close(); await rejected;
  assert.equal(context.nodes[0].stopped, true);
});
test('replacement suppresses a late fetch even when its transport ignored cancellation', async t => {
  const contexts = [], previous = globalThis.AudioContext;
  globalThis.AudioContext = class extends Context { constructor() { super(); contexts.push(this); } };
  t.after(() => { if (previous) globalThis.AudioContext = previous; else delete globalThis.AudioContext; });
  const speech = new Speech(); let resolveOld;
  const old = speech.speak(() => new Promise(resolve => { resolveOld = resolve; }));
  const rejected = assert.rejects(old, { name: 'AbortError' }); await tick();
  const source = stream(), current = speech.speak(async () => source.response);
  source.send(meta); source.send(frame()); source.send(done); source.close(); await tick();
  resolveOld(source.response); await rejected;
  assert.equal(contexts[0].nodes.length, 0); assert.equal(contexts[0].state, 'closed');
  contexts[1].nodes[0].onended(); await current; assert.equal(contexts[1].state, 'closed');
});

test('speech scheduling receipt includes time spent awaiting the HTTP response', async t => {
  let context, now = 100, release;
  t.mock.method(performance, 'now', () => now);
  const previous = globalThis.AudioContext;
  globalThis.AudioContext = class extends Context { constructor() { super(); context = this; } };
  t.after(() => { if (previous) globalThis.AudioContext = previous; else delete globalThis.AudioContext; });
  const source = stream();
  const speaking = new Speech().speak(() => new Promise(resolve => { release = resolve; }));
  await tick(); now = 850; release(source.response);
  source.send(meta); source.send(frame()); source.send(done); source.close(); await tick();
  context.nodes[0].onended(); const metrics = await speaking;
  assert.equal(metrics.first_scheduled_ms, 750);
});
