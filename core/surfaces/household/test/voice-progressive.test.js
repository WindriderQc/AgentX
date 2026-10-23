'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Endpoint, SpeculativeRecognition } = require('../../../public/js/voice/voice-capture');
const { Conversation } = require('../../../public/js/voice/browser-conversation');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
const block = voiced => new Float32Array(100).fill(voiced ? .1 : 0);

test('rolling snapshots reuse only a prefix covering the final detected speech', () => {
  const e = new Endpoint(1000); e.progressive = true; e.earlySilenceMs = 500;
  for (let i = 0; i < 20; i++) e.push(block(true));
  const first = e.drain().find(x => x.type === 'early');
  assert.equal(first.samples.length, 2000); assert.equal(first.progressive, true);
  for (let i = 0; i < 10; i++) e.push(block(false));
  assert.equal(e.completedEarlyId, first.id);
  assert.equal(e.drain().filter(x => x.type === 'early').length, 0, 'silence alone needs no redundant decode');
  for (let i = 0; i < 20; i++) e.push(block(true));
  const old = e.drain().find(x => x.type === 'early');
  e.push(block(true)); assert.equal(e.drain()[0].id, old.id);
  for (let i = 0; i < 5; i++) e.push(block(false));
  const final = e.drain().find(x => x.type === 'early');
  assert.notEqual(final.id, old.id); assert.equal(final.samples.length, 2600);
  for (let i = 0; i < 5; i++) e.push(block(false));
  assert.equal(e.completedEarlyId, final.id);
});

test('long speech bounds rolling work and retains every sample for final recognition', () => {
  const e = new Endpoint(1000); e.progressive = true; e.earlySilenceMs = 500;
  let snapshots = 0;
  for (let i = 0; i < 300; i++) { e.push(block(true)); snapshots += e.drain().filter(x => x.type === 'early').length; }
  assert.equal(snapshots, 7);
  for (let i = 0; i < 5; i++) e.push(block(false));
  const final = e.drain().find(x => x.type === 'early'); assert.equal(final.samples.length, 30500);
  let complete; for (let i = 0; i < 5; i++) complete = e.push(block(false));
  assert.equal(complete.length, 31000); assert.equal(e.completedEarlyId, final.id);
});

test('one speculative request runs while only the latest waiting audio is retained', async () => {
  const calls = [], signals = [], gates = [];
  const scheduler = new SpeculativeRecognition((blob, language, signal) => {
    calls.push([blob.size, language]); signals.push(signal); const gate = deferred(); gates.push(gate); return gate.promise;
  });
  const lifetime = new AbortController();
  const one = scheduler.offer(new Blob(['1']), 'fr', lifetime.signal, { id: 1 });
  const two = scheduler.offer(new Blob(['22']), 'fr', lifetime.signal, { id: 2 });
  const three = scheduler.offer(new Blob(['333']), 'fr', lifetime.signal, { id: 3 });
  assert.equal(calls.length, 1); assert.equal(signals[0].aborted, false);
  assert.equal(await one.result, null); assert.equal(await two.result, null);
  gates[0].resolve({ text: 'stale' }); await tick();
  assert.deepEqual(calls, [[1, 'fr'], [3, 'fr']]);
  gates[1].resolve({ text: 'complete final prefix' });
  assert.deepEqual(await three.result, { value: { text: 'complete final prefix' } }); lifetime.abort();
});

test('resumed speech invalidates coverage, and End cancels active and waiting work', async () => {
  const first = deferred(), signals = [];
  const scheduler = new SpeculativeRecognition((_blob, _language, signal) => { signals.push(signal); return first.promise; });
  const lifetime = new AbortController();
  const a = scheduler.offer(new Blob(['a']), 'fr', lifetime.signal, { id: 1 });
  scheduler.invalidate(1); assert.equal(await a.result, null);
  scheduler.offer(new Blob(['b']), 'fr', lifetime.signal, { id: 2 });
  lifetime.abort(); assert.equal(signals[0].aborted, true);
  first.resolve({ text: 'obsolete' }); await tick(); assert.equal(signals.length, 1);
});

test('declined or failed speculation is optional', async () => {
  for (const transcribe of [() => null, () => { throw Error('busy'); }, () => Promise.reject(Error('busy'))]) {
    const scheduler = new SpeculativeRecognition(transcribe), lifetime = new AbortController();
    assert.equal(await scheduler.offer(new Blob(['sound']), 'fr', lifetime.signal, { id: 1 }).result, null); lifetime.abort();
  }
});

test('only a final covered transcript becomes a conversation request', async () => {
  let listening, calls = 0, regular = 0; const gates = [], words = [], receipts = [];
  const audio = { listen(_utterance, _speech, options) { listening = options; }, quiet() {}, close() {}, async play() {} };
  const c = new Conversation({ openAudio: async () => audio, createSession: async () => ({}),
    transcribeEarly: () => { calls++; const gate = deferred(); gates.push(gate); return gate.promise; },
    transcribe: async () => { regular++; return { text: 'whole clip' }; },
    turn: async (_session, text) => { words.push(text); return { text: 'Reçu.' }; },
    synthesize: async () => new ArrayBuffer(1), message() {}, timings: async (_s, _id, values) => receipts.push(values) });
  await c.start({ language: 'fr' }); assert.equal(listening.progressive, true);
  const epoch = c.epoch;
  listening.onEarly(new Blob(['first']), { id: 1, progressive: true }); listening.onEarlyCancel(1);
  listening.onEarly(new Blob(['final']), { id: 2, progressive: true });
  assert.equal(calls, 1); assert.deepEqual(words, []);
  const exchange = c.exchange(new Blob(['whole']), epoch, { earlyId: 2 });
  gates[0].resolve({ text: 'never submit' }); await tick(); assert.deepEqual(words, []); assert.equal(calls, 2);
  gates[1].resolve({ text: 'final words', recognitionId: '19b98eab-7a12-4a31-8d40-8802ec82da11' });
  await exchange; assert.deepEqual(words, ['final words']); assert.equal(regular, 0);
  assert.equal(receipts.at(-1).recognition.mode, 'progressive'); c.stop();
});
