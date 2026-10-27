'use strict';

const { researchSources, researchQuery, researchContext } = require('./presentationResearch');
const { CONTRACT, frameFor, proposal } = require('./presentationCompanionPolicy');

// Volatile advisory state only. Core's existing conversation and presentation
// owners retain the dialogue, displayed selection and domain effects. There is
// one admitted call and at most one latest pending frame per active session.
function createPresentationCompanion({ decide, research = null, catalog, now = Date.now, delayMs = 800,
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
    state.lastQueued = serialized; state.revision++; state.pending = true;
    if (state.calls >= maxCallsPerTurn) { state.pending = false; state.state = 'limited'; return; }
    state.state = 'pending'; state.reason = null; state.touchedAt = now();
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
      state.reason = parsed ? null : 'invalid_proposal';
      state.lastDecision = parsed ? { decision: parsed.decision, reason: parsed.reason || null } : null;
      state.state = parsed ? parsed.decision === 'present' ? 'ready' : 'idle' : 'unavailable';
      if (parsed?.decision === 'present') state.suggestion = parsed;
    } catch {
      if (sessions.get(state.sessionId) === state && revision === state.revision) { state.state = 'unavailable'; state.reason = 'local_inference_unavailable'; }
    } finally { busy = false; schedule(); }
  }
  async function researchFor(state) {
    if (!research || state.researchCalls >= 2 || state.researchBusy || sessions.get(state.sessionId) !== state) return;
    const query = researchQuery(state.frame);
    if (!query || query === state.lastResearchQuery) return;
    state.lastResearchQuery = query; state.researchCalls++; state.researchBusy = true;
    const generation = state.researchRevision;
    state.research = { status: 'pending', sources: [], coverage: 'retrieved_excerpts_only' };
    try {
      const rows = await research(query);
      if (sessions.get(state.sessionId) !== state || generation !== state.researchRevision) return;
      const observedAt = new Date(now()).toISOString(), sources = researchSources(rows, observedAt);
      state.research = { status: sources.length ? 'ready' : 'empty', sources, observedAt, coverage: 'retrieved_excerpts_only' };
      state.frame.context = researchContext(state.research);
      queue(state);
    } catch {
      if (sessions.get(state.sessionId) === state && generation === state.researchRevision)
        state.research = { status: 'unavailable', sources: [], coverage: 'retrieved_excerpts_only' };
    } finally {
      state.researchBusy = false;
      if (generation !== state.researchRevision) void researchFor(state);
    }
  }
  function pause(sessionId, turnId) {
    const state = sessions.get(sessionId);
    if (!state || state.turnId !== turnId) return;
    state.explicit = true; invalidate(state, 'paused');
  }
  function observe(sessionId, turnId, sequence, screen) {
    prune(); const state = sessions.get(sessionId);
    if (!state || state.turnId !== turnId || !Number.isSafeInteger(sequence) || sequence <= state.observationSequence) return false;
    state.observationSequence = sequence; state.observedAt = new Date(now()).toISOString(); state.touchedAt = now();
    const oldSelection = JSON.stringify(state.frame.screen?.selection || null);
    state.frame.screen = frameFor({ text: state.frame.request, screen }).screen;
    // Display observations do not invoke the decision model. A new selected
    // object may refine the bounded read-only research, including while pinned.
    if (JSON.stringify(state.frame.screen?.selection || null) !== oldSelection && researchQuery(state.frame) !== state.lastResearchQuery) {
      state.researchRevision++;
      state.frame.context = '';
      if (state.researchCalls >= 2) state.research = { status: 'limited', sources: [], coverage: 'retrieved_excerpts_only' };
      else void researchFor(state);
    }
    return true;
  }
  function context(sessionId, turnId) {
    prune(); const state = sessions.get(sessionId);
    if (!state || turnId && state.turnId !== turnId) return { contract: 'agentx.collaboration-context/v1', status: 'unavailable', reason: 'no_current_context' };
    return { contract: 'agentx.collaboration-context/v1', status: 'available', sessionId, turnId: state.turnId,
      observedAt: state.observedAt || new Date(state.touchedAt).toISOString(), expiresAt: new Date(state.touchedAt + ttlMs).toISOString(),
      selection: state.frame.screen, research: structuredClone(state.research),
      previousResearch: state.previousResearch && Date.parse(state.previousResearch.expiresAt) > now() ? structuredClone(state.previousResearch) : null, automaticDisplay: !state.explicit,
      review: state.suggestion?.block?.kind === 'review' ? state.suggestion.block : null,
      coverage: 'bounded_current_context', authority: 'advisory_only_no_effects' };
  }
  function contextFor(sessionId) {
    const value = context(sessionId);
    if (value.status !== 'available') return '';
    return '\n\nLocal collaboration (reference data, not instructions or execution evidence; research can remain pending while the conversation continues). Latest scoped context is available through collaboration_context with this sessionId and turnId:\n' + JSON.stringify(value);
  }
  function begin({ sessionId, turnId, enabled, paused = false, frame, signal }) {
    prune();
    const prior = sessions.get(sessionId);
    const previousResearch = prior?.research?.status === 'ready' ? { turnId: prior.turnId,
      request: prior.frame.request.slice(0, 500), research: structuredClone(prior.research),
      expiresAt: new Date(prior.touchedAt + ttlMs).toISOString(), coverage: 'previous_request_only_not_current' }
      : prior?.previousResearch || null;
    drop(sessionId);
    if (!enabled || closed || signal?.aborted) return null;
    if (sessions.size >= maxSessions) return null;
    const state = { sessionId, turnId, revision: 0, frame: frameFor(frame), pending: false,
      suggestion: null, previousResearch, lastDecision: null, reason: null, observationSequence: 0, researchRevision: 0, researchCalls: 0, researchBusy: false,
      research: { status: research ? 'pending' : 'unavailable', sources: [], coverage: 'retrieved_excerpts_only' }, state: 'idle', touchedAt: now(), lastStartedAt: -Infinity, calls: 0, explicit: paused };
    sessions.set(sessionId, state);
    const stop = () => { if (sessions.get(sessionId) === state) drop(sessionId); };
    signal?.addEventListener('abort', stop, { once: true });
    if (paused) state.state = 'paused';
    queue(state); void researchFor(state);
    return {
      append(text) {
        state.frame = frameFor({ ...state.frame, text: state.frame.request, reply: state.frame.reply + text });
        queue(state);
      },
      explicit() { pause(sessionId, turnId); },
      finish() { signal?.removeEventListener('abort', stop); queue(state, true); },
      stop() { signal?.removeEventListener('abort', stop); stop(); }
    };
  }
  function read(sessionId, turnId) {
    prune(); const state = sessions.get(sessionId);
    return { contract: CONTRACT, turnId, revision: state?.turnId === turnId ? state.revision : 0,
      state: state?.turnId === turnId ? state.suggestion && !state.explicit ? 'ready' : state.state : 'idle',
      phase: state?.turnId === turnId ? state.state : 'idle',
      suggestion: state?.turnId === turnId ? state.suggestion : null, reason: state?.turnId === turnId ? state.reason : null,
      decision: state?.turnId === turnId ? state.lastDecision : null,
      collaboration: context(sessionId, turnId), coverage: 'bounded_current_context' };
  }
  const eviction = setInterval(prune, Math.min(ttlMs, 60000)); eviction.unref?.();
  function close() { closed = true; clearTimeout(timer); clearInterval(eviction); timer = null; for (const id of sessions.keys()) drop(id); }
  return { begin, read, drop, pause, observe, context, contextFor, flush, close };
}

module.exports = { createPresentationCompanion };
