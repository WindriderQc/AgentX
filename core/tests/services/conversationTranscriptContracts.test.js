'use strict';

const mongoose = require('mongoose');
const { Writable } = require('node:stream');
const Conversation = require('../../models/Conversation');
const { forSurface } = require('../../src/services/surfaceConversationService');
const store = require('../../src/services/conversations/transcriptStore');
const { MongoNetworkError } = require('mongodb');

beforeAll(async () => { await Conversation.createCollection(); await Conversation.createIndexes(); });
beforeEach(async () => { await Conversation.deleteMany({}); });

test('full-text terms, phrases and exclusions agree with native Mongo across current messages and titles', async () => {
  const oracle = mongoose.connection.collection('transcript_search_oracle');
  await oracle.deleteMany({});
  await oracle.createIndex({ title: 'text', 'messages.content': 'text' },
    { weights: { title: 10, 'messages.content': 5 } });
  const phrase = 'amber '.repeat(60) + 'penguin';
  const inputs = [
    { title: 'Amber penguin', messages: ['running horses', 'forbidden zebra'] },
    { title: 'Ordinary', messages: ['horses run', 'amber penguin café CAFÉ'] },
    { title: 'Forbidden', messages: ['padding '.repeat(80000) + ' horse amber penguin'] },
    { title: 'Other', messages: ['padding '.repeat(149770) + phrase + ' café'] },
    { title: 'Other', messages: ['amber', 'penguin'] },
    { title: 'Window boundary', messages: ['x '.repeat(524286) + 'kangaroo'] },
    { title: 'Preview boundary', messages: ['x '.repeat(2046) + 'kangaroo ' + 'padding '.repeat(80000)] }
  ];
  for (const input of inputs) {
    const row = await Conversation.create({ userId: 'oracle', title: input.title,
      messages: input.messages.map(content => ({ role: 'assistant', content })) });
    await oracle.insertOne({ _id: row._id, title: input.title,
      messages: input.messages.map(content => ({ content })) });
  }
  for (const expression of [
    { $search: 'horse' }, { $search: 'running' }, { $search: 'kang' }, { $search: 'kangaroo' }, { $search: 'penguin -forbidden' },
    { $search: 'horse -zebra' }, { $search: 'penguin -"amber penguin"' },
    { $search: '"amber penguin" horse' }, { $search: '"amber penguin" "running horses"' },
    { $search: `"${phrase}"` }, { $search: '-horse' }, { $search: 'cafe' },
    { $search: 'CAFÉ', $caseSensitive: true }, { $search: 'cafe', $diacriticSensitive: true }
  ]) {
    const expected = await oracle.find({ $text: expression }, { projection: { _id: 1 } }).toArray();
    const actual = await Conversation.aggregate([{ $match: { userId: 'oracle', $text: expression } },
      { $project: { _id: 1 } }]);
    expect({ expression, ids: actual.map(row => String(row._id)).sort() }).toEqual({ expression,
      ids: expected.map(row => String(row._id)).sort() });
  }
});

test('search remains owner-scoped and refuses a missing current search chunk', async () => {
  const row = await Conversation.create({ userId: 'search-owner', messages: [
    { role: 'assistant', content: 'padding '.repeat(80000) + 'kangaroo' }] });
  const items = await store.readPageItems(row._id, row.transcript);
  await mongoose.connection.collection('conversation_payload_chunks').deleteOne({ _id: items[0]._payload.searchIds[0] });
  expect(await Conversation.aggregate([{ $match: { userId: 'different-owner', $text: { $search: 'kangaroo' } } }])).toEqual([]);
  await expect(Conversation.aggregate([{ $match: { userId: 'search-owner', $text: { $search: 'kangaroo' } } }]))
    .rejects.toMatchObject({ code: 'CONVERSATION_TRANSCRIPT_UNAVAILABLE' });
});

test('message projections and cursors retain their selected fields and cannot overwrite partial history', async () => {
  const row = await Conversation.create({ userId: 'projection', messages: [
    { role: 'user', content: 'Private synthetic text', metadata: { clientTurnId: 'one', evidence: 'Private evidence' } },
    { role: 'assistant', content: 'Full response' }] });
  const selected = await Conversation.findById(row._id).select('_id messages.metadata.clientTurnId').lean();
  expect(selected.messages).toEqual([{ metadata: { clientTurnId: 'one' } }, {}]);
  const excluded = await Conversation.findById(row._id).select('-messages.content').lean();
  expect(excluded.messages.every(message => !Object.hasOwn(message, 'content'))).toBe(true);
  const partial = await Conversation.findById(row._id).select({ messages: { $slice: -1 } });
  expect(partial.messages).toHaveLength(1);
  partial.messages[0].content = 'Partial overwrite';
  await expect(partial.save()).rejects.toMatchObject({ code: 'CONVERSATION_TRANSCRIPT_UNSUPPORTED_WRITE' });
  const cursor = Conversation.find({ userId: 'projection' }).lean().cursor({ batchSize: 1 });
  const rows = [];
  for await (const entry of cursor) rows.push(entry);
  expect(rows[0].messages.map(message => message.content)).toEqual(['Private synthetic text', 'Full response']);
});

test('query return-before, return-after and narrow projections preserve the message snapshot', async () => {
  const row = await Conversation.create({ messages: [{ role: 'user', content: 'Before' }] });
  const before = await Conversation.findOneAndUpdate({ _id: row._id },
    { $push: { messages: { role: 'assistant', content: 'After' } } });
  expect(before.messages.map(message => message.content)).toEqual(['Before']);
  const after = await Conversation.findOneAndUpdate({ _id: row._id }, { $set: { title: 'Changed' } },
    { new: true }).select('_id messages.role').lean();
  expect(after.messages).toEqual([{ role: 'user' }, { role: 'assistant' }]);
});

test('an invalid ordered insert batch does not insert its valid prefix', async () => {
  await expect(Conversation.insertMany([{ messages: [{ role: 'user', content: 'Valid' }] },
    { messages: [{ content: 'Missing role' }] }])).rejects.toBeInstanceOf(mongoose.Error.ValidationError);
  expect(await Conversation.countDocuments({})).toBe(0);
});

test('document deletion closes admission and removes the complete transcript', async () => {
  const row = await Conversation.create({ messages: [{ role: 'user', content: 'Delete through the document API' }] });
  await row.deleteOne();
  expect(await Conversation.findById(row._id)).toBeNull();
  expect(await mongoose.connection.collection('conversation_transcript_pages').countDocuments({ owner: String(row._id) })).toBe(0);
  await expect(row.save()).rejects.toMatchObject({ code: 'CONVERSATION_CONTENT_ERASED' });
});

test('an unacknowledged model root write retains its exact fence after Mongo applied the command', async () => {
  const row = await Conversation.create({ messages: [{ role: 'user', content: 'Original' }] });
  const native = Conversation.collection.findOneAndUpdate.bind(Conversation.collection);
  const command = jest.spyOn(Conversation.collection, 'findOneAndUpdate').mockImplementationOnce(async (...args) => {
    await native(...args);
    throw new MongoNetworkError('Synthetic lost acknowledgement');
  });
  try {
    await expect(Conversation.updateOne({ _id: row._id }, { $push: { messages: { role: 'assistant', content: 'Committed, unacknowledged' } } }))
      .rejects.toBeInstanceOf(MongoNetworkError);
  } finally { command.mockRestore(); }
  expect(await mongoose.connection.collection('conversation_write_fences').findOne({ _id: String(row._id), state: 'UNKNOWN', token: { $ne: null } })).toBeTruthy();
  await expect(Conversation.deleteOne({ _id: row._id })).rejects.toMatchObject({ code: 'CONVERSATION_WRITE_RECOVERY_REQUIRED' });
  expect((await Conversation.findById(row._id)).messages.map(message => message.content)).toEqual(['Original', 'Committed, unacknowledged']);
  // This database is disposable; remove only the fixture retained for this test.
  await Conversation.collection.deleteOne({ _id: row._id });
});

test('surface export contains every byte, message ID and audit field beyond a BSON document', async () => {
  const service = forSurface('export-proof');
  const session = await service.createSession({ sessionId: 'full-export', packId: 'test', scopeId: 'test', modeId: 'test' });
  const text = 'é'.repeat(9 * 1024 * 1024) + ' LAST';
  const row = await Conversation.findById(session.conversationId);
  row.messages.push({ role: 'assistant', content: text, metadata: { source: 'synthetic export proof' } });
  await row.save();
  const buffers = [];
  await service.exportSession({ sessionId: session.sessionId, packId: 'test', scopeId: 'test' },
    new Writable({ write(chunk, encoding, done) { buffers.push(chunk); done(); } }));
  const exported = JSON.parse(Buffer.concat(buffers).toString('utf8'));
  expect(exported.conversation.messages[0]).toMatchObject({ _id: String(row.messages[0]._id),
    content: text, metadata: { source: 'synthetic export proof' } });
  expect(exported.attachments).toEqual([]);
  const raw = await Conversation.collection.findOne({ _id: row._id });
  const [item] = await store.readPageItems(row._id, raw.transcript);
  await mongoose.connection.collection('conversation_payload_chunks').deleteOne({ _id: item._payload.ids[0] });
  const write = jest.fn((chunk, encoding, done) => done());
  await expect(service.exportSession({ sessionId: session.sessionId, packId: 'test', scopeId: 'test' },
    new Writable({ write }))).rejects.toMatchObject({ code: 'CONVERSATION_TRANSCRIPT_UNAVAILABLE' });
  expect(write).not.toHaveBeenCalled();
});
