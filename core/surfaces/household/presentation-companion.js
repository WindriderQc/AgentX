'use strict';

const { createPresentationCompanion } = require('../../src/services/conversations/presentationCompanion');
const { instructions, decisionSchema } = require('../../src/services/conversations/presentationCompanionPolicy');
const { voiceTask } = require('./conversation-executor');

const eligible = session => session?.backend === 'hermes' && session.packId === 'personal_operator'
  && session.scopeId === 'personal' && session.status === 'active' && !session.ephemeral
  && !session.llmx && (!session.agentId || session.agentId === 'main');

function registerPresentationCompanion({ router, conversations, inference, catalog, consumerContract,
  env = process.env, envelope, fail, decide, memory = null }) {
  const companion = createPresentationCompanion({ catalog, research: memory?.search
    ? query => memory.search(query, { topK: 3, timeoutMs: 5000 }) : null, decide: decide || (async (frame, observation) => {
    // Reuse the instance's existing small conversation route. No new model,
    // load option, topology, native agent, grant or external runtime is installed.
    const result = await inference.execute({ mode: 'chat', executionSource: 'local', taskType: voiceTask(env),
      messages: [{ role: 'system', content: instructions(catalog) }, { role: 'user', content: JSON.stringify(frame) }],
      stream: false, think: false, temperature: 0, max_tokens: 900, format: decisionSchema(frame),
      callerDetail: 'agentx-household/presentation-companion', timeoutMs: 30000 }, { consumerContract,
      attribution: { runtime: 'agentx', correlationId: 'presentation-companion:' + observation.turnId } });
    if (!result?.ok) throw new Error('Presentation inference unavailable');
    return result.body?.message?.content || result.body?.response || result.body?.choices?.[0]?.message?.content || '';
  }) });
  const scope = sessionId => ({ sessionId, packId: 'personal_operator', scopeId: 'personal' });
  async function sessionFor(req) {
    const session = await conversations.getSession(scope(req.params.sessionId));
    if (!eligible(session)) {
      companion.drop(req.params.sessionId);
      throw Object.assign(new Error('Presentation companion unavailable for this conversation.'), { statusCode: 404 });
    }
    return session;
  }
  require('../../src/services/conversations/presentationCollaborationAccess').installReader(async input => {
    await sessionFor({ params: { sessionId: input.sessionId } });
    return companion.context(input.sessionId, input.turnId);
  });
  router.post('/private/sessions/:sessionId/companion/observations', async (req, res) => {
    try {
      await sessionFor(req);
      const { turnId, sequence, screen } = req.body || {};
      if (!/^[a-zA-Z0-9-]{16,80}$/.test(turnId || '') || !Number.isSafeInteger(sequence) || sequence < 1)
        return fail(res, 400, 'A bound display observation is required.');
      const selected = require('./screen-context').presentationEvidence(screen, catalog);
      if (!selected) return fail(res, 400, 'Invalid presentation observation.');
      return envelope(res, { accepted: companion.observe(req.params.sessionId, turnId, sequence, selected) });
    } catch (error) { return fail(res, error.statusCode || 503, 'Presentation context unavailable.'); }
  });
  router.get('/private/sessions/:sessionId/companion/:turnId', async (req, res) => {
    try {
      await sessionFor(req); res.set('Cache-Control', 'private, no-store');
      return envelope(res, companion.read(req.params.sessionId, req.params.turnId));
    } catch (error) { return fail(res, error.statusCode || 503, 'Presentation companion unavailable.'); }
  });
  router.post('/private/sessions/:sessionId/companion/stop', async (req, res) => {
    try {
      await sessionFor(req);
      if (!/^[a-zA-Z0-9-]{16,80}$/.test(req.body?.turnId || '')) return fail(res, 400, 'The current presentation turn is required.');
      if (req.body.end === true) companion.drop(req.params.sessionId, req.body.turnId);
      else companion.pause(req.params.sessionId, req.body.turnId);
      return envelope(res, { state: 'stopped' });
    } catch (error) { return fail(res, error.statusCode || 503, 'Presentation companion unavailable.'); }
  });
  return {
    begin({ session, enabled, ...input }) {
      return companion.begin({ ...input, sessionId: session.sessionId, enabled: enabled === true && eligible(session) });
    },
    contextFor: companion.contextFor, drop: companion.drop, close: companion.close
  };
}

module.exports = { eligible, registerPresentationCompanion };
