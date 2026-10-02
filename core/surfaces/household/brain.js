'use strict';

// Nestor's slower brain (#162, #169). After a turn is recorded, a larger local
// model reviews the canonical conversation in the background and proposes:
// follow-up questions (shown as suggestions), revisions of what was shown,
// corrections for the next turn, and at most one short remark Nestor may say
// at the next natural pause. It has no tools, saves nothing, never alters the
// transcript, and yields to the voice: a new turn cancels a running review.
// Results are advisory and kept in memory only, per conversation.

const LIMITS = Object.freeze({ turns: 6, turnChars: 1500, blockChars: 6000, suggestions: 3, suggestion: 140, corrections: 3, correction: 300,
  revisions: 2, revisionTitle: 80, revisionBody: 2000, interjection: 220, waitMs: 45000, reviewMs: 120000, reviews: 200, delayMs: 800 });

const SPACES = Object.freeze({ private: { packId: 'personal_operator', scopeId: 'personal' }, family: { packId: 'kidx_nestor', scopeId: 'family' } });

function text(value, max) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

// The reviewer's JSON is untrusted: keep only bounded strings in the expected shape.
function readReview(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { value = JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  }
  if (!value || typeof value !== 'object') return null;
  const list = (items, max, map) => (Array.isArray(items) ? items : []).map(map).filter(Boolean).slice(0, max);
  const interjection = text(value.interjection?.text ?? value.interjection, LIMITS.interjection);
  return {
    suggestions: list(value.suggestions, LIMITS.suggestions, item => text(item, LIMITS.suggestion)),
    corrections: list(value.corrections, LIMITS.corrections, item => text(item?.text ?? item, LIMITS.correction)),
    revisions: list(value.revisions, LIMITS.revisions, item => {
      const body = typeof item?.body === 'string' ? item.body.trim().slice(0, LIMITS.revisionBody) : '';
      return body ? { title: text(item.title, LIMITS.revisionTitle) || 'Révision', body } : null;
    }),
    interjection: interjection ? { text: interjection, urgent: value.interjection?.urgent === true } : null
  };
}

function reviewerPrompt({ family }) {
  return [
    'You are the background reviewer of a live household voice conversation between a person and Nestor.',
    'You never speak to the person directly and have no tools. Read the conversation and return only one JSON object:',
    '{"suggestions":["short follow-up question the person might want to ask next"],',
    '"corrections":["a specific earlier statement by Nestor that looks wrong or incomplete, and the correction"],',
    '"revisions":[{"title":"short title","body":"an improved or completed version of something Nestor showed or explained"}],',
    '"interjection":{"text":"at most one short sentence Nestor could add at the next pause","urgent":false}}',
    'Every field is optional; use empty lists and null when there is nothing worth adding. Most turns need nothing.',
    'Suggestions are phrased as the person would ask them, in the conversation\'s language, at most three.',
    'Only correct what you are confident about, and say why. Never invent personal facts, actions or tool results.',
    'The interjection must add real value (a correction, a safety point, a clearly useful detail), be conversational and never repeat what was said.',
    'Set urgent only for safety or a correction that matters now.',
    'Never praise, grade or comment on Nestor\'s answer, and never apologise for it: the interjection is Nestor adding something new, not a critic.',
    'Text marked as shortened for this review was shown complete: never claim or suggest that Nestor was cut off or should finish it.',
    'A revision must change something; do not restate what was already shown.',
    family
      ? 'This is a child\'s family conversation: follow child safety, keep language simple, no private or adult information, and send the child to a trusted adult for anything risky.'
      : 'This is the owner\'s private conversation.'
  ].join(' ');
}

// A reviewer that sees a silently shortened list believes Nestor was cut off.
// Anything shortened here says so, and that the person saw it whole.
function clip(value, max) {
  const source = String(value || '');
  return source.length <= max ? source : source.slice(0, max) + ' […shortened for this review only; the person saw the complete text]';
}

function transcript(turns) {
  return turns.map(turn => [
    turn.inputText ? `Person: ${clip(turn.inputText, LIMITS.turnChars)}` : '',
    turn.replyText ? `Nestor (spoken): ${clip(turn.replyText, LIMITS.turnChars)}` : '',
    ...(turn.display || []).filter(block => block.kind !== 'secret' && block.kind !== 'image' && block.body)
      .map(block => `Nestor (on screen${block.title ? `, ${block.title}` : ''}): ${clip(block.body, LIMITS.blockChars)}`)
  ].filter(Boolean).join('\n')).join('\n\n');
}

function createBrain({ inference, conversations, loadTurns, consumerContract, env = process.env, logger = null, delayMs = LIMITS.delayMs } = {}) {
  const reviews = new Map(), running = new Map(), waiters = new Map();
  const enabled = family => env.HOUSEHOLD_BRAIN_ENABLED === 'true' && (!family || env.HOUSEHOLD_BRAIN_FAMILY !== 'false');

  function settle(sessionId, review) {
    reviews.delete(sessionId);
    reviews.set(sessionId, review);
    while (reviews.size > LIMITS.reviews) reviews.delete(reviews.keys().next().value);
    for (const waiter of waiters.get(sessionId) || []) waiter(review);
    waiters.delete(sessionId);
  }

  // A new turn owns the inference host: the running review for this conversation stops.
  function cancel(sessionId) {
    running.get(sessionId)?.abort();
    running.delete(sessionId);
  }

  async function review({ session, family, traceId, signal }) {
    await new Promise(resolve => setTimeout(resolve, delayMs));
    if (signal.aborted) return;
    const turns = (await loadTurns(session)).slice(-LIMITS.turns);
    if (signal.aborted || !turns.length) return;
    const result = await inference.execute({
      mode: 'chat', taskType: env.HOUSEHOLD_BRAIN_TASK || 'master_brain',
      ...(env.HOUSEHOLD_BRAIN_MODEL ? { model: String(env.HOUSEHOLD_BRAIN_MODEL).replace(/^ollama\//, '') } : {}),
      ...(env.HOUSEHOLD_BRAIN_HOST_URL ? { exclusiveHost: true } : {}),
      messages: [{ role: 'system', content: reviewerPrompt({ family }) }, { role: 'user', content: transcript(turns) }],
      stream: false, think: false, temperature: 0.2, max_tokens: 700,
      callerDetail: `agentx-household/brain/${family ? 'family' : 'private'}`, timeoutMs: LIMITS.reviewMs
    }, { signal, consumerContract, ...(env.HOUSEHOLD_BRAIN_HOST_URL ? { hostUrl: String(env.HOUSEHOLD_BRAIN_HOST_URL) } : {}) });
    if (signal.aborted) return;
    if (!result?.ok) throw new Error('Reviewer inference failed');
    const parsed = readReview(result.body?.message?.content || result.body?.response || result.body?.choices?.[0]?.message?.content || '');
    if (!parsed) throw new Error('Reviewer returned no usable review');
    settle(session.sessionId, { traceId, reviewedAt: new Date().toISOString(), model: result.metadata?.model || '', ...parsed });
  }

  // At most one review per conversation; a newer turn supersedes an older review.
  function schedule({ session, pack, traceId }) {
    const family = pack?.childSafe === true;
    if (!session?.sessionId || !traceId || !enabled(family) || !inference?.execute) return false;
    cancel(session.sessionId);
    const controller = new AbortController();
    running.set(session.sessionId, controller);
    review({ session, family, traceId, signal: controller.signal })
      .catch(error => { if (!controller.signal.aborted) logger?.warn?.('Household brain review failed', { error: error.message }); })
      .finally(() => { if (running.get(session.sessionId) === controller) running.delete(session.sessionId); });
    return true;
  }

  function latest(sessionId, after = '') {
    const found = reviews.get(sessionId);
    return found && (!after || found.traceId === after) ? found : null;
  }

  // Advisory notes for the next turn, so Nestor can acknowledge a correction himself.
  function contextFor(sessionId) {
    const found = reviews.get(sessionId);
    if (!found || (!found.corrections.length && !found.interjection)) return '';
    return '\n\nBackground review of this conversation (advisory, from a slower local model; it may be wrong, so verify before relying on it):'
      + (found.corrections.length ? ' Possible corrections: ' + found.corrections.join(' | ') + '.' : '')
      + (found.interjection ? ` It suggested adding: "${found.interjection.text}" (it may already have been said at a pause).` : '')
      + ' If a correction is right, acknowledge it briefly and naturally in this turn; do not mention the review itself.';
  }

  function wait(sessionId, after, { signal, timeoutMs = LIMITS.waitMs } = {}) {
    const ready = latest(sessionId, after);
    if (ready) return Promise.resolve(ready);
    if (!running.has(sessionId)) return Promise.resolve(null);
    return new Promise(resolve => {
      let done = false;
      const finish = value => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener?.('abort', abort); resolve(value); };
      const waiter = value => finish(value.traceId === after ? value : null);
      const abort = () => finish(null);
      const timer = setTimeout(abort, timeoutMs);
      signal?.addEventListener?.('abort', abort, { once: true });
      waiters.set(sessionId, [...(waiters.get(sessionId) || []), waiter]);
    });
  }

  function register(router) {
    for (const [space, scope] of Object.entries(SPACES)) {
      router.get(`/${space}/sessions/:sessionId/brain`, async (req, res) => {
        const session = await conversations.getSession({ sessionId: req.params.sessionId }).catch(() => null);
        if (!session || session.packId !== scope.packId || session.scopeId !== scope.scopeId) {
          return res.status(404).json({ ok: false, status: 'error', code: 'VOICE_PERSONA_SESSION_NOT_FOUND', message: 'Voice persona session not found' });
        }
        const controller = new AbortController();
        res.on('close', () => controller.abort());
        const found = await wait(session.sessionId, String(req.query.after || ''), { signal: controller.signal });
        if (res.writableEnded || res.destroyed) return undefined;
        return res.json({ ok: true, status: 'success', data: { review: found } });
      });
    }
  }

  return { schedule, cancel, latest, wait, contextFor, register, enabled };
}

module.exports = { createBrain, readReview, reviewerPrompt, transcript, LIMITS };
