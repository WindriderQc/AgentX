'use strict';

const { randomUUID } = require('node:crypto');

jest.mock('../../src/services/principalModelService', () => ({
  getPrincipalModel: jest.fn(async () => ({ model: 'pinned-synthetic' }))
}));

const Conversation = require('../../models/Conversation');
const { forSurface } = require('../../src/services/surfaceConversationService');

// Surface turns write the same message stats the Playground writes, so the
// chat-lane analytics stop reading household turns as zero tokens.
describe('surface turn usage, model and RAG evidence', () => {
  const conversations = forSurface('household');
  let session;
  beforeAll(async () => { await Conversation.createCollection(); await Conversation.createIndexes(); });
  beforeEach(async () => {
    await Conversation.deleteMany({});
    session = await conversations.createSession({ sessionId: randomUUID(), packId: 'personal_operator',
      modeId: 'personal', scopeId: 'personal', label: 'Synthetic conversation', backend: 'agentx' });
  });
  const scope = () => ({ sessionId: session.sessionId, packId: session.packId, scopeId: session.scopeId, modeId: session.modeId });
  const assistant = row => row.messages.find(message => message.role === 'assistant');

  test('a recorded turn keeps measured tokens, its served model and the conversation RAG flags', async () => {
    await conversations.recordTurn({ ...scope(), traceId: randomUUID(), inputText: 'Synthetic question', replyText: 'Synthetic reply',
      model: 'local-synthetic', usage: { prompt_eval_count: 120, eval_count: 30 },
      knowledgeStatus: 'ready', knowledgeSourceCount: 2, knowledgeUsed: true });
    const row = await Conversation.findById(session.conversationId).lean();
    const message = assistant(row);
    expect(message.stats.usage).toEqual({ promptTokens: 120, completionTokens: 30, totalTokens: 150 });
    expect(message.stats.meta).toEqual({ model: 'local-synthetic' });
    expect(message.cost.currency).toBe('USD');
    expect(message.turn).toMatchObject({ model: 'local-synthetic', knowledgeUsed: true, knowledgeSourceCount: 2 });
    expect(message.turn.usage).toBeUndefined();
    expect(row).toMatchObject({ model: 'local-synthetic', ragRequested: true, ragUsed: true });
  });

  test('each message keeps its own model; the alias resolves to the pinned model', async () => {
    await conversations.recordTurn({ ...scope(), traceId: randomUUID(), inputText: 'One', replyText: 'Reply one',
      model: 'cloud-synthetic', modelProvider: 'openai-codex', usage: { input_tokens: 40, output_tokens: 10 }, knowledgeStatus: 'agent-managed' });
    await conversations.recordTurn({ ...scope(), traceId: randomUUID(), inputText: 'Two', replyText: 'Reply two',
      model: 'agentx-primary', knowledgeStatus: 'agent-managed', knowledgeUsed: false });
    const row = await Conversation.findById(session.conversationId).lean();
    const [first, second] = row.messages.filter(message => message.role === 'assistant');
    expect(first.stats.meta).toEqual({ model: 'cloud-synthetic', provider: 'openai-codex' });
    expect(first.cost.totalCost).toBeNull();
    expect(second.stats.meta).toEqual({ model: 'pinned-synthetic', requestedModel: 'agentx-primary' });
    expect(second.stats.usage?.totalTokens).toBeUndefined();
    expect(second.turn.model).toBe('agentx-primary');
    expect(row).toMatchObject({ model: 'pinned-synthetic', ragRequested: true, ragUsed: false });
  });

  test('a settled turn receives the same evidence as one recorded in a single write', async () => {
    const traceId = randomUUID();
    await conversations.acceptTurn({ ...scope(), traceId, clientTurnId: traceId, inputText: 'Synthetic question' });
    let message = assistant(await Conversation.findById(session.conversationId).lean());
    expect(message.stats?.usage?.totalTokens).toBeUndefined();
    await conversations.settleTurn({ ...scope(), traceId, replyText: 'Synthetic reply', model: 'local-synthetic',
      usage: { prompt_eval_count: 9, eval_count: 3 }, knowledgeStatus: 'ready', knowledgeSourceCount: 1, knowledgeUsed: true });
    const row = await Conversation.findById(session.conversationId).lean();
    message = assistant(row);
    expect(message.content).toBe('Synthetic reply');
    expect(message.stats).toMatchObject({ usage: { promptTokens: 9, completionTokens: 3, totalTokens: 12 }, meta: { model: 'local-synthetic' } });
    expect(message.turn).toMatchObject({ outcome: 'completed', model: 'local-synthetic', knowledgeUsed: true });
    expect(row).toMatchObject({ model: 'local-synthetic', ragRequested: true, ragUsed: true });
  });

  test('chat analytics attribute each message to its own model inside one conversation', async () => {
    const { activeMessageStages, messageModelKey } = require('../../src/services/conversationActivityAnalytics');
    for (const [model, usage] of [['cloud-synthetic', { input_tokens: 10, output_tokens: 5 }], ['local-synthetic', { prompt_eval_count: 7, eval_count: 3 }]]) {
      await conversations.recordTurn({ ...scope(), traceId: randomUUID(), inputText: 'Synthetic', replyText: 'Reply', model, usage });
    }
    const rows = await Conversation.aggregate([
      ...activeMessageStages(new Date(Date.now() - 60000), new Date(Date.now() + 60000)),
      { $match: { 'messages.role': 'assistant' } },
      { $group: { _id: messageModelKey(), tokens: { $sum: { $ifNull: ['$messages.stats.usage.totalTokens', 0] } } } },
      { $sort: { _id: 1 } }
    ]);
    expect(rows).toEqual([{ _id: 'cloud-synthetic', tokens: 15 }, { _id: 'local-synthetic', tokens: 10 }]);
  });

  test('a later update naming only the model keeps the recorded tokens', async () => {
    const traceId = randomUUID();
    await conversations.recordTurn({ ...scope(), traceId, inputText: 'Synthetic', replyText: 'Reply',
      model: 'local-synthetic', usage: { prompt_eval_count: 20, eval_count: 4 } });
    await conversations.updateTurn({ ...scope(), traceId }, { $set: { model: 'recovered-synthetic', outcome: 'completed' } });
    const message = assistant(await Conversation.findById(session.conversationId).lean());
    expect(message.stats).toMatchObject({ usage: { totalTokens: 24 }, meta: { model: 'recovered-synthetic' } });
    expect(message.turn.model).toBe('recovered-synthetic');
  });

  test('a turn without retrieval leaves the RAG flags off', async () => {
    await conversations.recordTurn({ ...scope(), traceId: randomUUID(), inputText: 'Synthetic', replyText: 'Reply',
      knowledgeStatus: 'active', knowledgeSourceCount: 0 });
    const row = await Conversation.findById(session.conversationId).lean();
    expect(row).toMatchObject({ ragRequested: false, ragUsed: false });
    expect(assistant(row).stats?.usage?.totalTokens).toBeUndefined();
  });
});
