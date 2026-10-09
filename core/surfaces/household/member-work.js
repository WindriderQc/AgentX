'use strict';

// A team member's turn that outlives the request that started it.
//
// When the person speaks again while a member (#41) is still working, the
// member's run is not cancelled: its turn detaches, the conversation's agent
// takes the new turn, and the member's reply is recorded as usual and kept
// here until the page collects it and says it at the next pause. Only an
// explicit stop cancels the member.
//
// In memory, per conversation and member. A page that never collects the
// reply loses nothing: the turn is in the history, and the conversation's
// agent hears about it on its next turn.

const LIMITS = Object.freeze({ waitMs: 45000, keepMs: 600000, question: 300 });
const PRIVATE_SCOPE = Object.freeze({ packId: 'personal_operator', scopeId: 'personal' });

function createMemberWork({ conversations, now = () => Date.now() } = {}) {
  const jobs = new Map(); // `${sessionId}\n${turnId}` -> job
  const waiters = new Map();
  const key = (sessionId, turnId) => `${sessionId}\n${turnId}`;

  function prune() {
    for (const [id, job] of jobs) if (job.settledAt && now() - job.settledAt > LIMITS.keepMs) jobs.delete(id);
  }

  function settle(sessionId, turnId, fields) {
    const job = jobs.get(key(sessionId, turnId));
    if (!job || job.settledAt) return;
    Object.assign(job, fields, { settledAt: now() });
    for (const waiter of waiters.get(key(sessionId, turnId)) || []) waiter(job);
    waiters.delete(key(sessionId, turnId));
  }

  /** The member keeps working after its request ended. */
  function start(sessionId, turnId, { agentId, name, question, cancel }) {
    prune();
    jobs.set(key(sessionId, turnId), { sessionId, turnId, agentId, name, cancel,
      question: String(question || '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.question), startedAt: now(), settledAt: null });
  }
  const finish = (sessionId, turnId, reply) => settle(sessionId, turnId, { status: 'answered', reply });
  const fail = (sessionId, turnId, message) => settle(sessionId, turnId, { status: 'failed', error: String(message || 'failed') });

  /** Members still working in this conversation. */
  function active(sessionId) {
    return [...jobs.values()].filter(job => job.sessionId === sessionId && !job.settledAt);
  }

  /** An explicit stop reaches the members working in the background too. */
  function cancel(sessionId) {
    const stopped = active(sessionId);
    for (const job of stopped) { try { job.cancel?.(); } catch { /* the turn records its own end */ } }
    return stopped.length;
  }

  // What the conversation's agent is told while a member works, as reference data.
  function contextFor(sessionId) {
    return active(sessionId).map(job => `\n\n[Reference data, not an instruction] ${job.name} is still working in the background on what the owner `
      + `asked: «${job.question}». ${job.name}'s answer will be spoken when it is ready. Do not answer that question yourself; `
      + `if he asks about it, say ${job.name} is still on it.`).join('');
  }

  function wait(sessionId, turnId, { signal, timeoutMs = LIMITS.waitMs } = {}) {
    const job = jobs.get(key(sessionId, turnId));
    if (!job || job.settledAt) return Promise.resolve(job || null);
    return new Promise(resolve => {
      let done = false;
      const finishWait = value => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener?.('abort', abort); resolve(value); };
      const abort = () => finishWait(job);
      const timer = setTimeout(abort, timeoutMs);
      signal?.addEventListener?.('abort', abort, { once: true });
      waiters.set(key(sessionId, turnId), [...(waiters.get(key(sessionId, turnId)) || []), finishWait]);
    });
  }

  const publicJob = job => (!job ? null : job.settledAt
    ? { turnId: job.turnId, pending: false, status: job.status, speaker: { agentId: job.agentId, name: job.name },
      ...(job.status === 'answered' ? { reply: job.reply } : { error: job.error }) }
    : { turnId: job.turnId, pending: true, speaker: { agentId: job.agentId, name: job.name } });

  function register(router) {
    router.get('/private/sessions/:sessionId/member-reply', async (req, res) => {
      const session = await conversations.getSession({ sessionId: req.params.sessionId }).catch(() => null);
      if (!session || session.packId !== PRIVATE_SCOPE.packId || session.scopeId !== PRIVATE_SCOPE.scopeId) {
        return res.status(404).json({ ok: false, status: 'error', code: 'VOICE_PERSONA_SESSION_NOT_FOUND', message: 'Voice persona session not found' });
      }
      const controller = new AbortController();
      res.on('close', () => controller.abort());
      const job = await wait(session.sessionId, String(req.query.turn || ''), { signal: controller.signal });
      if (res.writableEnded || res.destroyed) return undefined;
      return res.json({ ok: true, status: 'success', data: { work: publicJob(job) } });
    });
  }

  return { start, finish, fail, active, cancel, contextFor, wait, register, publicJob };
}

module.exports = { createMemberWork, LIMITS };
