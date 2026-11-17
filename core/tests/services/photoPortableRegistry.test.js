'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createPhotoPortableRegistry, MAX_DECISIONS, PAGE_SIZE, MAX_BYTES } = require('../../src/services/photos/photoPortableRegistry');
const A = 'a'.repeat(64), B = 'b'.repeat(64);
const card = id => ({ _id: id, metadata: { tagsTruncated: true, unknownFuture: { text: '  unchanged  ' } },
  analysis: { proposal: 'synthetic' }, review: { revision: 1, approved: true }, frame: { revision: 0, selected: false },
  updatedAt: new Date('2026-01-01T00:00:00.000Z') });
const decision = (n, sha256 = A) => ({ _id: String(n).padStart(6, '0'), sha256, state: 'completed', value: { future: true } });
function fixture(rows = [card(A)], history = [], pageOverride) {
  const calls = [];
  return { calls, service: createPhotoPortableRegistry({
    cards: { findById(id) { calls.push(['card', id]); return { lean: async () => rows.find(r => r._id === id) }; } },
    decisions: { find(filter) { calls.push(['decisions', filter]); return { sort(order) {
      assert.deepEqual(order, { _id: 1 }); return { limit(limit) { assert.equal(limit, PAGE_SIZE); return { lean: async () => pageOverride
        ? pageOverride(filter) : history.filter(d => d.sha256 === filter.sha256 && (!filter._id || d._id > filter._id.$gt))
          .sort((a,b) => a._id.localeCompare(b._id)).slice(0, limit) }; } }; } }; } }
  }) };
}
const input = (sha256s = [A]) => ({ sha256s, audience: 'owner' });
async function rejects(f, code, value = input()) { await assert.rejects(f.service.exportSelection(value), { code }); }
test('preserves complete cards and decisions without changing source; canonical stable manifest', async () => {
  const rows = [card(A), card(B)], original = JSON.stringify(rows), f = fixture(rows, [decision(2), decision(1)]);
  const out = await f.service.exportSelection(input([B,A]));
  assert.deepEqual(out.selection, [A,B]);
  assert.equal(out.entries[0].card.metadata.unknownFuture.text, '  unchanged  ');
  assert.equal(out.entries[0].card.updatedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(out.entries[0].decisions.length, 2);
  assert.equal(out.completeness.migrationReady, false);
  assert.equal(out.completeness.consistency, 'non-atomic-observation');
  assert.equal(JSON.stringify(rows), original);
  assert.deepEqual(await f.service.exportSelection(input([A,B])), out);
  const { manifestSha256, ...payload } = out;
  assert.equal(manifestSha256, createHash('sha256').update(JSON.stringify(payload)).digest('hex'));
});
test('owner opt-in required before reads including omitted audience', async () => {
  for (const audience of [undefined, null, 'family', 'Owner']) {
    const f = fixture(); await rejects(f, 'PHOTO_EXPORT_OWNER_REQUIRED', { sha256s: [A], audience }); assert.equal(f.calls.length, 0);
  }
});
test('strict bounded identities, no public paths or duplicate identities', async () => {
  for (const value of [[], [A,A], ['../photo'], [A.toUpperCase()], [1], [[A]], Array(101).fill(A)]) {
    const f = fixture(); await rejects(f, 'PHOTO_EXPORT_INVALID_SELECTION', input(value)); assert.equal(f.calls.length, 0);
  }
  await rejects(fixture(), 'PHOTO_EXPORT_INVALID_SELECTION', { ...input(), destination: '/tmp/file' });
});
test('missing cards and pending card intents refuse entire export', async () => {
  await rejects(fixture([]), 'PHOTO_EXPORT_CARD_MISSING');
  await rejects(fixture([{ ...card(A), pendingDecision: 'pending' }]), 'PHOTO_EXPORT_PENDING');
});
test('all decision pages included including exact full final page', async () => {
  const f = fixture([card(A)], Array.from({ length: 500 }, (_,n) => decision(n)));
  const out = await f.service.exportSelection(input());
  assert.equal(out.entries[0].decisions.length, 500);
  assert.equal(f.calls.filter(c => c[0] === 'decisions').length, 3);
});
test('incomplete or unknown decision state refuses', async () => {
  for (const state of ['accepted', 'uncertain', undefined]) await rejects(fixture([card(A)], [{ ...decision(1), state }]), 'PHOTO_EXPORT_PENDING');
});
test('wrong scope, duplicate or non-advancing pages refuse', async () => {
  for (const page of [[decision(1,B)], [decision(1),decision(1)], [decision(2),decision(1)], [{ ...decision(1), _id: 1 }], {}])
    await rejects(fixture([card(A)], [], () => page), 'PHOTO_EXPORT_INVALID_PAGE');
});
test('decision bound refuses rather than truncating', async () => {
  await rejects(fixture([card(A)], Array.from({ length: MAX_DECISIONS + 1 }, (_,n) => decision(n))), 'PHOTO_EXPORT_TOO_LARGE');
});
test('byte bound refuses rather than truncating', async () => {
  await rejects(fixture([{ ...card(A), future: 'x'.repeat(MAX_BYTES) }]), 'PHOTO_EXPORT_TOO_LARGE');
});
test('non-JSON values refuse instead of silent data loss', async () => {
  for (const future of [undefined, NaN, Infinity, BigInt(1), new Map(), Buffer.from('x')])
    await rejects(fixture([{ ...card(A), future }]), 'PHOTO_EXPORT_UNSERIALIZABLE');
});
test('database failure propagates, never partial success', async () => {
  const f = fixture([card(A)], [], () => { throw new Error('synthetic outage'); });
  await assert.rejects(f.service.exportSelection(input()), /synthetic outage/);
});
