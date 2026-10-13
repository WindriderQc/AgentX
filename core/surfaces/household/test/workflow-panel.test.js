'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create, createModel, stageState, intervals } = require('../public/workflow-panel');
const { createWorkDelivery } = require('../../../src/services/conversationWorks/delivery');

const work = (id, turnId, revision = 1, extra = {}) => ({ id, turnId, sessionId: 'session-1', revision,
  state: 'running', guardianStatus: 'running', classification: 'unclassified', tools: [], nativeAdmissions: [], ...extra });
const event = (sequence, workId, type, at) => ({ sequence, workId, type, at });

test('parallel turns keep one ordered Core chronology and independent component states', () => {
  const model = createModel();
  model.begin('session-1', 'turn-a', 'voice');
  model.timings('turn-a', { sttDone: 640, requestSent: 700 });
  model.begin('session-1', 'turn-b', 'text');
  model.ingest('session-1', { items: [work('work-a', 'turn-a', 2), work('work-b', 'turn-b', 2,
    { guardianStatus: 'completed', attempt: { id: 'attempt-b', agentId: 'main', runId: 'resp-b' } })],
    events: [event(3, 'work-a', 'guardian_started', '2026-10-11T12:00:01Z'),
      event(4, 'work-b', 'request_received', '2026-10-11T12:00:02Z'),
      event(5, 'work-a', 'dispatch_marked', '2026-10-11T12:00:03Z')], cursor: 5 });
  const [a, b] = model.snapshot().turns;
  assert.deepEqual(a.events.map(item => item.sequence), [3, 5]);
  assert.deepEqual(b.events.map(item => item.sequence), [4]);
  assert.equal(stageState('stt', a)[0], 'Done');
  assert.equal(stageState('review', a)[0], 'In progress');
  assert.equal(stageState('agents', b)[1], 'main · run resp-b');
  assert.equal(stageState('stt', b)[0], 'No voice');
});

test('STT and Gardien remain observable while a review is deliberately delayed', () => {
  const model = createModel();
  model.begin('session-1', 'turn-a', 'voice');
  model.timings('turn-a', { sttDone: 450, requestSent: 500, firstDelta: 1600 });
  model.ingest('session-1', { items: [work('work-a', 'turn-a')], events: [] });
  const row = model.snapshot().turns[0];
  assert.equal(stageState('stt', row)[0], 'Done');
  assert.equal(stageState('guardian', row)[0], 'Active');
  assert.equal(stageState('review', row)[0], 'Waiting');
  assert.equal(stageState('tts', row)[0], 'Unknown');
});

test('microphone captures stay separate from submitted conversation turns', () => {
  const model = createModel();
  model.begin('session-1', 'accepted', 'voice');
  model.stream('accepted', { type: 'done', data: {} });
  model.capture('session-1', 'stop-capture');
  let view = model.snapshot();
  assert.deepEqual(view.turns.map(row => row.id), ['accepted']);
  assert.equal(stageState('stt', view.captures[0])[0], 'In progress');
  model.timings('stop-capture', { sttDone: 171 });
  model.captureEnd('stop-capture', { outcome: 'stop' });
  view = model.snapshot();
  assert.equal(view.turns.length, 1);
  assert.equal(view.captures[0].captureOutcome, 'stop');
  assert.equal(view.captures[0].live, false);
  model.capture('session-1', 'next');
  model.begin('session-1', 'next', 'voice');
  model.stream('next', { type: 'accepted' });
  model.captureEnd('next', { outcome: 'recognized' });
  view = model.snapshot();
  assert.deepEqual(view.turns.map(row => row.id), ['accepted', 'next']);
  assert.equal(view.captures.length, 1);
  assert.equal(stageState('guardian', view.turns[1])[0], 'Waiting');
});
test('a waiting-host signal never masks terminal or stale Gardien evidence', () => {
  const model = createModel(); model.begin('session-1', 'turn-a', 'voice');
  model.stream('turn-a', { type: 'status', phase: 'waiting_host' });
  assert.equal(stageState('guardian', model.snapshot().turns[0])[0], 'Waiting');
  model.stream('turn-a', { type: 'done', data: {} });
  assert.equal(stageState('guardian', model.snapshot().turns[0])[0], 'Unknown');
  model.ingest('session-1', { items: [work('work-a', 'turn-a', 1,
    { guardianStatus: 'completed' })], events: [] });
  assert.equal(stageState('guardian', model.snapshot().turns[0])[0], 'Done');
  model.ingest('session-1', { items: [work('work-a', 'turn-a', 2,
    { guardianStatus: 'failed' })], events: [] });
  assert.equal(stageState('guardian', model.snapshot().turns[0])[0], 'Failed');
  model.ingest('session-1', { items: [work('work-a', 'turn-a', 3,
    { guardianStatus: 'running' })], events: [] });
  model.pollFailure('session-1');
  assert.equal(stageState('guardian', { ...model.snapshot().turns[0], telemetryStale: true })[0], 'Uncertain');
});

test('failed, cancelled and paused review work reports its canonical state and safe reason', () => {
  const model = createModel(); model.begin('session-1', 'turn-a', 'voice');
  model.review('turn-a', { adviceId: 'older-advice', version: 1 });
  model.ingest('session-1', { items: [work('work-a', 'turn-a', 3,
    { state: 'failed', reason: 'native_preparation_refused' })], events: [] });
  assert.deepEqual(stageState('review', model.snapshot().turns[0]),
    ['Failed', 'Work work-a · agent preparation refused']);
  model.ingest('session-1', { items: [work('work-a', 'turn-a', 2,
    { state: 'result_ready', result: { version: 1 } })], events: [] });
  assert.equal(stageState('review', model.snapshot().turns[0])[0], 'Failed', 'an older result cannot erase the failure');
  model.ingest('session-1', { items: [work('work-a', 'turn-a', 4,
    { state: 'cancelled', reason: 'owner_cancelled_before_dispatch' })], events: [] });
  assert.equal(stageState('review', model.snapshot().turns[0])[0], 'Cancelled');
  model.ingest('session-1', { items: [work('work-a', 'turn-a', 5,
    { state: 'paused', reason: '' })], events: [] });
  assert.deepEqual(stageState('review', model.snapshot().turns[0]), ['Paused', 'Work work-a · reason not detailed']);
  model.ingest('session-1', { items: [work('work-a', 'turn-a', 6,
    { state: 'result_ready', reason: '', result: { version: 2 } })], events: [] });
  assert.equal(stageState('review', model.snapshot().turns[0])[0], 'Available');
});

test('a received or queued work does not claim review activity before a dispatch receipt', () => {
  const model = createModel(); model.begin('session-1', 'turn-a', 'voice');
  for (const [revision, state] of [[1, 'received'], [2, 'queued'], [3, 'running']]) {
    model.ingest('session-1', { items: [work('work-a', 'turn-a', revision, { state })],
      events: [event(1, 'work-a', 'request_received', '2026-10-11T12:00:00Z')] });
    assert.equal(stageState('review', model.snapshot().turns[0])[0], 'Waiting');
  }
  model.ingest('session-1', { items: [work('work-a', 'turn-a', 4, { state: 'dispatching' })],
    events: [event(2, 'work-a', 'dispatch_marked', '2026-10-11T12:00:02Z')] });
  assert.equal(stageState('review', model.snapshot().turns[0])[0], 'In progress');
});

test('complete-context refusal discloses the unavailable review without claiming activity or advice', () => {
  const model = createModel(); model.begin('session-1', 'turn-a', 'voice');
  model.ingest('session-1', { items: [work('work-a', 'turn-a', 2,
    { state: 'failed', reason: 'CONVERSATION_CONTEXT_REQUIRED', attempt: null })],
    events: [event(1, 'work-a', 'preparation_refused', '2030-01-01T12:00:00Z')] });
  assert.deepEqual(stageState('review', model.snapshot().turns[0]),
    ['Failed', 'Work work-a · not enough context to review the whole conversation']);
});

test('a completed review with no useful addition remains visible as completed', () => {
  const model = createModel(); model.begin('session-1', 'turn-a', 'voice');
  model.ingest('session-1', { items: [work('work-a', 'turn-a', 4,
    { state: 'completed', resultDisposition: 'no_work', guardianStatus: 'completed' })], events: [] });
  assert.deepEqual(stageState('review', model.snapshot().turns[0]), ['Done', 'Work work-a · nothing useful to add']);
});

test('late advice from a superseded turn stays marked replaced and inclusion is never inferred', () => {
  const model = createModel();
  model.begin('session-1', 'turn-a', 'voice');
  model.begin('session-1', 'turn-b', 'voice');
  model.review('turn-a', { traceId: 'turn-a' });
  model.review('turn-b', { traceId: 'turn-b' });
  const [a, b] = model.snapshot().turns;
  assert.equal(a.reviews[0].replaced, true);
  assert.equal(a.reviews[0].included, false);
  assert.equal(b.reviews[0].replaced, false);
  model.begin('session-1', 'turn-c', 'voice');
  model.review('turn-c', { traceId: 'turn-c' });
  assert.equal(model.snapshot().turns[1].reviews[0].replaced, true);
});

test('a delayed advice response from a previous session cannot enter the current map', () => {
  const model = createModel();
  model.begin('session-1', 'turn-old', 'text');
  model.begin('session-2', 'turn-new', 'text');
  assert.equal(model.review('turn-old', { adviceId: 'late', version: 1 }, 'session-1'), false);
  assert.deepEqual(model.snapshot().turns.map(row => row.id), ['turn-new']);
});

test('a late older review cannot replace a newer review after history reorders the turns', () => {
  const model = createModel();
  model.ingest('session-1', { items: [
    work('work-b', 'turn-b', 1, { receivedAt: '2026-10-11T12:02:00Z' }),
    work('work-a', 'turn-a', 1, { receivedAt: '2026-10-11T12:01:00Z' })
  ], events: [] });
  model.restore('session-1', [{ clientTurnId: 'turn-a' }, { clientTurnId: 'turn-b' }]);
  model.review('turn-b', { adviceId: 'newer' });
  model.review('turn-a', { adviceId: 'older' });
  const [older, newer] = model.snapshot().turns;
  assert.equal(older.reviews[0].replaced, true);
  assert.equal(newer.reviews[0].replaced, false);
});

test('only an exact request reference marks advice included, never applied', () => {
  const model = createModel(); model.begin('session-1', 'turn-a', 'voice');
  model.review('turn-a', { adviceId: 'advice-a', version: 2, traceId: 'turn-a' });
  model.ingest('session-1', { items: [work('work-a', 'turn-a', 3,
    { state: 'result_ready', result: { version: 1, text: 'Synthetic correction' } })], events: [] });
  model.begin('session-1', 'turn-b', 'voice');
  model.stream('turn-b', { type: 'done', data: { adviceRefs: [
    { source: 'brain', adviceId: 'advice-a', version: 2, coverage: ['corrections'] },
    { source: 'work', workId: 'work-a', version: 1, coverage: ['result'] }
  ] } });
  const [source, target] = model.snapshot().turns;
  assert.equal(source.reviews[0].includedIn[0].targetTurnId, 'turn-b');
  assert.equal(source.works[0].includedIn[0].targetTurnId, 'turn-b');
  assert.equal(stageState('review', source)[0], 'Included');
  assert.equal(target.adviceRefs.length, 2);
  assert.equal(source.reviews[0].included, false, 'the model does not infer influence or application');
});

test('reconnect deduplicates events and ignores stale work revisions; history restores measurements', () => {
  const model = createModel();
  const first = { items: [work('work-a', 'turn-a', 3, { state: 'result_ready' })],
    events: [event(10, 'work-a', 'result_published', '2026-10-11T12:00:01Z')], cursor: 10 };
  assert.equal(model.ingest('session-1', first), true);
  assert.equal(model.ingest('session-1', first), false);
  model.ingest('session-1', { items: [work('work-a', 'turn-a', 2, { state: 'queued' })], events: first.events });
  model.restore('session-1', [{ clientTurnId: 'turn-a', channel: 'voice', replyText: 'Bonjour',
    voiceTimings: { sttDone: 650, firstAudio: 2000 }, serverTimings: { prepared: 300, executed: 1200 } }]);
  const row = model.snapshot().turns[0];
  assert.equal(row.works[0].state, 'result_ready');
  assert.equal(row.events.length, 1);
  assert.equal(stageState('tts', row)[0], 'Playback requested');
  assert.equal(row.serverTimings.executed, 1200);
  model.ingest('session-1', { items: [], events: [], snapshotRequired: true });
  assert.equal(model.snapshot().gap, true);
});

test('HTTP and stream failures settle browser activity without claiming the guardian failed', () => {
  const model = createModel();
  model.begin('session-1', 'turn-a', 'voice');
  model.stream('turn-a', { type: 'error' });
  const failed = model.snapshot().turns[0];
  assert.equal(failed.live, false);
  assert.equal(stageState('guardian', failed)[0], 'Uncertain');
  model.begin('session-1', 'turn-b', 'voice');
  model.stream('turn-b', { type: 'deferred' });
  assert.equal(model.snapshot().turns[1].live, false);
  assert.equal(stageState('guardian', model.snapshot().turns[1])[0], 'Unknown');
});

test('history order wins over receipt arrival, including an older work outside the history window', () => {
  const model = createModel();
  model.ingest('session-1', { items: [
    work('work-b', 'turn-b', 1, { receivedAt: '2026-10-11T12:02:00Z' }),
    work('work-a', 'turn-a', 1, { receivedAt: '2026-10-11T12:01:00Z' }),
    work('work-old', 'turn-old', 1, { receivedAt: '2026-10-11T12:00:00Z' })
  ], events: [] });
  model.restore('session-1', [
    { clientTurnId: 'turn-a', createdAt: '2026-10-11T12:01:03Z' },
    { clientTurnId: 'turn-b', createdAt: '2026-10-11T12:02:03Z' }
  ]);
  assert.deepEqual(model.snapshot().turns.map(row => row.id), ['turn-old', 'turn-a', 'turn-b']);
});

test('a failed work poll marks active Core observations stale until the next successful snapshot', () => {
  const model = createModel();
  model.ingest('session-1', { items: [work('work-a', 'turn-a')], events: [] });
  assert.equal(model.pollFailure('session-1'), true);
  assert.equal(model.snapshot().stale, true);
  const old = { ...model.snapshot().turns[0], telemetryStale: true };
  assert.equal(stageState('guardian', old)[0], 'Uncertain');
  assert.equal(stageState('review', old)[0], 'Uncertain');
  assert.equal(model.ingest('session-1', { items: [], events: [] }), true);
  assert.equal(model.snapshot().stale, false);
});

test('restore reconstructs only advice sources proven by exact stored inclusion refs', () => {
  const model = createModel();
  model.restore('session-1', [
    { clientTurnId: 'turn-a', traceId: 'trace-a', createdAt: '2026-10-11T12:00:00Z' },
    { clientTurnId: 'turn-b', traceId: 'trace-b', createdAt: '2026-10-11T12:01:00Z', adviceRefs: [
      { source: 'brain', adviceId: 'advice-a', version: 1, sourceTurnId: 'trace-a', coverage: ['corrections'] }
    ] }
  ]);
  const [source] = model.snapshot().turns;
  assert.equal(source.reviews[0].key, 'advice-a:1');
  assert.equal(source.reviews[0].reconstructed, true);
  assert.equal(source.reviews[0].replaced, null);
  assert.equal(source.reviews[0].includedIn[0].targetTurnId, 'turn-b');
});

test('barge-in and cancellation are distinct from completed audio', () => {
  const model = createModel(); model.begin('session-1', 'turn-a', 'voice');
  model.timings('turn-a', { firstAudio: 1500 }); model.stream('turn-a', { type: 'interrupted' });
  model.ingest('session-1', { items: [work('work-a', 'turn-a', 2,
    { state: 'cancelled', guardianStatus: 'cancelled' })], events: [event(7, 'work-a', 'owner_cancel', '2026-10-11T12:00:00Z')] });
  const row = model.snapshot().turns[0];
  assert.equal(stageState('tts', row)[0], 'Interrupted');
  assert.equal(stageState('guardian', row)[0], 'Interrupted');
  assert.equal(row.events[0].type, 'owner_cancel');
});

test('server event durations match exact work identities despite interleaving', () => {
  const observed = intervals([
    event(1, 'work-a', 'guardian_started', '2026-10-11T12:00:00Z'),
    event(2, 'work-b', 'guardian_settled', '2026-10-11T12:00:01Z'),
    event(3, 'work-a', 'guardian_settled', '2026-10-11T12:00:02Z')
  ]);
  assert.deepEqual(observed, ['Guardian active: 2.0 s (Core clock)']);
});

test('opening the map performs no command, fetch, generation or audio action', () => {
  let actions = 0;
  const previousFetch = global.fetch, previousDocument = global.document;
  global.fetch = () => { actions++; throw Error('Unexpected request'); };
  class Element {
    constructor() { this.children = []; this.dataset = {}; this.attributes = {}; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    setAttribute(key, value) { this.attributes[key] = value; }
    querySelectorAll() { return []; }
  }
  global.document = { createElement: () => new Element() };
  try {
    const host = new Element();
    const panel = create({ host });
    assert.equal(host.children.length, 2);
    assert.equal(panel.model.snapshot().turns.length, 0);
    assert.equal(actions, 0);
  } finally { global.fetch = previousFetch; global.document = previousDocument; }
});

test('the visual fork and stage connectors appear only with matching turn/work evidence', () => {
  const previousDocument = global.document;
  class Element {
    constructor() { this.children = []; this.dataset = {}; this.attributes = {}; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    setAttribute(key, value) { this.attributes[key] = value; }
    querySelectorAll() { return []; }
  }
  global.document = { createElement: () => new Element() };
  const find = (root, className) => {
    if (root.className === className) return root;
    for (const child of root.children || []) { const found = find(child, className); if (found) return found; }
    return null;
  };
  try {
    const host = new Element(), panel = create({ host });
    panel.begin('session-1', 'turn-a', 'voice');
    assert.equal(find(host, 'workflow-lanes').dataset.split, 'false');
    panel.timings('turn-a', { requestSent: 650, sttDone: 600 });
    panel.ingest('session-1', { items: [work('work-a', 'turn-a', 2, {
      attempt: { id: 'attempt-a', agentId: 'worker-a', runId: 'resp-a' }
    })], events: [
      event(1, 'work-a', 'request_received', '2026-10-11T12:00:00Z'),
      event(2, 'work-a', 'guardian_started', '2026-10-11T12:00:01Z'),
      event(3, 'work-a', 'native_started', '2026-10-11T12:00:02Z')
    ] });
    assert.equal(find(host, 'workflow-lanes').dataset.split, 'true');
    assert.equal(stageState('agents', panel.model.snapshot().turns[0])[0], 'Active');
    const flow = find(host, 'workflow-flow');
    const connected = [];
    const visit = item => {
      if (item.className === 'workflow-edge') connected.push(item.dataset.connected);
      for (const child of item.children || []) visit(child);
    };
    visit(flow);
    assert.deepEqual(connected, ['true', 'false', 'true']);
  } finally { global.document = previousDocument; }
});

test('an exact Brain advice connects its own turn to the background branch without a work', () => {
  const previousDocument = global.document;
  class Element {
    constructor() { this.children = []; this.dataset = {}; this.attributes = {}; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    setAttribute(key, value) { this.attributes[key] = value; }
    querySelectorAll() { return []; }
  }
  global.document = { createElement: () => new Element() };
  const find = (root, className) => {
    if (root.className === className) return root;
    for (const child of root.children || []) { const found = find(child, className); if (found) return found; }
    return null;
  };
  try {
    const host = new Element(), panel = create({ host });
    panel.begin('session-1', 'turn-a', 'voice');
    panel.review('turn-a', { adviceId: 'advice-a', version: 1, traceId: 'trace-a' });
    assert.equal(find(host, 'workflow-lane workflow-lane-background').dataset.connected, 'true');
    assert.equal(find(host, 'workflow-lanes').dataset.split, 'true');
    assert.equal(stageState('review', panel.model.snapshot().turns[0])[0], 'Available');
  } finally { global.document = previousDocument; }
});

test('a work revision retains keyboard focus on the selected stage or turn', () => {
  const previousDocument = global.document;
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.parent = null; }
    append(...nodes) { for (const child of nodes) { child.parent = this; this.children.push(child); } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    setAttribute(key, value) { this.attributes[key] = value; }
    querySelectorAll(selector) {
      const found = [];
      for (const child of this.children) {
        if (selector === '[data-key]' && child.dataset.key || selector === 'details[open]' && child.tag === 'details' && child.open) found.push(child);
        found.push(...child.querySelectorAll(selector));
      }
      return found;
    }
    querySelector(selector) { return this.children.find(child => child.tag === selector) || null; }
    closest(selector) { return selector === '[data-key]' ? this.dataset.key ? this : this.parent?.closest(selector) : null; }
    contains(target) { return target === this || this.children.some(child => child.contains(target)); }
    matches(selector) { return this.tag === selector; }
    focus() { global.document.activeElement = this; }
  }
  global.document = { createElement: tag => new Element(tag), activeElement: null };
  try {
    const host = new Element('section'), signal = new Element('p'), panel = create({ host, signal });
    panel.panel.open = true;
    panel.render();
    panel.begin('session-1', 'turn-a', 'voice');
    assert.match(signal.textContent, /Turn 1 · activity not attested/);
    const stage = host.querySelectorAll('[data-key]').find(item => item.dataset.key === 'stage:guardian');
    stage.querySelector('summary').focus();
    panel.ingest('session-1', { items: [work('work-a', 'turn-a')], events: [] });
    assert.match(signal.textContent, /In progress: Guardian/);
    assert.equal(global.document.activeElement,
      host.querySelectorAll('[data-key]').find(item => item.dataset.key === 'stage:guardian').querySelector('summary'));
    const turn = host.querySelectorAll('[data-key]').find(item => item.dataset.key === 'turn:turn-a');
    turn.focus();
    panel.ingest('session-1', { items: [work('work-a', 'turn-a', 2, { state: 'queued' })], events: [] });
    assert.equal(global.document.activeElement,
      host.querySelectorAll('[data-key]').find(item => item.dataset.key === 'turn:turn-a'));
    panel.begin('session-1', 'turn-b', 'voice');
    assert.match(signal.textContent, /Turn 2 · activity not attested/);
    const findTitle = root => root.className === 'workflow-map-title' ? root
      : root.children.map(findTitle).find(Boolean);
    assert.match(findTitle(host).textContent, /Turn 2/, 'a new spoken turn becomes the monitored turn');
  } finally { global.document = previousDocument; }
});

test('long conversations keep a bounded journal and retain all earlier turns and events on demand', () => {
  const previousDocument = global.document;
  class Element {
    constructor() { this.children = []; this.dataset = {}; this.attributes = {}; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(key, value) { this.attributes[key] = value; }
    querySelectorAll() { return []; }
  }
  global.document = { createElement: () => new Element(), activeElement: null };
  const all = (element, className) => [
    ...(element.className === className ? [element] : []),
    ...element.children.flatMap(child => all(child, className))
  ];
  try {
    const host = new Element(), panel = create({ host });
    for (let number = 1; number <= 300; number++) panel.model.begin('session-1', `turn-${number}`, 'text');
    panel.model.ingest('session-1', {
      items: Array.from({ length: 300 }, (_, index) => work(`work-${index + 1}`, `turn-${index + 1}`)),
      events: Array.from({ length: 300 }, (_, index) => event(index + 1, `work-${index + 1}`,
        'request_received', `2026-10-11T12:00:00.${String(index).padStart(3, '0')}Z`))
    });
    panel.render();
    assert.equal(panel.model.snapshot().turns.length, 300);
    assert.equal(panel.model.snapshot().events.length, 300);
    assert.equal(all(host, 'workflow-body')[0].children.length, 0, 'closed journal does not build hidden history');
    const head = all(host, 'workflow-map-head')[0];
    panel.follow('session-1');
    assert.equal(all(host, 'workflow-map-head')[0], head, 'same-session follow does not redraw');
    panel.panel.open = true;
    panel.render();
    assert.equal(all(host, 'workflow-turn').length, 24);
    assert.equal(all(host, 'workflow-event').length, 80);
    const control = key => all(host, 'workflow-more').find(button => button.dataset.key === key);
    for (let count = 0; count < 12; count++) {
      control('turns-older').onclick();
      assert.ok(all(host, 'workflow-turn').length <= 24);
      assert.equal(all(host, 'workflow-event').length, 80);
    }
    assert.equal(all(host, 'workflow-turn')[0].textContent, 'Turn 1', 'the first turn remains available');
    assert.equal(control('turns-older'), undefined);
    for (let count = 0; count < 3; count++) {
      control('events-older').onclick();
      assert.ok(all(host, 'workflow-event').length <= 80);
    }
    assert.equal(all(host, 'workflow-event')[0].children[2].textContent, 'Turn 1 · Work work-1',
      'the first event remains available');
    control('turns-newer').onclick();
    control('events-newer').onclick();
    assert.equal(all(host, 'workflow-turn').length, 24);
    assert.equal(all(host, 'workflow-event').length, 80);
    panel.begin('session-1', 'turn-301', 'text');
    assert.equal(all(host, 'workflow-turn').at(-1).textContent, 'Turn 301',
      'a new turn returns the journal to the live page');
    assert.equal(all(host, 'workflow-event').length, 80);
  } finally { global.document = previousDocument; }
});

test('browser projection exposes exact execution IDs without context, payloads or session keys', async () => {
  const delivery = createWorkDelivery({ repo: { async read() { throw Error('Unexpected payload read'); } } });
  const projected = await delivery.projection({ _id: 'work-a', turnId: 'turn-a', sessionId: 'session-1',
    state: 'running', revision: 3, sequence: 8, events: [], guardian: { state: 'running',
      sessionKey: 'private-guardian-key', runId: 'resp-guardian' },
    attempt: { id: 'attempt-a', agentId: 'main', runId: 'resp-worker', sessionKey: 'private-worker-key' },
    tools: [{ id: 'receipt-a', tool: 'personal_tasks', status: 'verified', runId: 'resp-worker',
      payloadRef: 'secret-payload' }], contextRef: 'secret-context', nativeAdmissions: [{ id: 'admission-a', tool: 'web_search' }] });
  assert.equal(projected.guardianRunId, 'resp-guardian');
  assert.equal(projected.attempt.agentId, 'main');
  assert.equal(projected.tools[0].id, 'receipt-a');
  assert.doesNotMatch(JSON.stringify(projected), /secret-|sessionKey|payloadRef|contextRef/);
});


test('voice tracking distinguishes frame, signal, interruption and typed playback', () => {
  const row = { channel: 'voice', works: [], reviews: [], voiceTimings: { firstFrameScheduled: 900 } };
  assert.equal(stageState('tts', row)[0], 'Frame scheduled');
  row.voiceTimings.firstSignalScheduled = 1200;
  assert.equal(stageState('tts', row)[0], 'Signal scheduled');
  row.voiceTimings.interrupted = true;
  assert.equal(stageState('tts', row)[0], 'Interrupted');
  assert.equal(stageState('tts', { channel: 'voice', interrupted: true, works: [], reviews: [] })[0], 'Interrupted');
  assert.equal(stageState('tts', { ...row, channel: 'text', voiceTimings: { firstSignalScheduled: 1200 } })[0], 'Signal scheduled');
});
