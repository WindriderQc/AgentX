'use strict';

const { randomUUID } = require('node:crypto');
const Conversation = require('../../models/Conversation');
const { forSurface } = require('../../src/services/surfaceConversationService');

describe('surface conversations in the canonical Core store', () => {
  const conversations = forSurface('household');
  let session;
  beforeAll(async () => { await Conversation.createCollection(); await Conversation.createIndexes(); });
  beforeEach(async () => {
    await Conversation.deleteMany({});
    session = await conversations.createSession({ sessionId: randomUUID(), packId: 'personal_operator',
      modeId: 'personal', scopeId: 'personal', label: 'Synthetic conversation', backend: 'agentx' });
  });
  const turn = (session, overrides = {}) => ({ traceId: randomUUID(), sessionId: session.sessionId,
    packId: session.packId, scopeId: session.scopeId, modeId: session.modeId,
    inputText: 'Synthetic question', replyText: 'Synthetic reply', ...overrides });

  test('stores transcript, session and evidence together without a second text copy', async () => {
    const recorded = await conversations.recordTurn(turn(session, { toolEvidence: { status: 'verified', receipts: [{ tool: 'test' }] } }));
    const row = await Conversation.findById(session.conversationId).lean();
    expect(row.messages.map(message => [message.role, message.content])).toEqual([
      ['user', 'Synthetic question'], ['assistant', 'Synthetic reply']
    ]);
    expect(row.messages[1].turn).toMatchObject({ traceId: recorded.traceId, toolEvidence: { status: 'verified' } });
    expect(row.messages[1].turn.inputText).toBeUndefined();
    expect(row.messages[1].turn.replyText).toBeUndefined();
    expect(row.surfaceSession.turnCount).toBe(1);
    expect(await conversations.getTurn({ traceId: recorded.traceId })).toMatchObject({
      conversationId: session.conversationId, inputText: 'Synthetic question', replyText: 'Synthetic reply'
    });
    expect(await forSurface('different-surface').getTurn({ traceId: recorded.traceId })).toBeNull();
    expect(await conversations.getTurn({ traceId: recorded.traceId, scopeId: 'family' })).toBeNull();
    await expect(conversations.recordTurn(turn(session, { scopeId: 'family' }))).rejects.toMatchObject({ statusCode: 404 });
  });

  test('the server-selected image workshop stores 32000 UTF-16 input units verbatim while retaining other turn limits', async () => {
    const atelier = forSurface('image-workshop');
    const atelierSession = await atelier.createSession({ sessionId: randomUUID(), packId: 'atelier',
      modeId: 'imagex', scopeId: 'workspace', label: 'Synthetic image conversation' });
    const tail = 'TERMINAL_SENTINEL \n', prefix = ' \n';
    const fill = 32000 - prefix.length - tail.length;
    const inputText = prefix + '💡'.repeat(Math.floor(fill / 2)) + 'x'.repeat(fill % 2) + tail;
    expect(inputText).toHaveLength(32000);
    const recorded = await atelier.recordTurn(turn(atelierSession, { inputText, replyText: 'r'.repeat(16000) }));
    expect((await atelier.getTurn({ traceId: recorded.traceId })).inputText).toBe(inputText);
    expect((await Conversation.findById(atelierSession.conversationId).lean()).messages[0].content).toBe(inputText);
    await expect(atelier.recordTurn(turn(atelierSession, { inputText: inputText + 'x' }))).rejects.toMatchObject({ statusCode: 400 });
    await expect(atelier.recordTurn(turn(atelierSession, { replyText: 'r'.repeat(16001) }))).rejects.toMatchObject({ statusCode: 400 });
    await expect(conversations.recordTurn(turn(session, { inputText: 'x'.repeat(16001), surface: 'image-workshop' })))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(forSurface('constructor').recordTurn(turn(session, { inputText: 'x'.repeat(16001) })))
      .rejects.toMatchObject({ statusCode: 400 });
    expect((await atelier.getSession({ sessionId: atelierSession.sessionId })).turnCount).toBe(1);
    expect((await conversations.getSession({ sessionId: session.sessionId })).turnCount).toBe(0);
  });

  test('concurrent replay appends exactly one turn and increments the count once', async () => {
    const event = turn(session, { source: 'voix-native' });
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => conversations.recordTurn(event)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected').every(result => result.reason.code === 11000)).toBe(true);
    expect((await conversations.getSession({ sessionId: session.sessionId })).turnCount).toBe(1);
    expect(await conversations.countTurns({ source: 'voix-native' })).toBe(1);
    const other = await conversations.createSession({ sessionId: randomUUID(), packId: 'personal_operator', modeId: 'personal', scopeId: 'personal' });
    await expect(conversations.recordTurn({ ...event, sessionId: other.sessionId })).rejects.toMatchObject({ code: 11000 });
    expect((await conversations.getSession({ sessionId: other.sessionId })).turnCount).toBe(0);
  });

  test('different concurrent turns are not lost and stay paired in chronological history', async () => {
    await Promise.all(Array.from({ length: 8 }, (_, index) => conversations.recordTurn(turn(session, {
      inputText: `Question ${index}`, replyText: `Reply ${index}`, sequence: index
    }))));
    const rows = await conversations.listTurns({ sessionId: session.sessionId }, { sort: { sequence: 1 }, limit: 20 });
    expect(rows.map(row => [row.inputText, row.replyText])).toEqual(Array.from({ length: 8 }, (_, i) => [`Question ${i}`, `Reply ${i}`]));
    expect((await conversations.getSession({ sessionId: session.sessionId })).turnCount).toBe(8);
  });

  test('independent conversations can both contain user and assistant messages', async () => {
    const other = await conversations.createSession({ sessionId: randomUUID(), packId: session.packId,
      scopeId: session.scopeId, modeId: session.modeId });
    const first = await conversations.recordTurn(turn(session));
    const second = await conversations.recordTurn(turn(other));
    expect(first.traceId).not.toBe(second.traceId);
    expect(await conversations.countTurns()).toBe(2);
    expect((await conversations.getTurn({ traceId: first.traceId })).conversationId).toBe(session.conversationId);
    expect((await conversations.getTurn({ traceId: second.traceId })).conversationId).toBe(other.conversationId);
  });

  test('interruption and scene receipts update the original turn atomically and retain native empty blocks', async () => {
    const recorded = await conversations.recordTurn(turn(session, { sceneProposal: { schemaVersion: 1, steering: {} } }));
    const updated = await conversations.updateTurn({ _id: recorded._id, sceneReceipt: null }, { $set: {
      interrupted: true, interruptionState: 'confirmed', sceneReceipt: { status: 'rejected', message: 'Synthetic rejected' },
      sceneProposedReplyText: recorded.replyText, replyText: 'Synthetic rejected'
    } });
    expect(updated).toMatchObject({ inputText: 'Synthetic question', replyText: 'Synthetic rejected',
      interrupted: true, sceneProposal: { steering: {} }, sceneProposedReplyText: 'Synthetic reply' });
    expect(await conversations.updateTurn({ _id: recorded._id, sceneReceipt: null }, { $set: { replyText: 'Overwrite' } })).toBeNull();
    expect(await conversations.countTurns({ sessionId: session.sessionId })).toBe(1);
    const row = await Conversation.findById(session.conversationId).lean();
    expect(row.messages[1].content).toBe('Synthetic rejected');
  });

  test('a voice turn keeps its browser timeline, attached by the client turn that produced it', async () => {
    const recorded = await conversations.recordTurn(turn(session, { channel: 'voice', clientTurnId: 'synthetic-client-turn-1' }));
    expect(recorded.voiceTimings).toBeUndefined();
    const voiceTimings = { sttDone: 640, requestSent: 655, firstDelta: 4200, firstAudio: 5100, interrupted: false };
    const updated = await conversations.updateTurn({ sessionId: session.sessionId, clientTurnId: 'synthetic-client-turn-1', channel: 'voice' }, { $set: { voiceTimings } });
    expect(updated).toMatchObject({ _id: recorded._id, replyText: 'Synthetic reply', voiceTimings });
    expect(await conversations.updateTurn({ sessionId: session.sessionId, clientTurnId: 'another-client-turn', channel: 'voice' }, { $set: { voiceTimings } })).toBeNull();
    expect((await conversations.getTurn({ traceId: recorded.traceId })).voiceTimings).toEqual(voiceTimings);
  });

  test('native memory workers claim only one exact pending turn and recover stale claims', async () => {
    const recorded = await conversations.recordTurn(turn(session, { source: 'voix-native', memoryState: 'captured' }));
    const query = { traceId: recorded.traceId, source: 'voix-native', memoryState: 'captured',
      $or: [{ memoryNextAttemptAt: null }, { memoryNextAttemptAt: { $lte: new Date() } }] };
    const receipts = await Promise.all(Array.from({ length: 4 }, () => conversations.updateTurn(query,
      { $set: { memoryState: 'processing', memoryClaimedAt: new Date(0) } })));
    expect(receipts.filter(Boolean)).toHaveLength(1);
    await conversations.updateTurns({ source: 'voix-native', memoryState: 'processing', memoryClaimedAt: { $lt: new Date() } },
      { $set: { memoryState: 'captured', memoryError: 'recovered' } });
    expect(await conversations.getTurn({ traceId: recorded.traceId })).toMatchObject({ memoryState: 'captured', memoryError: 'recovered' });
    expect(await conversations.countTurns({ memoryState: 'processing' })).toBe(0);
  });

  test('retains a cancelled application opening without inventing user speech', async () => {
    await conversations.recordTurn(turn(session, { inputText: '', replyText: '', origin: 'application_opening',
      outcome: 'cancelled', applicationEvent: { type: 'opening' } }), { sessionPatch: { llmx: { opening: { status: 'cancelled' } } } });
    const row = await Conversation.findById(session.conversationId).lean();
    expect(row.messages).toHaveLength(1);
    expect(row.messages[0]).toMatchObject({ role: 'assistant', content: '', turn: { outcome: 'cancelled' } });
    expect(row.surfaceSession.llmx.opening.status).toBe('cancelled');
  });

  test('cannot reopen or move a conversation through a retried native session event', async () => {
    await conversations.updateSession({ sessionId: session.sessionId }, { $set: { status: 'closed' } });
    expect(await conversations.ensureSession(session)).toMatchObject({ status: 'closed' });
    await expect(conversations.ensureSession({ ...session, scopeId: 'family' })).rejects.toMatchObject({ statusCode: 409 });
    await expect(conversations.recordTurn(turn(session))).rejects.toMatchObject({ statusCode: 404 });
    await expect(conversations.updateSession({ sessionId: session.sessionId }, { $set: { scopeId: 'family' } })).rejects.toMatchObject({ statusCode: 400 });
  });
});
