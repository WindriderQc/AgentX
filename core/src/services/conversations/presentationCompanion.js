'use strict';

const { CONTRACT, frameFor, proposal } = require('./presentationCompanionPolicy');

// Volatile advisory state only. Core's existing conversation and presentation
// owners retain the dialogue, displayed selection and domain effects. There is
// one admitted call and at most one latest pending frame per active session.
function createPresentationCompanion({ decide, catalog, now = Date.now, delayMs = 800,
  minIntervalMs = 4000, ttlMs = 300000, maxSessions = 32, maxCallsPerTurn = 6 } = {}) {
  const sessions = new Map();
  let busy = false, timer = null, closed = false;
  function invalidate(state, reason) {
    if (!state) return;
    state.revision++; state.pending = false; state.suggestion = null; state.state = reason;
  }
  function drop(id, turnId) {
    if (turnId && sessions.get(id)?.turnId !== turnId) return;
    invalidate(sessions.get(id), 'stopped'); sessions.delete(id);
  }
  function prune() {
    for (const [id, state] of sessions) if (now() - state.touchedAt > ttlMs) drop(id);
  }
  function schedule() {
    if (closed || busy || timer) return;
    const pending = [...sessions.values()].filter(state => state.pending);
    if (!pending.length) return;
    const wait = Math.max(0, Math.min(...pending.map(state => state.dueAt)) - now());
    timer = setTimeout(() => { timer = null; void flush(); }, wait);
    timer.unref?.();
  }
  function queue(state, final = false) {
    if (closed || state.explicit || sessions.get(state.sessionId) !== state) return;
    const serialized = JSON.stringify(state.frame);
    if (serialized === state.lastQueued) return;
    state.lastQueued = serialized; state.revision++; state.pending = true; state.suggestion = null;
    if (state.calls >= maxCallsPerTurn) { state.pending = false; state.state = 'limited'; return; }
    state.state = 'pending'; state.touchedAt = now();
    state.dueAt = Math.max(now() + (final ? 0 : delayMs), state.lastStartedAt + minIntervalMs);
    schedule();
  }
  async function flush() {
    if (busy || closed) return;
    prune();
    const state = [...sessions.values()].filter(row => row.pending && row.dueAt <= now()).sort((a, b) => a.dueAt - b.dueAt)[0];
    if (!state) { schedule(); return; }
    busy = true; state.pending = false; state.state = 'running'; state.calls++; state.lastStartedAt = now();
    const revision = state.revision, frame = structuredClone(state.frame);
    try {
      // Never cancel an admitted native inference merely to supersede a frame.
      // Its own inference owner retains settlement; an obsolete result is dropped.
      const raw = await decide(frame, { turnId: state.turnId, revision });
      if (sessions.get(state.sessionId) !== state || revision !== state.revision || state.explicit || closed) return;
      const parsed = proposal(raw, frame, catalog);
      state.state = parsed ? parsed.decision === 'present' ? 'ready' : 'idle' : 'unavailable';
      state.suggestion = parsed?.decision === 'present' ? parsed : null;
    } catch {
      if (sessions.get(state.sessionId) === state && revision === state.revision) state.state = 'unavailable';
    } finally { busy = false; schedule(); }
  }
  function begin({ sessionId, turnId, enabled, frame, signal }) {
    prune(); drop(sessionId);
    if (!enabled || closed || signal?.aborted) return null;
    if (sessions.size >= maxSessions) return null;
    const state = { sessionId, turnId, revision: 0, frame: frameFor(frame), pending: false,
      suggestion: null, state: 'idle', touchedAt: now(), lastStartedAt: -Infinity, calls: 0, explicit: false };
    sessions.set(sessionId, state);
    const stop = () => { if (sessions.get(sessionId) === state) drop(sessionId); };
    signal?.addEventListener('abort', stop, { once: true });
    queue(state);
    return {
      append(text) {
        state.frame = frameFor({ ...frame, reply: state.frame.reply + text });
        queue(state);
      },
      explicit() { state.explicit = true; invalidate(state, 'paused'); },
      finish() { signal?.removeEventListener('abort', stop); queue(state, true); },
      stop() { signal?.removeEventListener('abort', stop); stop(); }
    };
  }
  function read(sessionId, turnId) {
    prune(); const state = sessions.get(sessionId);
    return { contract: CONTRACT, turnId, revision: state?.turnId === turnId ? state.revision : 0,
      state: state?.turnId === turnId ? state.state : 'idle',
      suggestion: state?.turnId === turnId ? state.suggestion : null, coverage: 'bounded_current_context' };
  }
  const eviction = setInterval(prune, Math.min(ttlMs, 60000)); eviction.unref?.();
  function close() { closed = true; clearTimeout(timer); clearInterval(eviction); timer = null; for (const id of sessions.keys()) drop(id); }
  return { begin, read, drop, flush, close };
}

module.exports = { createPresentationCompanion };
