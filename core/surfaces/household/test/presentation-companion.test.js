'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPresentationCompanion } = require('../../../src/services/conversations/presentationCompanion');
const { frameFor, proposal } = require('../../../src/services/conversations/presentationCompanionPolicy');
const pages = require('../../../public/js/screen-pages').createCatalog([
  { id: 'ecosystem', label: 'Ecosystem', href: '/diskx?app=ecosystem', mode: 'frame' },
  { id: 'pipeline', label: 'Pipeline', href: '/pipeline', mode: 'frame' },
  { id: 'elsewhere', label: 'External', href: 'https://external.invalid', mode: 'link' }
]);
const text = 'Explique mon écosystème et son réseau.';
const block = body => ({ decision: 'present', reason: 'Situer le réseau dont on parle.',
  evidence: { source: 'request', quote: 'mon écosystème' }, block: { kind: 'page', title: 'Réseau', body } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const make = (decide, extra = {}) => createPresentationCompanion({ decide, catalog: pages, delayMs: 0, minIntervalMs: 0, ...extra });
const start = (service, turnId = 'first', extra = {}) => service.begin({ sessionId: 'personal', turnId, enabled: true, frame: { text }, ...extra });

test('validated proposals reuse catalogue focus; action payloads, invented evidence and external URLs are rejected', () => {
  const frame = frameFor({ text });
  assert.equal(proposal(block('ecosystem play=network'), frame, pages).block.from, 'companion');
  for (const raw of [block('https://external.invalid'), block('elsewhere'), block('pipeline delete=true'),
    { ...block('ecosystem'), execute: 'anything' }, { ...block('ecosystem'), evidence: { source: 'request', quote: 'unrelated invented topic' } }]) {
    assert.equal(proposal(raw, frame, pages), null);
  }
  assert.deepEqual(proposal({ decision: 'keep' }, frame, pages), { decision: 'keep' });
});

test('one in-flight decision coalesces many updates and drops its superseded answer', async () => {
  const pending = deferred(), calls = [];
  const service = make(async frame => { calls.push(frame); return calls.length === 1 ? pending.promise : block('ecosystem play=network'); });
  try {
    const handle = start(service); const first = service.flush();
    for (let i = 0; i < 30; i++) handle.append('élément ' + i + ' ');
    assert.equal(calls.length, 1);
    pending.resolve(block('ecosystem')); await first;
    assert.equal(service.read('personal', 'first').suggestion, null);
    await service.flush();
    assert.equal(calls.length, 2);
    assert.match(calls[1].reply, /élément 29/);
    assert.equal(service.read('personal', 'first').suggestion.block.body, 'ecosystem play=network');
  } finally { service.close(); }
});

test('a new user turn invalidates an admitted old result without cancelling or duplicating its inference', async () => {
  const pending = deferred(); let calls = 0;
  const service = make(async () => { calls++; return calls === 1 ? pending.promise : { decision: 'keep' }; });
  try {
    start(service); const first = service.flush(); start(service, 'second', { frame: { text: 'Changeons de sujet maintenant.' } });
    pending.resolve(block('ecosystem')); await first; await service.flush();
    assert.equal(calls, 2);
    assert.equal(service.read('personal', 'first').suggestion, null);
    assert.equal(service.read('personal', 'second').state, 'idle');
  } finally { service.close(); }
});

test('manual stop and primary presentation invalidate pending output; a stale stop cannot stop the new turn', async () => {
  const pending = deferred(); const service = make(() => pending.promise);
  try {
    const handle = start(service); const work = service.flush(); handle.explicit();
    pending.resolve(block('ecosystem')); await work;
    assert.equal(service.read('personal', 'first').state, 'paused');
    assert.equal(service.read('personal', 'first').suggestion, null);
    start(service, 'second'); service.drop('personal', 'first');
    assert.equal(service.read('personal', 'second').state, 'pending');
  } finally { service.close(); }
});

test('failed, irrelevant, aborted and disabled accompaniment cannot create displayed work', async () => {
  let calls = 0;
  const service = make(async () => { calls++; if (calls === 1) throw new Error('unavailable'); return { decision: 'keep' }; });
  try {
    assert.equal(start(service, 'disabled', { enabled: false }), null); await service.flush(); assert.equal(calls, 0);
    start(service); await service.flush(); assert.equal(service.read('personal', 'first').state, 'unavailable');
    start(service, 'unrelated'); await service.flush(); assert.equal(service.read('personal', 'unrelated').suggestion, null);
    const abort = new AbortController(); start(service, 'interrupted', { signal: abort.signal }); abort.abort();
    await service.flush(); assert.equal(calls, 2);
  } finally { service.close(); }
});

test('bounded context keeps the newest reply and a call budget never publishes an obsolete frame', async () => {
  assert.equal(frameFor({ text, reply: 'x'.repeat(6000) + 'LATEST' }).reply.endsWith('LATEST'), true);
  const pending = deferred(); const service = make(() => pending.promise, { maxCallsPerTurn: 1 });
  try {
    const handle = start(service); const work = service.flush(); handle.append('Une précision plus récente.');
    pending.resolve(block('ecosystem')); await work;
    assert.equal(service.read('personal', 'first').state, 'limited');
    assert.equal(service.read('personal', 'first').suggestion, null);
  } finally { service.close(); }
});

test('expired context and deleted sessions cannot publish an admitted old answer', async () => {
  let clock = 0; const pending = deferred(); const service = make(() => pending.promise, { now: () => clock, ttlMs: 100 });
  try {
    start(service); const work = service.flush(); clock = 101;
    assert.equal(service.read('personal', 'first').state, 'idle');
    pending.resolve(block('ecosystem')); await work;
    assert.equal(service.read('personal', 'first').suggestion, null);
  } finally { service.close(); }
});
