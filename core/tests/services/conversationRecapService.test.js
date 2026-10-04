'use strict';
const { randomUUID } = require('node:crypto');
const express = require('express');
const request = require('supertest');
const Conversation = require('../../models/Conversation');
const { forSurface } = require('../../src/services/surfaceConversationService');
const { conversationLifecycle } = require('../../src/services/conversationLifecycleService');
const { createConversationRecapService, recapContext, localRecapGenerator } = require('../../src/services/conversationRecapService');
const { registerRecapRoutes } = require('../../src/services/conversations/recapRoutes');

describe('Core user-confirmed conversation continuity', () => {
  const core = createConversationRecapService();
  const scope = { userId: 'surface:psyx:synthetic-owner', promptName: 'psyx' };
  const points = core.forOwner(scope);
  const content = { summary: 'Synthetic recap', takeaway: 'Synthetic takeaway', nextStep: '' };
  let row, id;
  beforeAll(async () => { await Conversation.createCollection(); await Conversation.createIndexes(); });
  beforeEach(async () => {
    await Conversation.deleteMany({});
    row = await Conversation.create({ ...scope, surface: 'psyx', messages: [
      { role: 'user', content: 'Synthetic request' }, { role: 'assistant', content: 'Synthetic response' }
    ] });
    id = String(row._id);
  });
  const save = async (service = points, key = id, value = content) => {
    const snapshot = await service.read(key);
    return service.save(key, { ...value, revision: snapshot.revision, sourceHash: snapshot.source.hash });
  };
  const append = () => Conversation.findOneAndUpdate({ _id: row._id }, { $push: { messages: {
    role: 'user', content: 'Synthetic later turn'
  } } }, { new: true });

  test('stores the confirmed point in the canonical document and normal export view', async () => {
    const saved = await save();
    expect(saved.recap).toMatchObject({ ...content, revision: 1, stale: false, sourceMessageCount: 2 });
    const canonical = await conversationLifecycle.getConversation({ ...scope, conversationId: id });
    expect(canonical.sessionRecap.summary).toBe(content.summary);
    expect(canonical.messages).toHaveLength(2);
    expect((await points.latest()).conversationId).toBe(id);
    expect((await conversationLifecycle.listConversations(scope)).items[0].sessionRecap.summary).toBe(content.summary);
  });
  test('isolates owner, prompt and native conversation spaces', async () => {
    await save();
    for (const other of [core.forOwner({ ...scope, userId: 'other-owner' }), core.forOwner({ ...scope, promptName: 'other-persona' }),
      core.forSession({ surface: 'household', packId: 'personal_operator', scopeId: 'personal' })]) {
      expect(await other.latest()).toBeNull();
      await expect(other.read(id)).rejects.toMatchObject({ statusCode: 404 });
    }
  });
  test('refuses a second editor rather than losing the first saved point', async () => {
    const snapshot = await points.read(id);
    const input = { ...content, revision: 0, sourceHash: snapshot.source.hash };
    const results = await Promise.allSettled([points.save(id, input), points.save(id, { ...input, summary: 'Other editor' })]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected').reason).toMatchObject({ statusCode: 409 });
    expect((await points.read(id)).revision).toBe(1);
  });
  test('a new turn makes an open editor stale and labels the previous saved point', async () => {
    const saved = await save(); await append();
    expect((await points.read(id)).recap.stale).toBe(true);
    await expect(points.save(id, { ...content, revision: saved.revision, sourceHash: saved.source.hash }))
      .rejects.toMatchObject({ code: 'CONVERSATION_RECAP_CONFLICT' });
    expect((await points.read(id)).revision).toBe(1);
  });
  test('same-length text corrections also invalidate the original source', async () => {
    await save();
    await Conversation.findOneAndUpdate({ _id: row._id }, { $set: { 'messages.0.content': 'Synthetic revised' } });
    expect((await points.read(id)).recap.stale).toBe(true);
  });
  test('a turn landing after source validation is protected by the atomic root version', async () => {
    const original = Conversation.findOneAndUpdate.bind(Conversation);
    const spy = jest.spyOn(Conversation, 'findOneAndUpdate').mockImplementation((filter, update, options) => {
      if (!update.$set?.sessionRecap) return original(filter, update, options);
      return { lean: async () => { await append(); return original(filter, update, options).lean(); } };
    });
    try { await expect(save()).rejects.toMatchObject({ code: 'CONVERSATION_RECAP_CONFLICT' }); }
    finally { spy.mockRestore(); }
    expect((await points.read(id)).recap).toBeNull();
  });
  test('drafts do not write, expose actual coverage and treat transcript as data', async () => {
    const generate = jest.fn(async () => JSON.stringify(content));
    const draft = await points.draft(id, generate);
    expect(draft).toMatchObject({ revision: 0, recap: null, draft: content, coverage: { includedMessages: 2, availableMessages: 2 } });
    expect(generate.mock.calls[0][0][0].content).toContain('untrusted reference data');
    expect((await points.read(id)).recap).toBeNull();
  });
  test('a turn arriving while a draft is generated refuses the stale result', async () => {
    await expect(points.draft(id, async () => { await append(); return JSON.stringify(content); }))
      .rejects.toMatchObject({ statusCode: 409 });
    expect((await points.read(id)).recap).toBeNull();
  });
  test('a confirmed edit arriving while a draft is generated also refuses that result', async () => {
    await expect(points.draft(id, async () => { await save(); return JSON.stringify(content); }))
      .rejects.toMatchObject({ statusCode: 409 });
    expect((await points.read(id)).recap.summary).toBe(content.summary);
  });
  test('oversized messages are never silently cut for inference', async () => {
    await Conversation.findOneAndUpdate({ _id: row._id }, { $push: { messages: { role: 'user', content: 'x'.repeat(12001) } } });
    const generate = jest.fn();
    await expect(points.draft(id, generate)).rejects.toMatchObject({ statusCode: 422 });
    expect(generate).not.toHaveBeenCalled();
  });
  test('reports partial coverage after choosing whole messages', async () => {
    await Conversation.findOneAndUpdate({ _id: row._id }, { $push: { messages: { $each: Array.from({ length: 14 }, (_, i) =>
      ({ role: i % 2 ? 'assistant' : 'user', content: `Synthetic ${i}` })) } } });
    const draft = await points.draft(id, async () => JSON.stringify(content));
    expect(draft.coverage).toEqual({ includedMessages: 12, availableMessages: 16 });
  });
  test('invalid or oversized drafts and user input do not replace the saved recap', async () => {
    await save();
    for (const output of ['not JSON', 'null', JSON.stringify({ summary: 'x'.repeat(2001) })]) {
      await expect(points.draft(id, async () => output)).rejects.toBeDefined();
    }
    await expect(save(points, id, { ...content, takeaway: 'x'.repeat(1001) })).rejects.toMatchObject({ statusCode: 400 });
    expect((await points.read(id)).revision).toBe(1);
  });
  test('archive and erasure remove the point from continuation; late writes cannot recreate it', async () => {
    const saved = await save();
    await conversationLifecycle.archiveConversation({ ...scope, conversationId: id });
    expect(await points.latest()).toBeNull();
    await expect(points.read(id)).rejects.toMatchObject({ statusCode: 404 });
    await conversationLifecycle.permanentlyDeleteConversation({ ...scope, conversationId: id });
    await expect(points.save(id, { ...content, revision: saved.revision, sourceHash: saved.source.hash }))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(await Conversation.countDocuments(scope)).toBe(0);
  });
  test('Nestor uses the same capability and its existing erasure tombstone covers recaps', async () => {
    const native = forSurface('household');
    const session = await native.createSession({ sessionId: randomUUID(), packId: 'personal_operator', scopeId: 'personal', modeId: 'personal' });
    await native.recordTurn({ ...session, traceId: randomUUID(), inputText: 'Synthetic native question', replyText: 'Synthetic native answer' });
    const service = core.forSession({ surface: 'household', packId: 'personal_operator', scopeId: 'personal' });
    const saved = await save(service, session.sessionId);
    expect(saved.recap.sourceMessageCount).toBe(2);
    await native.deleteSession({ sessionId: session.sessionId, packId: session.packId, scopeId: session.scopeId });
    expect(await service.latest()).toBeNull();
    expect((await Conversation.findById(session.conversationId).lean()).sessionRecap).toBeUndefined();
  });
  test('routes preserve scope, refuse busy mutations and prohibit caching', async () => {
    const app = express(); app.use(express.json());
    registerRecapRoutes(app, { base: '/sessions', serviceFor: () => points, busy: req => req.headers['x-busy'] === 'true' });
    const read = await request(app).get(`/sessions/${id}/recap`);
    expect(read.status).toBe(200); expect(read.headers['cache-control']).toContain('no-store');
    expect((await request(app).put(`/sessions/${id}/recap`).set('X-Busy', 'true').send(content)).status).toBe(409);
    const saved = await request(app).put(`/sessions/${id}/recap`).send({ ...content, revision: 0, sourceHash: read.body.data.source.hash,
      userId: 'other-owner', scopeId: 'family' });
    expect(saved.status).toBe(200);
    expect((await request(app).get('/sessions/recap/latest')).body.data.conversationId).toBe(id);
    expect(await core.forOwner({ ...scope, userId: 'other-owner' }).latest()).toBeNull();
  });
  test('the generator uses admitted Core inference, with the server-selected consumer contract', async () => {
    const execute = jest.fn(async () => ({ ok: true, body: { message: { content: JSON.stringify(content) } } }));
    await points.draft(id, localRecapGenerator({ execute }, 'psyx'));
    expect(execute.mock.calls[0][0]).toMatchObject({ mode: 'chat', stream: false, taskType: 'analysis', think: false, format: 'json' });
    expect(execute.mock.calls[0][1]).toEqual({ consumerContract: 'psyx' });
    expect(recapContext({ ...content, stale: true })).toContain('des échanges ont suivi');
  });
});
