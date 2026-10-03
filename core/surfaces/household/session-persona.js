'use strict';

const catalog = require('./persona-catalog');
const { agentForPersona } = require('./persona-selection');
const { publicSession } = require('./persona-records');

// Mounted on the existing persona router: both spaces require the existing
// adult gateway session. The family write is absent from the child allowlist.
function registerSessionPersonaRoutes(router, { conversations, personas, ensureCatalog, activePersonaTurns, envelope, fail }) {
  for (const [space, packId, scopeId] of [['private', 'personal_operator', 'personal'], ['family', 'kidx_nestor', 'family']]) {
    router.post(`/${space}/sessions/:sessionId/persona`, async (req, res) => {
      const sessionId = req.params.sessionId;
      if (activePersonaTurns.has(sessionId)) return fail(res, 409, 'Wait for this conversation to finish its reply.', 'VOICE_TURN_IN_PROGRESS');
      const { personaId, personaVersion } = req.body || {};
      if (personaId !== null && (typeof personaId !== 'string' || !personaId.trim())) {
        return fail(res, 400, 'A personaId or null is required.', 'VOICE_PERSONA_INVALID');
      }
      if (personaId === null && personaVersion != null) return fail(res, 400, 'No version applies when clearing the personality.', 'VOICE_PERSONA_INVALID');
      // Acquire synchronously before reading the session or resolving a version.
      // Turn admission uses this same map, closing the switch/turn race.
      const lock = { personaSwitch: true };
      activePersonaTurns.set(sessionId, lock);
      try {
        const query = { sessionId, packId, scopeId, status: 'active', ...(space === 'family' ? { modeId: 'family' } : {}) };
        const session = await conversations.getSession(query);
        if (!session) return fail(res, 404, 'Conversation not found in this space.', 'VOICE_PERSONA_SESSION_NOT_FOUND');
        let persona = null;
        if (personaId !== null) {
          if (!personas) return fail(res, 503, 'Shared persona catalog unavailable.', 'VOICE_PERSONA_CATALOG_UNAVAILABLE');
          await ensureCatalog();
          const row = await personas.resolve(personaId, personaVersion);
          if (!row.isActive) return fail(res, 400, 'This personality version is inactive.', 'VOICE_PERSONA_INACTIVE');
          persona = catalog.snapshot(row);
        }
        agentForPersona(persona, { agentId: session.agentId || 'main', family: space === 'family' });
        const updated = await conversations.updateSession(query, { $set: { persona } });
        if (!updated) return fail(res, 404, 'Conversation not found in this space.', 'VOICE_PERSONA_SESSION_NOT_FOUND');
        return envelope(res, { session: publicSession(updated) });
      } catch (error) {
        return fail(res, error.statusCode || 500, error.message || 'Unable to switch personality.', error.code || 'VOICE_PERSONA_SWITCH_FAILED');
      } finally {
        if (activePersonaTurns.get(sessionId) === lock) activePersonaTurns.delete(sessionId);
      }
    });
  }
}

module.exports = { registerSessionPersonaRoutes };
