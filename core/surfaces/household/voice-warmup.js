'use strict';

// The opening of a spoken personal conversation, put to use.
//
// A model with sliding-window attention can resume its prompt cache only near
// the end of the previous prompt. A new native session changes a late section
// of the agent's system prompt, so the first spoken turn read the whole prompt
// again: seconds of silence before the first word. While the page speaks its
// greeting, Core therefore runs one small turn in the conversation's own
// native session. It tells the agent that it has just greeted the owner, and
// leaves the session's exact prompt in the model's cache: the first real turn
// only appends to it.
//
// The warm-up is not a turn of the conversation: nothing is recorded, spoken
// or shown, and it never runs once someone has spoken. A warm-up that fails or
// is skipped costs nothing but the old first-turn delay.

const LIMITS = Object.freeze({ greeting: 300, deadlineMs: 60000 });
const PRIVATE_SCOPE = Object.freeze({ packId: 'personal_operator', scopeId: 'personal' });

function openingEvent(greeting) {
  return '[Household application event; no human utterance]\n'
    + `The owner has just opened a spoken conversation. You greeted him aloud with: «${greeting}». He has not asked anything yet.`;
}
const OPENING_DIRECTIVE = 'This is not a request and needs no tool. Reply with the single word "Prêt" and nothing else; this reply is neither spoken nor shown.';

function createVoiceWarmup({ conversations, executeConversation, conversationBackend, conversationEnv, packById, instructions, requireNativeAgent = async () => {},
  agentIdFor, logger = null, deadlineMs = LIMITS.deadlineMs }) {
  const running = new Map(); // sessionId -> promise that never rejects
  // Off unless the instance turns it on: its first real use was followed by a turn that
  // produced no deliverable text, and that link is not ruled out yet.
  const enabled = () => String(conversationEnv?.HOUSEHOLD_VOICE_WARMUP || '').trim().toLowerCase() === 'true';

  /** Settles when no warm-up runs in this conversation's native session. */
  const settled = sessionId => running.get(sessionId) || Promise.resolve();

  function start(session, greeting) {
    if (!enabled()) return { started: false, reason: 'disabled' };
    const pack = packById(session.packId);
    const selectedMode = pack?.modes.find(mode => mode.id === session.modeId);
    const text = String(greeting || '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.greeting);
    if (!pack || !selectedMode || !text) return { started: false, reason: 'unavailable' };
    if (session.turnCount > 0 || session.agentSessionKey) return { started: false, reason: 'already_started' };
    if (running.has(session.sessionId)) return { started: false, reason: 'running' };
    if (conversationBackend(session.backend, conversationEnv) !== 'openclaw') return { started: false, reason: 'not_native' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Opening warm-up timed out.')), deadlineMs);
    const run = (async () => {
      await requireNativeAgent(agentIdFor(session));
      await executeConversation({ backend: 'openclaw', session, pack, text: openingEvent(text), history: [], streaming: false, channel: 'voice',
        conversationFeatures: {}, attachments: [], instructions: instructions(session, pack, selectedMode), turnDirective: OPENING_DIRECTIVE,
        signal: controller.signal,
        onStarted: async key => { await conversations.updateSession({ sessionId: session.sessionId }, { $set: { agentSessionKey: key } }); },
        onDelta: () => {} });
    })().catch(error => { logger?.warn?.('Household opening warm-up did not complete', { error: error.message }); })
      .finally(() => { clearTimeout(timer); running.delete(session.sessionId); });
    running.set(session.sessionId, run);
    return { started: true };
  }

  function register(router) {
    router.post('/private/sessions/:sessionId/warm', async (req, res) => {
      const session = await conversations.getSession({ sessionId: req.params.sessionId }).catch(() => null);
      if (!session || session.status !== 'active' || session.packId !== PRIVATE_SCOPE.packId || session.scopeId !== PRIVATE_SCOPE.scopeId) {
        return res.status(404).json({ ok: false, status: 'error', code: 'VOICE_PERSONA_SESSION_NOT_FOUND', message: 'Voice persona session not found' });
      }
      let result;
      try { result = start(session, req.body?.greeting); } catch (error) { result = { started: false, reason: 'unavailable' }; logger?.warn?.('Household opening warm-up was not started', { error: error.message }); }
      return res.status(result.started ? 202 : 200).json({ ok: true, status: 'success', data: result });
    });
  }

  return { start, settled, register };
}

module.exports = { createVoiceWarmup, openingEvent, OPENING_DIRECTIVE, LIMITS };
