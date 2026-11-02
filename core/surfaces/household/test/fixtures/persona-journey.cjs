'use strict';
// In-memory canonical turns and fake inference only. Shared by unit and loopback browser fixtures.
const assert = require('node:assert/strict');
const {createPersonaTurnHandler}=require('../../persona-turn');
const {createConversationExecutor}=require('../../conversation-executor');
const packs=require('../../packs'),prompt=require('../../persona-prompt'),records=require('../../persona-records');
const RUN_ID='resp_33333333-3333-4333-8333-333333333333';
function harness({ packId, backend, response = 'Réponse synthétique.', conversationImages, settle, sounds, screenPages, validClientTurnId = () => false, conversationEnv = {} }) {
  const pack = packs.packById(packId);
  const session = { sessionId: 'synthetic-session', status: 'active', packId, modeId: pack.defaultMode, scopeId: pack.defaultScopeId,
    backend, agentId: pack.childSafe ? 'family' : 'main', turnCount: 0,
    persona: { id: 'nestor', version: 1, name: 'Nestor', identity: 'Synthetic personality overlay.', voice: {} }, voice: { language: 'auto' } };
  const state = { notes: [], advice: '', profiles: [], sound: null, session };
  const turns = [], sent = [];
  const conversations = {
    getSession: async () => ({ ...session }),
    updateSession: async (_query, update) => {
      Object.assign(session, update.$set || {});
      for (const key of Object.keys(update.$unset || {})) delete session[key];
      return { ...session };
    },
    listTurns: async (_query, { limit = 50 } = {}) => turns.slice(0, limit),
    getTurn: async () => null,
    recordTurn: async turn => {
      const row = { ...turn, _id: `turn-${turns.length}`, createdAt: new Date() };
      turns.unshift(row); session.turnCount += 1;
      return row;
    }
  };
  const executeConversation = createConversationExecutor({
    inference: { execute: async body => {
      sent.push({ prefix: body.messages[0].content, messages: body.messages, request: body.messages.at(-1).content, taskType: body.taskType, tools: body.tools });
      return { ok: true, body: { response: typeof response === 'function' ? response(body) : response }, metadata: { model: 'synthetic' } };
    } },
    agentClient: async request => {
      sent.push({ prefix: request.instructions, request: [request.turnContext, request.turnDirective].filter(Boolean).join('\n\n'), text: request.text });
      await request.onStarted(`agent:${request.session.agentId}:synthetic`, RUN_ID);
      return { text: response, sessionKey: `agent:${request.session.agentId}:synthetic`, runId: RUN_ID,
        metadata: { model: 'synthetic-native' }, tools: { status: 'observed', receipts: [], runId: RUN_ID } };
    }
  });
  const handle = createPersonaTurnHandler({
    screenPages, logger: null, runtimeServices: { attachments: { ids: () => [] } }, conversations, conversationEnv,
    executeConversation: async request => { const result = await executeConversation(request); settle?.(request); return result; }, conversationImages,
    requireNativeAgent: async () => {},
    familyTasks: { listProfileDetails: async () => ({ profiles: state.profiles }), listProfiles: async () => ({ profiles: state.profiles }),
      room: async () => ({ room: { available: [{ title: 'Synthetic routine' }] } }) },
    ownerMemory: {}, familyMemory: {},
    notesFor: () => ({ search: async () => ({ notes: state.notes }), record: async () => ({}) }),
    personalAttachments: () => ({ references: async () => [], prepare: async messages => messages.map(({ attachments, ...message }) => message) }),
    knowledgeState: { config: null, status: { status: 'disabled', corpusFingerprint: null } },
    openHold: {}, openingPayload: () => ({}),
    sounds: sounds || { select: () => state.sound, get: () => null }, visuals: { sources: () => ['web'], present: async block => block },
    brain: { cancel() {}, schedule() {}, contextFor: () => state.advice },
    activePersonaTurns: new Map(), validClientTurnId,
    envelope: (res, data) => { res.payload = data; }, fail: (res, status, message, code) => { res.failure = { status, message, code }; },
    cleanText: (value, max = 4000) => String(value || '').trim().slice(0, max),
    assessSafety: prompt.assessSafety, childBoundaryReply: prompt.childBoundaryReply, escalationReply: prompt.escalationReply,
    detectMemoryRequest: prompt.detectMemoryRequest,
    packById: packs.packById, packSummary: packs.packSummary, modeSummary: packs.modeSummary, publicSession: records.publicSession,
    systemPromptFor: prompt.systemPromptFor, spokenReplyLanguage: prompt.spokenReplyLanguage,
    sessionHistoryMessages: records.sessionHistoryMessages, loadSessionAuditRows: records.loadSessionAuditRows,
    MEMORY_RECALL_LIMIT: prompt.MEMORY_RECALL_LIMIT, PERSONAL_OPERATOR_SURFACE_CONTRACT: packs.PERSONAL_OPERATOR_SURFACE_CONTRACT,
    VOIX_FAMILY_PACK_ID: 'kidx_nestor'
  });
  const turn = async (text, channel, extra = {}) => {
    const res = { on() {}, removeListener() {}, writableEnded: false, headersSent: false };
    await handle({ params: { sessionId: session.sessionId }, body: { text, channel, ...extra } }, res, pack.childSafe ? 'child' : 'private');
    assert.equal(res.failure, undefined, JSON.stringify(res.failure));
    return res.payload;
  };
  return { state, sent, turn, pack, turns, handle, conversations, session };
}


module.exports={harness};
