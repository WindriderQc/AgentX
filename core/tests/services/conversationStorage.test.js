'use strict';

const mongoose = require('mongoose');
const { calculateObjectSize } = require('bson');
const { randomUUID } = require('node:crypto');
const store = require('../../src/services/conversations/transcriptStore');
const exchanges = require('../../src/services/conversations/exchangeReceipts');
const { eraseOwner } = require('../../src/services/conversations/writeFence');
const Conversation = require('../../models/Conversation');
const collection = name => mongoose.connection.collection(name);

test('immutable transcript pages retain oversized UTF-8 messages and fail on missing payload chunks', async () => {
  const owner = randomUUID();
  const content = 'été '.repeat(250000) + ' synthetic-ending';
  const messages = [{ role: 'user', content: 'Begin' }, { role: 'assistant', content }];
  const ref = await store.writeTranscript(owner, messages);
  expect(await store.readTranscript(owner, ref)).toEqual(messages);
  const pages = await store.readPageItems(owner, ref);
  expect(pages[1]._payload.ids.length).toBeGreaterThan(1);
  const search = await collection('conversation_payload_chunks').find({ owner, searchText: { $exists: true } }).toArray();
  expect(search.some(row => row.searchText.includes('synthetic-ending'))).toBe(true);
  await collection('conversation_payload_chunks').deleteOne({ _id: pages[1]._payload.ids[1], owner });
  await expect(store.readTranscript(owner, ref)).rejects.toMatchObject({ code: 'CONVERSATION_TRANSCRIPT_UNAVAILABLE' });
});

test('response recovery preserves accepted input and ordered bytes, and detects corruption', async () => {
  const scope = randomUUID();
  const input = { body: { message: 'Synthetic accepted request' } };
  const { receipt } = await exchanges.accept(scope, input, 'one-turn');
  await exchanges.append(receipt, 0, Buffer.from('Bonjour '));
  await exchanges.append(receipt, 1, Buffer.from('été'));
  await exchanges.finish(receipt, 'completed', { packets: 2, statusCode: 200 });
  expect(await exchanges.read(scope, receipt._id)).toMatchObject({ request: input, complete: true,
    response: { body: 'Bonjour été', packets: 2 } });
  expect(await exchanges.read('another-owner', receipt._id)).toBeNull();
  expect((await exchanges.accept(scope, input, 'one-turn')).duplicate).toBe(true);
  await expect(exchanges.accept(scope, { body: { message: 'Changed' } }, 'one-turn')).rejects.toMatchObject({ code: 'EXCHANGE_KEY_CONFLICT' });
  await collection('conversation_exchange_packets').updateOne({ _id: `${receipt._id}:1` }, { $set: { data: Buffer.from('corrupt') } });
  await expect(exchanges.read(scope, receipt._id)).rejects.toMatchObject({ code: 'EXCHANGE_INTEGRITY_FAILED' });
});

test('an interrupted receipt preserves partial output without claiming completion or authorizing replay', async () => {
  const scope = randomUUID();
  const { receipt } = await exchanges.accept(scope, { body: { message: 'Original' } }, 'interrupted');
  await exchanges.append(receipt, 0, Buffer.from('Partial output'));
  expect(await exchanges.read(scope, receipt._id)).toMatchObject({ state: 'accepted', complete: false,
    response: { body: 'Partial output' } });
  await exchanges.finish(receipt, 'interrupted', { packets: 1, statusCode: 499 });
  expect((await exchanges.accept(scope, { body: { message: 'Original' } }, 'interrupted')).duplicate).toBe(true);
  expect(await exchanges.read(scope, receipt._id)).toMatchObject({ state: 'interrupted', complete: false });
});

test('completed packet counts and transcript page hashes are checked before returning content', async () => {
  const scope = randomUUID();
  const { receipt } = await exchanges.accept(scope, { body: {} });
  await exchanges.finish(receipt, 'completed', { packets: 1 });
  await expect(exchanges.read(scope, receipt._id)).rejects.toMatchObject({ code: 'EXCHANGE_INTEGRITY_FAILED' });
  const ref = await store.writeTranscript(scope, [{ role: 'user', content: 'Complete transcript' }]);
  await collection('conversation_transcript_pages').updateOne({ _id: ref.pages[0] }, { $set: { items: [] } });
  await expect(store.readTranscript(scope, ref)).rejects.toMatchObject({ code: 'CONVERSATION_TRANSCRIPT_UNAVAILABLE' });
});

test('explicit erasure removes all owner content and leaves a receipt identity that cannot replay', async () => {
  const scope = randomUUID(), conversationId = randomUUID();
  const request = { body: { message: 'Synthetic content to erase' } };
  const { receipt } = await exchanges.accept(scope, request, 'erased-turn', conversationId);
  await exchanges.append(receipt, 0, Buffer.from('Response'));
  await store.writeTranscript(conversationId, [{ role: 'user', content: 'Transcript' }]);
  await exchanges.eraseConversation(conversationId);
  const row = await collection('conversation_exchange_receipts').findOne({ _id: receipt._id });
  expect(row.state).toBe('erased');
  expect(row.requestRef).toBeUndefined();
  expect(row.response).toBeUndefined();
  expect(await exchanges.read(scope, receipt._id)).toBeNull();
  for (const name of ['conversation_transcript_pages', 'conversation_payload_chunks']) {
    expect(await collection(name).countDocuments({ owner: { $in: [conversationId, `exchange:${receipt._id}`] } })).toBe(0);
  }
  await expect(exchanges.accept(scope, request, 'erased-turn')).rejects.toMatchObject({ code: 'EXCHANGE_ERASED', statusCode: 410 });
});

test('transcript publication reuses the admitted Playground writer without reacquiring or widening its root update', async () => {
  const owner = new mongoose.Types.ObjectId(), scope = randomUUID();
  const roots = collection('conversations');
  await roots.insertOne({ _id: owner, userId: scope, __v: 0, messages: [] });
  const { receipt } = await exchanges.accept(scope, { body: { message: 'Synthetic' } }, 'publication', owner);
  const messages = [{ role: 'user', content: 'été '.repeat(250000) }];
  const result = await exchanges.publish(receipt, owner, fence =>
    store.publishTranscript(owner, messages, async reference => {
      const write = await roots.updateOne({ _id: owner, userId: scope, __v: 0 },
        { $set: { transcript: reference }, $inc: { __v: 1 } });
      expect(write.matchedCount).toBe(1);
      return 'canonical-publication-completed';
    }, { fence }));
  expect(result).toBe('canonical-publication-completed');
  const row = await roots.findOne({ _id: owner });
  expect(row).toMatchObject({ userId: scope, __v: 1 });
  expect(await store.readTranscript(owner, row.transcript)).toEqual(messages);
  expect(await collection('conversation_write_fences').findOne({ _id: String(owner), token: null, state: 'OPEN' })).toBeTruthy();
  await exchanges.eraseCanonical(scope, owner, () => roots.deleteOne({ _id: owner, userId: scope }));
  expect(await roots.findOne({ _id: owner })).toBeNull();
  expect(await collection('conversation_transcript_pages').countDocuments({ owner: String(owner) })).toBe(0);
  expect(await exchanges.read(scope, receipt._id)).toBeNull();
});

test('a rejected canonical version leaves the previous reference intact and settles its acknowledged writer', async () => {
  const owner = new mongoose.Types.ObjectId(), roots = collection('conversations');
  const original = await store.writeTranscript(owner, [{ role: 'user', content: 'Original' }]);
  await roots.insertOne({ _id: owner, userId: 'synthetic-owner', __v: 1, transcript: original });
  await expect(store.publishTranscript(owner, [{ role: 'user', content: 'Stale edit' }], async reference => {
    const result = await roots.updateOne({ _id: owner, userId: 'synthetic-owner', __v: 0 }, { $set: { transcript: reference } });
    if (!result.matchedCount) throw new mongoose.Error.VersionError(new Conversation({ _id: owner }), 0, ['messages']);
  })).rejects.toBeInstanceOf(mongoose.Error.VersionError);
  expect((await roots.findOne({ _id: owner })).transcript).toEqual(original);
  expect(await collection('conversation_write_fences').findOne({ _id: String(owner), token: null, state: 'OPEN' })).toBeTruthy();
  await eraseOwner(owner, fence => store.eraseTranscript(owner, { fence }));
  expect(await collection('conversation_transcript_pages').countDocuments({ owner: String(owner) })).toBe(0);
});

test('invalid publishers and erasure contexts cannot create transcript pages', async () => {
  const owner = randomUUID();
  await expect(store.publishTranscript(owner, [], null)).rejects.toBeInstanceOf(TypeError);
  expect(await collection('conversation_write_fences').findOne({ _id: owner })).toBeNull();
  await eraseOwner(owner, async fence => {
    await expect(store.publishTranscript(owner, [{ role: 'user', content: 'Late content' }], jest.fn(), { fence }))
      .rejects.toMatchObject({ code: 'CONVERSATION_TRANSCRIPT_UNAVAILABLE' });
  });
  expect(await collection('conversation_transcript_pages').countDocuments({ owner })).toBe(0);
});

test.each([
  ['a history beyond the BSON limit', () => Array.from({ length: 140 }, (_, index) => ({
    role: 'assistant', content: `${index}:` + 'x'.repeat(128 * 1024)
  }))],
  ['one UTF-8 message beyond the BSON limit', () => [{ role: 'assistant', content: 'été🙂 '.repeat(1800000) }]]
])('canonical publication retains %s in a small root document', async (_label, buildMessages) => {
  const owner = new mongoose.Types.ObjectId(), roots = collection('conversations');
  const messages = buildMessages();
  expect(calculateObjectSize({ messages })).toBeGreaterThan(16 * 1024 * 1024);
  await roots.insertOne({ _id: owner, messages: [], __v: 0 });
  await store.publishTranscript(owner, messages, reference => roots.updateOne({ _id: owner, __v: 0 },
    { $set: { transcript: reference }, $inc: { __v: 1 } }, { writeConcern: { w: 'majority', j: true } }));
  const root = await roots.findOne({ _id: owner });
  expect(calculateObjectSize(root)).toBeLessThan(16 * 1024 * 1024);
  expect(await store.readTranscript(owner, root.transcript)).toEqual(messages);
  await eraseOwner(owner, async fence => {
    await fence.mutate(() => roots.deleteOne({ _id: owner }));
    await store.eraseTranscript(owner, { fence });
  });
  for (const name of ['conversation_transcript_pages', 'conversation_payload_chunks']) {
    expect(await collection(name).countDocuments({ owner: String(owner) })).toBe(0);
  }
});
