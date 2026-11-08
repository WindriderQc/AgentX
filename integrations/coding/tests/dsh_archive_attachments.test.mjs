import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { attachmentReferences, verifyAttachment } from '../dsh_archive_attachments.mjs';

const data = Buffer.from('synthetic archived attachment\n');
const sha256 = createHash('sha256').update(data).digest('hex');
const ref = { attachmentId: `sha256:${sha256}`, bytes: data.length, name: 'note.txt' };

test('finds original image/file references through full native event nesting', () => {
  const image = { ...ref, mediaType: 'image/png', width: 2, height: 3 };
  const events = [{ type: 'user/prompt', data: { content: [
    { type: 'text', text: 'A reference is not its bytes' },
    { type: 'file', attachment: ref }, { type: 'image', attachment: image }
  ] } }];
  const before = JSON.stringify(events);
  const found = attachmentReferences(events);
  assert.equal(found.length, 2);
  assert.equal(found.find(x => x.kind === 'file').ref, ref);
  assert.equal(found.find(x => x.kind === 'image').ref, image);
  assert.equal(JSON.stringify(events), before);
});

test('unknown reference constructs refuse instead of counting a partial archive', () => {
  for (const record of [{ type: 'video', attachment: ref }, { type: 'image', attachment: 'missing' }]) {
    assert.throws(() => attachmentReferences([record]), /Unsupported native/);
  }
});

test('reads the native image representation without saving or projecting it', async () => {
  let received;
  const store = { readImage: async original => { received = original; return { data }; } };
  assert.deepEqual(await verifyAttachment(store, { kind: 'image', ref }), { kind: 'image', bytes: data.length, sha256 });
  assert.equal(received, ref);
});

test('exhausts a multi-chunk native file stream and verifies its exact content', async () => {
  let finished = false;
  const store = { async *readFileStream(original) {
    assert.equal(original, ref);
    yield data.subarray(0, 7); yield data.subarray(7);
    finished = true;
  } };
  assert.deepEqual(await verifyAttachment(store, { kind: 'file', ref }), { kind: 'file', bytes: data.length, sha256 });
  assert.equal(finished, true);
});

test('native errors after the last yielded chunk cannot become successful reads', async () => {
  const store = { async *readFileStream() { yield data; throw new Error('native object corrupt'); } };
  await assert.rejects(verifyAttachment(store, { kind: 'file', ref }), /native object corrupt/);
});

test('missing native objects, incorrect digests and byte-count drift refuse', async () => {
  await assert.rejects(verifyAttachment({ readImage: async () => { throw new Error('missing'); } },
    { kind: 'image', ref }), /missing/);
  for (const wrong of [{ ...ref, bytes: ref.bytes + 1 }, { ...ref, attachmentId: `sha256:${'0'.repeat(64)}` }]) {
    await assert.rejects(verifyAttachment({ readImage: async () => ({ data }) },
      { kind: 'image', ref: wrong }), /integrity mismatch/);
  }
});

test('malformed identities refuse before accessing the native store', async () => {
  for (const wrong of [{ ...ref, attachmentId: '../outside' }, { ...ref, bytes: -1 }, { ...ref, bytes: 1.5 }]) {
    await assert.rejects(verifyAttachment({}, { kind: 'image', ref: wrong }), /Invalid native/);
  }
});
