/**
 * Live state of one running Council.
 *
 * The emitter numbers every streamed chunk and folds it into an in-memory
 * state, so a client that attaches mid-round receives a snapshot of the
 * current phase, the partial answers and the synthesis, then only the events
 * numbered after it. Saved turns stay in Mongo; this holds what is in flight.
 */

const { EventEmitter } = require('events');

function emptyState() {
  return { status: 'pending', phase: 'round-1', round: 0, agents: {}, synthesis: null };
}

function agentEntry(state, data) {
  const id = String(data.agentId || '');
  if (!id) return null;
  if (!state.agents[id]) {
    state.agents[id] = {
      round: data.round || state.round || 1,
      status: 'pending',
      text: '',
      searchNote: '',
      stats: null,
      error: null
    };
  }
  return state.agents[id];
}

function applyEvent(state, data) {
  switch (data.type) {
    case 'started':
      state.status = 'running';
      break;
    case 'round-start':
      state.status = 'running';
      state.round = data.round;
      state.phase = `round-${data.round}`;
      state.agents = {};
      break;
    case 'web-search-start': {
      const entry = agentEntry(state, data);
      if (entry) entry.status = 'searching';
      break;
    }
    case 'web-search-done': {
      const entry = agentEntry(state, data);
      if (entry) entry.searchNote = `[web search: ${data.resultCount} results]\n\n`;
      break;
    }
    case 'turn-start': {
      const entry = agentEntry(state, data);
      if (entry) Object.assign(entry, { status: 'running', text: '', error: null });
      break;
    }
    case 'turn-chunk': {
      const entry = agentEntry(state, data);
      if (entry) entry.text += data.content || '';
      break;
    }
    case 'turn-done': {
      const entry = agentEntry(state, data);
      if (entry) Object.assign(entry, { status: data.error ? 'error' : 'done', stats: data.stats || null, error: data.error || null });
      break;
    }
    case 'synthesis-start':
      state.phase = 'synthesis';
      state.synthesis = { model: data.model || null, text: '', status: 'running', stats: null, error: null };
      break;
    case 'synthesis-chunk':
      if (state.synthesis) state.synthesis.text += data.content || '';
      break;
    case 'synthesis-done':
      if (state.synthesis) {
        Object.assign(state.synthesis, { status: data.error ? 'error' : 'done', stats: data.stats || null, error: data.error || null });
      }
      break;
    case 'done':
      state.status = data.status || 'done';
      state.phase = 'done';
      break;
    default:
      break;
  }
}

class LiveRunEmitter extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(20);
    this.seq = 0;
    this.state = emptyState();
  }

  emit(event, data) {
    if (event === 'chunk' && data && typeof data === 'object') {
      this.seq += 1;
      const numbered = { ...data, seq: this.seq };
      applyEvent(this.state, numbered);
      return super.emit(event, numbered);
    }
    return super.emit(event, data);
  }

  // A copy taken in the same tick as the subscription: no event falls between them.
  snapshot() {
    return { seq: this.seq, ...JSON.parse(JSON.stringify(this.state)) };
  }
}

module.exports = { LiveRunEmitter, applyEvent, emptyState };
