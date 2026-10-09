'use strict';

const mongoose = require('mongoose');
const { serialize } = require('bson');
const Conversation = require('../../models/Conversation');
const { forSurface } = require('../../src/services/surfaceConversationService');
const { conversationLifecycle } = require('../../src/services/conversationLifecycleService');
const search = require('../../src/services/conversationSearchService');

describe('durable paged conversation transcripts', () => {
  beforeAll(async () => { await Conversation.createCollection(); await Conversation.createIndexes(); });
  beforeEach(async () => { await Conversation.deleteMany({}); });

  test('stores and reloads a transcript larger than one BSON document, including a huge single message', async () => {
    const text = 'é'.repeat(9 * 1024 * 1024) + ' END';
    const row = await Conversation.create({ userId: 'large', promptName: 'test',
      messages: [{ role: 'user', content: 'Begin' }, { role: 'assistant', content: text }] });
    const stored = await Conversation.collection.findOne({ _id: row._id });
    expect(serialize(stored).length).toBeLessThan(10000);
    expect(stored.messages).toEqual([]);
    const read = await Conversation.findById(row._id).lean();
    expect(read.messages[1].content).toBe(text);
    expect((await conversationLifecycle.getConversation({ userId: 'large', promptName: 'test', conversationId: String(row._id) })).messages[1].content).toBe(text);
    const [count] = await Conversation.aggregate([{ $match: { _id: row._id } }, { $project: { count: { $size: '$messages' } } }]);
    expect(count.count).toBe(2);
  });

  test('upgrades an embedded legacy history on its next write without losing IDs or feedback', async () => {
    const id = new mongoose.Types.ObjectId(), messageId = new mongoose.Types.ObjectId();
    await Conversation.collection.insertOne({ _id: id, userId: 'legacy', __v: 0,
      messages: [{ _id: messageId, role: 'user', content: 'Legacy', feedback: { rating: -1 } }] });
    const row = await Conversation.findById(id);
    row.messages.push({ role: 'assistant', content: 'New' });
    await row.save();
    const read = await Conversation.findOne({ 'messages._id': messageId }).lean();
    expect(read.messages).toHaveLength(2);
    expect(read.messages[0]).toMatchObject({ _id: messageId, content: 'Legacy', feedback: { rating: -1 } });
  });

  test('refuses a stale save and preserves the committed writer', async () => {
    const row = await Conversation.create({ messages: [{ role: 'user', content: 'Original' }] });
    const a = await Conversation.findById(row._id), b = await Conversation.findById(row._id);
    a.messages.push({ role: 'assistant', content: 'Committed' }); await a.save();
    b.messages.push({ role: 'assistant', content: 'Stale' });
    await expect(b.save()).rejects.toMatchObject({ code: 'CONVERSATION_WRITE_CONFLICT' });
    expect((await Conversation.findById(row._id)).messages.map(m => m.content)).toEqual(['Original', 'Committed']);
  });

  test('does not return incomplete history when a referenced page is missing', async () => {
    const row = await Conversation.create({ messages: [{ role: 'user', content: 'Complete only' }] });
    await mongoose.connection.collection('conversation_transcript_pages').deleteOne({ _id: row.transcript.pages[0] });
    await expect(Conversation.findById(row._id).lean()).rejects.toMatchObject({ code: 'CONVERSATION_TRANSCRIPT_UNAVAILABLE' });
    await expect(Conversation.aggregate([{ $match: { _id: row._id } }, { $project: { count: { $size: '$messages' } } }])).rejects.toMatchObject({ code: 'CONVERSATION_TRANSCRIPT_UNAVAILABLE' });
  });

  test('preserves UTF-8 search content beyond binary chunk boundaries and edits a newly saved message', async () => {
    const row = await Conversation.create({ userId: 'unicode-search', messages: [
      { role: 'assistant', content: 'été '.repeat(400000) + ' uniquekangaroo' }] });
    const found = await search.searchConversations({ userId: 'unicode-search', query: 'uniquekangaroo' });
    expect(found.data.results.map(item => String(item._id))).toContain(String(row._id));
    row.messages[0].content = 'Changed immediately after save';
    await row.save();
    expect((await Conversation.findById(row._id)).messages[0].content).toBe('Changed immediately after save');
  });

  test('searches the current full content, including beyond the large-message projection', async () => {
    const row = await Conversation.create({ userId: 'search', messages: [
      { role: 'assistant', content: 'padding '.repeat(80000) + ' uniquezebra' }] });
    const result = await search.searchConversations({ userId: 'search', query: 'uniquezebra' });
    expect(result.data.results.map(r => String(r._id))).toContain(String(row._id));
    const changed = await Conversation.findById(row._id);
    changed.messages[0].content = 'Changed';
    expect(changed.isModified('messages')).toBe(true);
    await changed.save();
    expect((await Conversation.findById(row._id)).messages[0].content).toBe('Changed');
    const absent = await search.searchConversations({ userId: 'search', query: 'uniquezebra' });
    expect(absent.data.results).toHaveLength(0);
  });

  test('updates receipts on a large turn and erases its pages and payloads with the session', async () => {
    const service = forSurface('test-surface');
    const session = await service.createSession({ sessionId: 'large-turn', packId: 'test', scopeId: 'test', modeId: 'test' });
    const turn = await service.recordTurn({ traceId: 'large-trace', sessionId: session.sessionId, packId: 'test', scopeId: 'test',
      inputText: 'Question', replyText: 'reply '.repeat(2000),
      toolEvidence: { details: 'synthetic evidence '.repeat(60000) } });
    const updated = await service.updateTurn({ _id: turn._id, sceneReceipt: null }, { $set: { sceneReceipt: { status: 'rejected' }, interrupted: true } });
    expect(updated.replyText).toBe(turn.replyText);
    expect(updated.interrupted).toBe(true);
    await service.deleteSession({ sessionId: session.sessionId, packId: 'test', scopeId: 'test' });
    expect(await mongoose.connection.collection('conversation_transcript_pages').countDocuments({ owner: session.conversationId })).toBe(0);
    expect(await mongoose.connection.collection('conversation_payload_chunks').countDocuments({ owner: session.conversationId })).toBe(0);
  });

  test('rehydrates large scene evidence and refuses a condition that would depend on its index projection', async () => {
    const service = forSurface('test-surface');
    const session = await service.createSession({ sessionId: 'large-scene', packId: 'test', scopeId: 'test', modeId: 'test' });
    const evidence = { status: 'applied', details: 'full evidence '.repeat(60000) };
    await service.recordTurn({ traceId: 'large-scene-trace', sessionId: session.sessionId, packId: 'test', scopeId: 'test',
      inputText: 'Question', replyText: 'Response', sceneReceipt: evidence });
    expect((await service.getTurn({ traceId: 'large-scene-trace' })).sceneReceipt).toEqual(evidence);
    await expect(service.updateTurn({ traceId: 'large-scene-trace', sceneReceipt: null },
      { $set: { sceneReceipt: { status: 'rejected' } } })).rejects.toMatchObject({ code: 'CONVERSATION_QUERY_REQUIRES_FULL_CONTENT' });
    expect((await service.getTurn({ traceId: 'large-scene-trace' })).sceneReceipt).toEqual(evidence);
  });
});
