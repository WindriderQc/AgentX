'use strict';

// Native Nestor consumers of the Household surface: the Family voice
// consumer and the LLMX profiles. They reuse the persona session and turn
// handlers that Household's register() builds for its browser routes.

const crypto = require('crypto');
const { conversationBackend } = require('./conversation-executor');
const llmx = require('./llmx-conversation');

function registerNativeConsumers(app, {
  express, standardJsonParser, conversations, conversationEnv, activePersonaTurns,
  createPersonaSession, createNativeFamilySession, handlePersonaTurn, registerBrowserSessionControls, openingPayload,
  envelope, fail, cleanText, requireVoixMemoryConsumer,
  VOIX_FAMILY_PACK_ID, VOIX_FAMILY_MODE_ID, VOIX_FAMILY_SCOPE_ID
}) {
  const nativeFamilyConsumer = express.Router();
  nativeFamilyConsumer.use(standardJsonParser);
  nativeFamilyConsumer.get('/workshop-contract', (_req, res) => envelope(res, { schemaVersion: 1, context: 'kidx-workshop', actions: 'client-receipts-only', toolsEnabled: conversationBackend(null, conversationEnv) === 'openclaw', toolsScope: 'family-memory-only' }));
  nativeFamilyConsumer.post('/sessions', requireVoixMemoryConsumer, createNativeFamilySession);
  nativeFamilyConsumer.post('/sessions/:sessionId/turns/text', requireVoixMemoryConsumer, (req, res) => (
    handlePersonaTurn(req, res, 'child', {
      packId: VOIX_FAMILY_PACK_ID,
      modeId: VOIX_FAMILY_MODE_ID,
      scopeId: VOIX_FAMILY_SCOPE_ID
    })
  ));
  app.use('/api/consumers/nestor/v1/household-family', nativeFamilyConsumer);

  const llmxConsumer = express.Router();
  llmxConsumer.use(standardJsonParser);
  function registerLlmXProfile(prefix, profile) {
    const scope = llmx.PROFILES[profile], access = profile === 'family' ? 'child' : 'private';
    const requiredSession = profile === 'family' ? { ...scope, browser: false } : null;
    llmxConsumer.get(`${prefix}/config`, (_req, res) => envelope(res, { ...llmx.config, profile }));
    llmxConsumer.post(`${prefix}/sessions`, (req, res) => {
      req.body = { ...req.body, ...scope, ...(profile === 'family' ? { agentId: 'family', personaId: req.body?.personaId || 'nestor' } : {}) };
      return createPersonaSession(access, 'llmx')(req, res);
    });
    registerBrowserSessionControls(prefix, scope.packId, scope.scopeId, llmxConsumer, 'llmx');
    llmxConsumer.post(`${prefix}/sessions/:sessionId/turns/text`, async (req, res) => {
      try {
        if (!llmx.validTurnId(req.body?.turnId)) return fail(res, 400, 'A valid turnId is required', 'LLMX_TURN_ID_INVALID');
        if (!cleanText(req.body?.text, 4000)) return fail(res, 400, 'text is required', 'VOICE_PERSONA_TEXT_REQUIRED');
        req.llmx = { profile, sceneContext: llmx.sceneContext(req.body?.sceneContext) };
        const previous = activePersonaTurns.get(req.params.sessionId);
        if (previous) {
          const snapshot = previous.snapshot || await previous.ready;
          if (!snapshot || !previous.llmx || previous.profile !== profile) return fail(res, 404, 'LLMx conversation not found', 'LLMX_SESSION_NOT_FOUND');
        }
        if (previous?.opening && !previous.dispatched) {
          previous.humanFirst = true;
          previous.interrupted = true;
          previous.abort.abort();
          await previous.finished;
        }
        return handlePersonaTurn(req, res, access, requiredSession);
      } catch (error) { return fail(res, error.statusCode || 500, error.message, error.code || 'LLMX_TURN_FAILED'); }
    });
    llmxConsumer.post(`${prefix}/sessions/:sessionId/opening`, async (req, res) => {
      try {
        if (!llmx.validTurnId(req.body?.requestId) || req.body?.openingVersion !== llmx.OPENING_VERSION) {
          return fail(res, 400, 'A valid requestId and openingVersion 1 are required', 'LLMX_OPENING_INVALID');
        }
        req.llmx = { profile, opening: true, sceneContext: llmx.sceneContext(req.body?.sceneContext) };
        req.body = { ...req.body, turnId: req.body.requestId, channel: req.body.channel === 'text' ? 'text' : 'voice' };
        const active = activePersonaTurns.get(req.params.sessionId);
        if (active) {
          const snapshot = active.snapshot || await active.ready;
          if (!snapshot || !active.llmx || active.profile !== profile) return fail(res, 404, 'LLMx conversation not found', 'LLMX_SESSION_NOT_FOUND');
          const session = await conversations.getSession({ sessionId: req.params.sessionId, ...llmx.sessionScope(profile), status: 'active' });
          if (!session) return fail(res, 404, 'LLMx conversation not found', 'LLMX_SESSION_NOT_FOUND');
          const pending = active.opening && activePersonaTurns.get(session.sessionId) === active;
          const opening = llmx.publicOpening(session.llmx.opening, pending)
            || { version: 1, status: pending ? 'pending' : 'skipped', turnId: active.clientTurnId || null, reason: pending ? '' : 'human_first' };
          return envelope(res, { ...openingPayload(session, pending), opening }, opening.status === 'pending' ? 202 : 200);
        }
        // No async work precedes handlePersonaTurn's existing in-process admission.
        return handlePersonaTurn(req, res, access, requiredSession);
      } catch (error) { return fail(res, error.statusCode || 500, error.message, error.code || 'LLMX_OPENING_FAILED'); }
    });
    llmxConsumer.post(`${prefix}/sessions/:sessionId/scene-receipts`, async (req, res) => {
      try {
        const receipt = llmx.sceneReceipt(req.body);
        const session = await conversations.getSession({ sessionId: req.params.sessionId, ...llmx.sessionScope(profile), status: 'active' });
        if (!session) return fail(res, 404, 'LLMx conversation not found', 'LLMX_SESSION_NOT_FOUND');
        const query = { sessionId: session.sessionId, ...scope, source: 'graphysx-llmx',
          clientTurnId: receipt.turnId, origin: 'human', outcome: 'completed', 'sceneProposal.schemaVersion': 1 };
        // Choose the same original audit even if an older installation admitted
        // duplicate turn ids. Never search for a different row without a receipt.
        const [previous] = await conversations.listTurns(query, { sort: { createdAt: 1, _id: 1 }, limit: 1 });
        if (!previous) return fail(res, 409, 'No completed scene proposal matches this turn', 'LLMX_SCENE_RECEIPT_UNAVAILABLE');
        const actualReply = previous.sceneProposal.math || receipt.status === 'rejected';
        if (actualReply && !receipt.message) return fail(res, 400, 'Math and rejected scene receipts require the displayed outcome message', 'LLMX_SCENE_RECEIPT_MESSAGE_REQUIRED');
        let stored = previous.sceneReceipt;
        if (!stored) {
          const exact = { ...query, _id: previous._id };
          const written = await conversations.updateTurn({ ...exact, sceneReceipt: null },
            { $set: { sceneReceipt: { ...receipt, receivedAt: new Date().toISOString() }, ...(actualReply ? {
              sceneProposedReplyText: previous.replyText, replyText: receipt.message,
              replySha256: crypto.createHash('sha256').update(receipt.message).digest('hex')
            } : {}) } });
          if (written) return envelope(res, { turnId: receipt.turnId, receipt: written.sceneReceipt, duplicate: false });
          stored = (await conversations.getTurn(exact))?.sceneReceipt;
        }
        if (!stored || !['turnId', 'status', 'message'].every(key => stored[key] === receipt[key])
            || JSON.stringify(stored.entityIds) !== JSON.stringify(receipt.entityIds)) return fail(res, 409, 'This scene proposal already has a different receipt', 'LLMX_SCENE_RECEIPT_CONFLICT');
        return envelope(res, { turnId: receipt.turnId, receipt: stored, duplicate: true });
      } catch (error) {
        return fail(res, error.statusCode || 500, error.message || 'Unable to record the scene outcome', error.code || 'LLMX_SCENE_RECEIPT_FAILED');
      }
    });
  }
  registerLlmXProfile('', 'personal');
  registerLlmXProfile('/family', 'family');
  app.use('/api/consumers/nestor/v1/llmx', llmxConsumer);
}

module.exports = { registerNativeConsumers };
