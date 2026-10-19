const { LiveRunEmitter } = require('../../src/services/roundtable/liveRun');

describe('Council live run state', () => {
  test('numbers each chunk and keeps the partial answers of the current round', () => {
    const emitter = new LiveRunEmitter();
    const seen = [];
    emitter.on('chunk', (data) => seen.push(data.seq));
    emitter.emit('chunk', { type: 'started', rounds: 2 });
    emitter.emit('chunk', { type: 'round-start', round: 1 });
    emitter.emit('chunk', { type: 'turn-start', agentId: 'a', round: 1 });
    emitter.emit('chunk', { type: 'turn-chunk', agentId: 'a', round: 1, content: 'Round one A' });
    emitter.emit('chunk', { type: 'turn-done', agentId: 'a', round: 1, stats: { completionTokens: 3 } });
    emitter.emit('chunk', { type: 'round-start', round: 2 });
    emitter.emit('chunk', { type: 'web-search-start', agentId: 'b', round: 2 });
    emitter.emit('chunk', { type: 'web-search-done', agentId: 'b', round: 2, resultCount: 4 });
    emitter.emit('chunk', { type: 'turn-start', agentId: 'b', round: 2 });
    emitter.emit('chunk', { type: 'turn-chunk', agentId: 'b', round: 2, content: 'Rebut' });
    emitter.emit('chunk', { type: 'turn-chunk', agentId: 'b', round: 2, content: 'tal' });

    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const snap = emitter.snapshot();
    expect(snap).toMatchObject({ seq: 11, status: 'running', phase: 'round-2', round: 2, synthesis: null });
    // Round one's answer belongs to the saved turns, not to the round in flight.
    expect(snap.agents).toEqual({
      b: { round: 2, status: 'running', text: 'Rebuttal', searchNote: '[web search: 4 results]\n\n', stats: null, error: null }
    });
  });

  test('records the synthesis in flight and the terminal status', () => {
    const emitter = new LiveRunEmitter();
    emitter.emit('chunk', { type: 'round-start', round: 1 });
    emitter.emit('chunk', { type: 'synthesis-start', model: 'model-a' });
    emitter.emit('chunk', { type: 'synthesis-chunk', content: 'Verdict' });
    expect(emitter.snapshot()).toMatchObject({ phase: 'synthesis', synthesis: { model: 'model-a', text: 'Verdict', status: 'running' } });
    emitter.emit('chunk', { type: 'done', status: 'cancelled' });
    expect(emitter.snapshot()).toMatchObject({ seq: 4, phase: 'done', status: 'cancelled' });
  });

  test('a snapshot is a copy: later events do not change it', () => {
    const emitter = new LiveRunEmitter();
    emitter.emit('chunk', { type: 'round-start', round: 1 });
    emitter.emit('chunk', { type: 'turn-start', agentId: 'a', round: 1 });
    const snap = emitter.snapshot();
    emitter.emit('chunk', { type: 'turn-chunk', agentId: 'a', round: 1, content: 'later' });
    expect(snap.agents.a.text).toBe('');
  });
});
