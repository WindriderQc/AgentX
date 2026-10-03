'use strict';

const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const store = require('../../src/services/conversations/transcriptStore');
const exchanges = require('../../src/services/conversations/exchangeReceipts');
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
