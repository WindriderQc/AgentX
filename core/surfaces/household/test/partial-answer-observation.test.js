'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentClient, sessionKeyFor } = require('../conversation-agent');

const env = { OPENCLAW_GATEWAY_URL: 'http://gateway.example.test', OPENCLAW_GATEWAY_TOKEN: 'synthetic-token' };
const session = { sessionId: '11111111-1111-4111-8111-111111111111', packId: 'personal_operator', scopeId: 'personal', agentId: 'main' };
const sessionKey = sessionKeyFor(session), runId = 'resp_22222222-2222-4222-8222-222222222222';
const row = value => Buffer.from('data: ' + JSON.stringify(value) + '\n\n');
const created = row({ type: 'response.created', response: { id: runId } });
const completed = row({ type: 'response.completed', response: { id: runId } });
const ready = text => ({ status: 'ready', source: 'openclaw/sessions.get', runId, text });
const capsule = fields => ({ ok: true, authority: 'openclaw.nestor', operation: 'turn', ...fields });
const partial = fields => capsule({
  answer: { status: 'unavailable', source: 'openclaw/sessions.get', runId },
  answerObservation: { status: 'unavailable', reason: 'read_failed', source: 'openclaw/sessions.get', runId, sessionKey },
  toolChecks: { status: 'unavailable', runId, completedTools: [], loop: null },
  ...fields
});
const first = () => capsule({ answer: ready('Réponse déjà vérifiée.'), run: { runId, sessionKey, model: 'old-attempt', provider: 'old-provider' },
  receipts: [{ runId, tool: 'personal_memory', status: 'verified', id: 'old-receipt' }] });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// A completed finite stream isolates settlement from watcher scheduling.
function settlement(continuity, options = {}) {
  let requests = 0;
  const client = createAgentClient({ env, settleMs: 400, delegateMs: 0, progressMs: 5, ...options,
    continuity, fetchImpl: async () => { requests++; return { ok: true, body: [created, completed] }; } });
  return { client, requests: () => requests };
}

// Safety completion makes a red baseline terminate without its 600s deadline.
function openStream(continuity, { grace = 40, finishAfter = 150, ...options } = {}) {
  const held = deferred();
  let requests = 0, released = false, requestSignal;
  const release = () => { released = true; held.resolve(); };
  const timer = setTimeout(release, finishAfter);
  const client = createAgentClient({ env, settleMs: 0, delegateMs: 0, progressMs: 3, streamGraceMs: grace, streamDrainMs: 100,
    ...options, continuity: request => continuity(request, released), fetchImpl: async (_url, request) => {
      requests++; requestSignal = request.signal;
      request.signal.addEventListener('abort', release, { once: true });
      return { ok: true, body: (async function* () { yield created; await held.promise; yield completed; })() };
    } });
  return { client, released: () => released, signal: () => requestSignal, requests: () => requests,
    close: () => { clearTimeout(timer); release(); } };
}

test('a partial transcript failure retains text but exposes only fresh capsules and no fallback provider', { timeout: 3000 }, async () => {
  let reads = 0;
  const fresh = { runId, sessionKey, model: 'freshly-read-old-attempt', provider: 'old-provider', status: 'completed' };
  const receipts = [{ runId, tool: 'personal_memory', status: 'verified', id: 'fresh-receipt' }];
  const progress = [{ id: 'fresh-progress', tool: 'personal_memory' }];
  const activity = [], deltas = [];
  const stream = settlement(async () => ++reads === 1 ? first() : partial({ run: fresh, receipts, progress }));
  const result = await stream.client({ session, text: 'Bonjour.', onActivity: item => activity.push(item), onDelta: text => deltas.push(text) });
  assert.equal(result.text, 'Réponse déjà vérifiée.');
  assert.deepEqual(result.tools.run, fresh);
  assert.deepEqual(result.tools.receipts, receipts);
  assert.equal(result.tools.status, 'observed');
  assert.equal(result.metadata.model, '');
  assert.equal(result.metadata.provider, '');
  assert.deepEqual(activity, [{ kind: 'tool', tool: 'personal_memory' }]);
  assert.deepEqual(deltas, [result.text]);
  assert.equal(stream.requests(), 1);
});

test('a new complete ready observation replaces retained text and restores its fresh provider', { timeout: 3000 }, async () => {
  let reads = 0;
  const stream = settlement(async () => ++reads === 1 ? first() : reads === 2 ? partial({ run: { runId, sessionKey, model: 'unconfirmed' } })
    : capsule({ answer: ready('Nouvelle réponse vérifiée.'), run: { runId, sessionKey, model: 'final-model', provider: 'final-provider' }, receipts: [] }));
  const result = await stream.client({ session, text: 'Bonjour.' });
  assert.equal(result.text, 'Nouvelle réponse vérifiée.');
  assert.equal(result.metadata.model, 'final-model');
  assert.equal(result.metadata.provider, 'final-provider');
  assert.equal(stream.requests(), 1);
});

test('old, mismatched, unknown and contradictory partial markers cannot retain a prior answer', { timeout: 10000 }, async () => {
  const changes = [
    { answerObservation: undefined },
    { answerObservation: { ...partial().answerObservation, runId: 'another-run' } },
    { answerObservation: { ...partial().answerObservation, sessionKey: 'another-session' } },
    { answerObservation: { ...partial().answerObservation, source: 'another-source' } },
    { answerObservation: { ...partial().answerObservation, reason: 'future-reason' } },
    { answerObservation: { ...partial().answerObservation, status: 'observed' } },
    { authority: 'another-authority' },
    { operation: 'agents' },
    { ok: false },
    { answer: { ...partial().answer, runId: 'another-run' } },
    { answer: { ...partial().answer, status: 'yielded' } },
    { answer: { ...partial().answer, source: 'another-source' } },
    { answer: { ...partial().answer, text: 'unproven text' } },
    { run: { runId: 'another-run', sessionKey } },
    { run: { runId, sessionKey: 'another-session' } },
    { run: false },
    { run: 0 },
    { run: '' },
    { answer: ready('Contradictory purported answer.') },
    { answer: { ...ready('Unused'), text: 42 } },
    { answer: null }
  ];
  for (const change of changes) {
    let reads = 0;
    const deltas = [];
    const stream = settlement(async () => ++reads === 1 ? first() : partial(change), { settleMs: 150 });
    await assert.rejects(stream.client({ session, text: 'Bonjour.', onDelta: text => deltas.push(text) }));
    assert.deepEqual(deltas, [], JSON.stringify(change));
    assert.equal(stream.requests(), 1);
  }
});

test('a real non-final observation invalidates text before a later qualified partial failure', { timeout: 3000 }, async () => {
  for (const answer of [{ status: 'yielded', runId }, { status: 'unavailable', runId }, null]) {
    let reads = 0;
    const stream = settlement(async () => ++reads === 1 ? first() : reads === 2 ? capsule({ answer }) : partial());
    const deltas = [];
    await assert.rejects(stream.client({ session, text: 'Bonjour.', onDelta: text => deltas.push(text) }));
    assert.deepEqual(deltas, []);
    assert.equal(stream.requests(), 1);
  }
});

test('qualified partial watcher failures preserve the original ready grace without waiting for safety completion', { timeout: 3000 }, async () => {
  let reads = 0, settled = 0;
  const stream = openStream(async (_request, released) => released ? capsule({ answer: ready('Réponse de secours.'), run: { runId, sessionKey } })
    : ++reads === 1 ? first() : partial({ run: { runId, sessionKey }, receipts: [] }));
  try {
    const result = await stream.client({ session, text: 'Bonjour.', onSettled: () => settled++ });
    assert.equal(result.text, 'Réponse déjà vérifiée.');
    assert.equal(stream.released(), false, 'partial reads neither withdraw nor restart the existing grace');
    assert.ok(result.metadata.phases.streamOverdue !== undefined);
    assert.equal(settled, 1);
    assert.equal(stream.requests(), 1);
  } finally { stream.close(); }
});

test('partial failures without an observed ready never arm their own grace', { timeout: 3000 }, async () => {
  let settled = 0;
  const stream = openStream(async (_request, released) => released ? capsule({ answer: ready('Vraie fin.'), run: { runId, sessionKey } }) : partial());
  let outcome;
  const turn = stream.client({ session, text: 'Bonjour.', onSettled: () => settled++ }).then(result => { outcome = result; });
  try {
    await wait(80);
    assert.equal(outcome, undefined);
    assert.equal(stream.signal().aborted, false);
    assert.equal(settled, 0);
    await turn;
    assert.equal(outcome.text, 'Vraie fin.');
    assert.equal(outcome.metadata.phases.streamOverdue, undefined);
    assert.equal(stream.requests(), 1);
  } finally { stream.close(); await turn; }
});

test('retained task prose still needs actual same-run proof from the fresh capsule', { timeout: 4000 }, async () => {
  for (const verified of [false, true]) {
    let reads = 0;
    const receipts = verified ? [{ runId, tool: 'list_personal_tasks', status: 'verified', observed: true }] : [];
    const stream = settlement(async () => ++reads === 1 ? capsule({ answer: ready('Trois tâches.'), receipts: [] })
      : partial({ run: { runId, sessionKey, model: 'unconfirmed' }, receipts }));
    const result = await stream.client({ session, text: 'Regarde mes tâches.' });
    assert.equal(result.text.includes('Trois tâches.'), verified);
    if (!verified) assert.equal(result.tools.verification.reason, 'task_check_missing');
    assert.deepEqual(result.tools.receipts, receipts);
    assert.equal(result.metadata.model, '');
    assert.equal(stream.requests(), 1);
  }
});

test('fresh image receipts and later image recovery take priority over cached denial prose', { timeout: 4000 }, async () => {
  const id = '33333333-3333-4333-8333-333333333333', actionKey = 'a'.repeat(64);
  const receipt = { runId, sessionKey, tool: 'local_image', observed: true, status: 'unknown',
    provenance: { origin: 'owner_turn' }, imageOperation: { id, actionKey } };
  const operation = { id, state: 'accepted', studioPath: `/images?operation=${id}`, runtimeRestored: false };
  for (const recover of [false, true]) {
    let reads = 0, imageReads = 0;
    const stream = settlement(async () => {
      reads++;
      if (reads === 1) return capsule({ answer: ready('The image was cancelled.') });
      if (recover && reads === 2) return partial({ progress: [{ id: 'image-call', tool: 'local_image' }] });
      if (recover && reads === 3) throw new Error('Synthetic whole-capsule failure');
      return partial({ run: { runId, sessionKey }, receipts: [receipt] });
    }, { settleMs: 400, readImageOperation: async (actualId, actualKey) => {
      imageReads++; assert.equal(actualId, id); assert.equal(actualKey, actionKey); return operation;
    } });
    const result = await stream.client({ session, text: 'Une image synthétique.' });
    assert.match(result.text, /demande image est acceptée/);
    assert.ok(!result.text.includes('cancelled'));
    assert.equal(result.tools.imageDelivery.operations[0].id, id);
    assert.equal(result.metadata.provider, 'agentx.core.images');
    assert.equal(imageReads, 1);
    assert.equal(stream.requests(), 1);
  }
});

test('caller cancellation and native SSE failure outrank a qualified partial fallback', { timeout: 4000 }, async () => {
  const abort = new AbortController();
  let reads = 0;
  const deltas = [];
  const stopped = settlement(async () => {
    if (++reads === 1) return first();
    abort.abort(new Error('Caller stopped')); return partial();
  });
  await assert.rejects(stopped.client({ session, text: 'Bonjour.', signal: abort.signal, onDelta: text => deltas.push(text) }), /Caller stopped/);
  assert.deepEqual(deltas, []);
  assert.equal(stopped.requests(), 1);

  const observed = deferred(); let requests = 0, failureReads = 0;
  const failed = createAgentClient({ env, settleMs: 0, progressMs: 3, streamGraceMs: 100,
    continuity: async () => { if (++failureReads === 1) return first(); observed.resolve(); return partial(); },
    fetchImpl: async () => { requests++; return { ok: true, body: (async function* () {
      yield created; await observed.promise;
      yield row({ type: 'response.failed', response: { id: runId, error: { message: 'Synthetic native error' } } });
    })() }; } });
  await assert.rejects(failed({ session, text: 'Bonjour.', onDelta: text => deltas.push(text) }), /pas pu finir sa réponse/);
  assert.deepEqual(deltas, []);
  assert.equal(requests, 1);
});

test('GraphysX dialogue cannot deliver retained projection prose after a partial final read', { timeout: 3000 }, async () => {
  let reads = 0;
  const deltas = [];
  const stream = settlement(async () => ++reads === 1 ? first() : partial({ run: { runId, sessionKey } }));
  await assert.rejects(stream.client({ session, text: 'Bonjour.', browserReply: { context: {} }, onDelta: text => deltas.push(text) }), /pas donné de réponse finale/);
  assert.deepEqual(deltas, []);
  assert.equal(stream.requests(), 1);
});
