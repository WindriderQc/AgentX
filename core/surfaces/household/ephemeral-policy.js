'use strict';

const { randomUUID } = require('node:crypto');
const { ephemeralId, failure } = require('../../src/services/conversations/ephemeralSessions');
const { publicSession, loadSessionAuditRows } = require('./persona-records');
const { packById } = require('./packs');

function privacyForNew(body = {}, open = false) {
  for (const key of ['ephemeral', 'ephemeralExplicit']) {
    if (body[key] !== undefined && typeof body[key] !== 'boolean') throw failure(`${key} must be a boolean.`, 400);
  }
  const explicit = body.ephemeralExplicit ?? typeof body.ephemeral === 'boolean';
  return { ephemeral: explicit ? body.ephemeral === true : body.ephemeral === true || open,
    ephemeralExplicit: explicit };
}

// Privacy changes create a new server context. Submitted turns retain their
// original identity/policy, including interruption and delayed callbacks. Only
// the browser keeps the previous segment on screen.
function registerPrivacyRoutes(router, { conversations, activePersonaTurns, envelope, fail }) {
  router.post('/private/sessions/:sessionId/privacy', async (req, res) => {
    const id = req.params.sessionId;
    res.set('Cache-Control', 'private, no-store');
    if (typeof req.body?.ephemeral !== 'boolean') return fail(res, 400, 'ephemeral must be a boolean.', 'CONVERSATION_EPHEMERAL_INVALID');
    if (activePersonaTurns.has(id)) return fail(res, 409, 'Wait for this conversation to finish its reply.', 'VOICE_TURN_IN_PROGRESS');
    const lock = { privacySwitch: true }; activePersonaTurns.set(id, lock);
    try {
      const session = await conversations.getSession({ sessionId: id, packId: 'personal_operator', scopeId: 'personal', status: 'active' });
      if (!session || session.llmx) return fail(res, 404, 'Conversation not found in this space.', 'VOICE_PERSONA_SESSION_NOT_FOUND');
      const choice = privacyForNew(req.body);
      if (session.ephemeral && !choice.ephemeral && !choice.ephemeralExplicit) throw failure('Retaining future exchanges requires an explicit OFF choice.', 400);
      if (req.body.backend !== undefined && (req.body.backend !== 'agentx' || !choice.ephemeral)) throw failure('Only an explicit ephemeral move to AgentX / Ollama is supported.', 400);
      if (Boolean(session.ephemeral) === choice.ephemeral && (!req.body.backend || req.body.backend === session.backend)) {
        const updated = await conversations.updateSession({ sessionId: id }, { $set: { ephemeralExplicit: choice.ephemeralExplicit } });
        return envelope(res, { session: publicSession(updated), contextReset: false });
      }
      const fields = ['packId', 'modeId', 'scopeId', 'label', 'persona', 'inference', 'voice', 'visual', 'agentId', 'backend'];
      const input = Object.fromEntries(fields.filter(key => session[key] !== undefined).map(key => [key, session[key]]));
      if (req.body.backend) input.backend = req.body.backend;
      // Resolve and read the durable source before allocating the transient
      // successor. No transient content is ever copied in the other direction.
      const earlier = req.body.ephemeral ? await loadSessionAuditRows(conversations, session, packById(session.packId)) : [];
      const next = await conversations.createSession({ ...input, sessionId: randomUUID(), ...choice });
      if (next.ephemeral) for (const row of earlier.slice().reverse()) {
        await conversations.recordTurn({ sessionId: next.sessionId, packId: next.packId, scopeId: next.scopeId,
          modeId: next.modeId, inputText: row.inputText || '', replyText: row.replyText || '',
          interrupted: row.interrupted === true, traceId: randomUUID(), clientTurnId: '', attachments: [] });
      }
      // Keep the old transient identity alive until its idle timeout: a late
      // metrics/interrupt callback must never be redirected into retained data.
      return envelope(res, { session: publicSession(next), contextReset: !next.ephemeral,
        previousRetained: !ephemeralId(id) });
    } catch (error) {
      return fail(res, error.statusCode || 500, error.statusCode ? error.message : 'Privacy change unavailable.', error.code || 'CONVERSATION_EPHEMERAL_INVALID');
    } finally { if (activePersonaTurns.get(id) === lock) activePersonaTurns.delete(id); }
  });
}

module.exports = { privacyForNew, registerPrivacyRoutes };
