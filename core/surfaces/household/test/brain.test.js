'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrain, readReview, reviewerPrompt, transcript } = require('../brain');

const SESSION = { sessionId: 'session-1', packId: 'personal_operator', scopeId: 'personal' };
const TURNS = [{ inputText: 'Combien de pattes a une araignée?', replyText: 'Six pattes.', display: [
  { kind: 'list', title: 'Insectes', body: '- fourmi' }, { kind: 'secret', title: 'Clé', body: '' }, { kind: 'image', body: 'araignée' }] }];

function inferenceReturning(content, calls = []) {
  return { execute: async (body, options) => {
    calls.push({ body, options });
    if (options.signal?.aborted) return { ok: false };
    return { ok: true, body: { message: { content } }, metadata: { model: 'synthetic-brain' } };
  } };
}

const REVIEW = JSON.stringify({ suggestions: ['Et un insecte?', '', 42], corrections: ['Une araignée a huit pattes, pas six.'],
  revisions: [{ title: 'Pattes', body: 'Araignée : 8 pattes' }], interjection: { text: 'Petite correction : huit pattes!', urgent: false } });

test('only a bounded review in the expected shape is kept', () => {
  assert.deepEqual(readReview('Voici: ' + REVIEW + ' fin'), {
    suggestions: ['Et un insecte?'], corrections: ['Une araignée a huit pattes, pas six.'],
    revisions: [{ title: 'Pattes', body: 'Araignée : 8 pattes' }], interjection: { text: 'Petite correction : huit pattes!', urgent: false } });
  assert.equal(readReview('not json'), null);
  assert.deepEqual(readReview({ suggestions: 'x', interjection: 'Attention au four!' }).interjection, { text: 'Attention au four!', urgent: false });
  assert.equal(readReview({ suggestions: Array(9).fill('q') }).suggestions.length, 3);
});

test('the reviewer sees spoken and shown text, never secrets or image queries', () => {
  const shown = transcript(TURNS);
  assert.match(shown, /Nestor \(spoken\): Six pattes\./);
  assert.match(shown, /on screen, Insectes\): - fourmi/);
  assert.doesNotMatch(shown, /Clé|araignée$/m);
  assert.match(reviewerPrompt({ family: true }), /child safety/);
  assert.doesNotMatch(reviewerPrompt({ family: false }), /child safety/);
});

test('a scheduled review is delivered to a waiting page and informs the next turn', async () => {
  const calls = [];
  const brain = createBrain({ inference: inferenceReturning(REVIEW, calls), loadTurns: async () => TURNS, delayMs: 0,
    env: { HOUSEHOLD_BRAIN_ENABLED: 'true', HOUSEHOLD_BRAIN_MODEL: 'ollama/synthetic:32b', HOUSEHOLD_BRAIN_HOST_URL: 'http://gpu.example.test:11434' } });
  assert.equal((await brain.contextFor(SESSION.sessionId)), '');
  assert.equal(brain.schedule({ session: SESSION, pack: { childSafe: false }, traceId: 'trace-1' }), true);
  const review = await brain.wait(SESSION.sessionId, 'trace-1');
  assert.equal(review.traceId, 'trace-1');
  assert.deepEqual(review.suggestions, ['Et un insecte?']);
  assert.equal(calls[0].body.taskType, 'master_brain');
  assert.equal(calls[0].body.model, 'synthetic:32b');
  assert.equal(calls[0].body.exclusiveHost, undefined, 'exclusive admission is opt-in');
  assert.equal(calls[0].options.hostUrl, 'http://gpu.example.test:11434');
  assert.equal(calls[0].options.signal, undefined, 'a dedicated host request is never cancelled');
  assert.equal(calls[0].body.think, false);
  const context = (await brain.contextFor(SESSION.sessionId));
  assert.match(context, /advisory/);
  assert.match(context, /huit pattes, pas six/);
  assert.match(review.adviceId, /^[a-f0-9-]{36}$/);
  assert.deepEqual((await brain.contextWithRefs(SESSION.sessionId)), { text: context, refs: [{ source: 'brain',
    adviceId: review.adviceId, version: 1, sourceTurnId: 'trace-1', coverage: ['corrections', 'interjection'] }] });
  assert.equal(await brain.wait(SESSION.sessionId, 'another-trace', { timeoutMs: 10 }), null, 'a review of another turn is not delivered');
});

test('a new turn cancels the running review, and the brain is off unless enabled', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const inference = { execute: async (body, options) => { calls.push(options.signal); await gate; return { ok: true, body: { response: REVIEW } }; } };
  const brain = createBrain({ inference, loadTurns: async () => TURNS, delayMs: 0, env: { HOUSEHOLD_BRAIN_ENABLED: 'true' } });
  brain.schedule({ session: SESSION, pack: {}, traceId: 'trace-1' });
  while (!calls.length) await new Promise(resolve => setTimeout(resolve, 1));
  const waiting = brain.wait(SESSION.sessionId, 'trace-1', { timeoutMs: 50 });
  brain.cancel(SESSION.sessionId);
  assert.equal(calls[0].aborted, true);
  release();
  assert.equal(await waiting, null);
  assert.equal(brain.latest(SESSION.sessionId), null, 'a cancelled review is never delivered');

  const off = createBrain({ inference, loadTurns: async () => TURNS, env: {} });
  assert.equal(off.schedule({ session: SESSION, pack: {}, traceId: 't' }), false);
  const familyOff = createBrain({ inference, loadTurns: async () => TURNS, env: { HOUSEHOLD_BRAIN_ENABLED: 'true', HOUSEHOLD_BRAIN_FAMILY: 'false' } });
  assert.equal(familyOff.schedule({ session: SESSION, pack: { childSafe: true }, traceId: 't' }), false);
  assert.equal(familyOff.enabled(false), true);
});

test('on a dedicated host a newer turn discards the running review without cancelling its request', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const inference = { execute: async (body, options) => { calls.push({ body, options }); await gate; return { ok: true, body: { response: REVIEW } }; } };
  const env = { HOUSEHOLD_BRAIN_ENABLED: 'true', HOUSEHOLD_BRAIN_HOST_URL: 'http://gpu.example.test:11434' };
  const brain = createBrain({ inference, loadTurns: async () => TURNS, delayMs: 0, env });
  brain.schedule({ session: SESSION, pack: {}, traceId: 'trace-1' });
  while (!calls.length) await new Promise(resolve => setTimeout(resolve, 1));
  brain.cancel(SESSION.sessionId);
  assert.equal(calls[0].options.signal, undefined);
  release(); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(brain.latest(SESSION.sessionId), null, 'a superseded review is never delivered');
  const exclusive = createBrain({ inference: inferenceReturning(REVIEW, calls), loadTurns: async () => TURNS, delayMs: 0,
    env: { ...env, HOUSEHOLD_BRAIN_EXCLUSIVE: 'true' } });
  exclusive.schedule({ session: SESSION, pack: {}, traceId: 'trace-2' });
  await exclusive.wait(SESSION.sessionId, 'trace-2');
  assert.equal(calls.at(-1).body.exclusiveHost, true);
});

test('the route serves a review only within its own space', async () => {
  const routes = {};
  const router = { get: (path, handler) => { routes[path] = handler; } };
  const brain = createBrain({ inference: inferenceReturning(REVIEW), loadTurns: async () => TURNS, delayMs: 0, env: { HOUSEHOLD_BRAIN_ENABLED: 'true' },
    conversations: { getSession: async ({ sessionId }) => (sessionId === SESSION.sessionId ? SESSION : null) } });
  brain.register(router);
  brain.schedule({ session: SESSION, pack: {}, traceId: 'trace-1' });
  const call = async (path, sessionId) => {
    let status = 200, body;
    const res = { writableEnded: false, destroyed: false, on() {}, status(code) { status = code; return this; }, json(value) { body = value; return this; } };
    await routes[path]({ params: { sessionId }, query: { after: 'trace-1' } }, res);
    return { status, body };
  };
  const found = await call('/private/sessions/:sessionId/brain', SESSION.sessionId);
  assert.equal(found.status, 200);
  assert.deepEqual(found.body.data.review.corrections, ['Une araignée a huit pattes, pas six.']);
  assert.equal((await call('/family/sessions/:sessionId/brain', SESSION.sessionId)).status, 404, 'a private conversation is not readable from Famille');
  assert.equal((await call('/private/sessions/:sessionId/brain', 'unknown')).status, 404);
});

test('routed review delegates primary/fallback choice to Core and discards superseded admitted work', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; }), calls = [];
  const routing = { degraded: true, reason: 'primary_busy', fallbackFrom: { model: 'gpu-review' }, fallbackTo: { model: 'cpu-review' } };
  const brain = createBrain({ loadTurns: async () => TURNS, delayMs: 0,
    env: { HOUSEHOLD_BRAIN_ENABLED: 'true', HOUSEHOLD_BRAIN_TASK: 'household_review',
      HOUSEHOLD_BRAIN_MODEL: 'old-direct-model', HOUSEHOLD_BRAIN_HOST_URL: 'http://old.example.test:11434', HOUSEHOLD_BRAIN_EXCLUSIVE: 'true' },
    inference: { execute: async (body, options) => {
      calls.push({ body, options }); await gate;
      return { ok: true, body: { response: REVIEW }, metadata: { model: 'cpu-review', routing } };
    } } });
  brain.schedule({ session: SESSION, pack: {}, traceId: 'old' });
  while (!calls.length) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(calls[0].body.taskType, 'household_review');
  assert.equal(calls[0].body.model, undefined, 'explicit model would bypass the fallback ladder');
  assert.equal(calls[0].options.hostUrl, undefined, 'explicit host would bypass the fallback ladder');
  assert.equal(calls[0].body.exclusiveHost, undefined, 'reviews never evict the main model');
  assert.equal(calls[0].options.signal, undefined, 'a new spoken turn must not quarantine the reasoning endpoints');
  brain.cancel(SESSION.sessionId); release();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(brain.latest(SESSION.sessionId), null);
  brain.schedule({ session: SESSION, pack: {}, traceId: 'new' });
  const result = await brain.wait(SESSION.sessionId, 'new');
  assert.equal(result.model, 'cpu-review');
  assert.deepEqual(result.routing, routing, 'the review records the actual fallback used');
});

test('a long shown list reaches the reviewer marked as shortened, never silently cut', () => {
  const steps = Array.from({ length: 10 }, (_, index) => `${index + 1}. **Étape ${index + 1}** : ${'détail '.repeat(40)}`).join('\n');
  const shown = transcript([{ inputText: 'Donne-moi 10 étapes', replyText: 'Voici 10 étapes.', display: [{ kind: 'list', body: steps }] }]);
  assert.match(shown, /10\. \*\*Étape 10\*\*/, 'a ten-step list of this size is reviewed whole');
  const huge = transcript([{ display: [{ kind: 'text', body: 'x'.repeat(9000) }] }], { complete: false });
  assert.match(huge, /shortened for this review only; the person saw the complete text\]$/);
  const prompt = reviewerPrompt({ family: false });
  assert.match(prompt, /never claim or suggest that Nestor was cut off/);
  assert.match(prompt, /Never praise, grade or comment on Nestor's answer/);
});

test('personal review keeps the entire conversation, long text and tool evidence in canonical order', async () => {
  const turns = Array.from({ length: 18 }, (_, index) => ({ traceId: `turn-${index}`, inputText: `Question ${index}`, replyText: `Reply ${index}` }));
  turns[0].inputText = 'Earlier restriction: ' + 'x'.repeat(3000) + ' KEEP_THE_LAST_DETAIL';
  turns[0].replyText = 'y'.repeat(3500) + ' EARLIER_CORRECTION';
  turns[0].display = [{ kind: 'text', body: 'z'.repeat(9000) + ' COMPLETE_SHOWN_TEXT' }];
  turns[0].toolEvidence = { status: 'observed', receipts: [{ tool: 'synthetic_read', result: 'VERIFIED_SOURCE' }] };
  turns[0].workResults = [{ text: 'Prior boss correction: ' + 'w'.repeat(3000) + ' LAST_BOSS_DETAIL', presentation: { state: 'displayed' } }];
  const calls = [];
  const brain = createBrain({ inference: inferenceReturning(REVIEW, calls), loadTurns: async () => turns, delayMs: 0,
    env: { HOUSEHOLD_BRAIN_ENABLED: 'true' } });
  brain.schedule({ session: SESSION, pack: {}, traceId: 'turn-17' });
  const review = await brain.wait(SESSION.sessionId, 'turn-17');
  const context = calls[0].body.messages[1].content;
  for (const turn of turns) {
    assert.ok(context.includes(turn.inputText)); assert.ok(context.includes(turn.replyText));
  }
  assert.ok(context.includes(turns[0].display[0].body)); assert.match(context, /VERIFIED_SOURCE/);
  assert.ok(context.includes(turns[0].workResults[0].text)); assert.match(context, /"state":"displayed"/);
  assert.doesNotMatch(context, /shortened for this review/);
  assert.ok(context.indexOf('Question 1\n') < context.indexOf('Question 17\n'));
  assert.deepEqual(review.conversationCoverage, { complete: true, turnCount: 18, firstTurnId: 'turn-0', lastTurnId: 'turn-17' });
});

test('an oversized complete review refuses before inference and discloses the missing review', async () => {
  const calls = [];
  const brain = createBrain({ inference: inferenceReturning(REVIEW, calls), loadTurns: async () => [{ inputText: 'x'.repeat(100000) }],
    delayMs: 0, env: { HOUSEHOLD_BRAIN_ENABLED: 'true' } });
  brain.schedule({ session: SESSION, pack: {}, traceId: 'oversized' });
  const refusal = await brain.wait(SESSION.sessionId, 'oversized');
  assert.equal(refusal.status, 'context_required'); assert.equal(calls.length, 0);
  assert.equal((await brain.contextFor(SESSION.sessionId)), '', 'a refused review cannot become advice');
});

test('a refused later review preserves the last completed feedback and identifies its older coverage', async () => {
  let turns = TURNS;
  const brain = createBrain({ inference: inferenceReturning(REVIEW), loadTurns: async () => turns, delayMs: 0,
    env: { HOUSEHOLD_BRAIN_ENABLED: 'true' } });
  brain.schedule({ session: SESSION, pack: {}, traceId: 'completed' });
  const completed = await brain.wait(SESSION.sessionId, 'completed');
  turns = [{ inputText: 'x'.repeat(100000) }];
  brain.schedule({ session: SESSION, pack: {}, traceId: 'refused' });
  assert.equal((await brain.wait(SESSION.sessionId, 'refused')).status, 'context_required');
  const context = (await brain.contextWithRefs(SESSION.sessionId));
  assert.match(context.text, /huit pattes/); assert.match(context.text, /does not validate newer turns/);
  assert.equal(context.refs[0].adviceId, completed.adviceId);
  assert.equal(context.refs[0].sourceTurnId, 'completed');
});

test('live preferences enable the optional brain, block disabled work, and discard admitted results without cancellation', async () => {
  let prefs = { revision: 1, values: { backgroundReview: false, reviewDelaySeconds: 0 } }, release, start;
  const calls = [], started = new Promise(resolve => { start = resolve; });
  const brain = createBrain({ env: {}, preferencesFor: async () => structuredClone(prefs), loadTurns: async () => TURNS,
    inference: { execute: async (_body, options) => { calls.push(options.signal); start(); await new Promise(resolve => { release = resolve; }); return { ok: true, body: { response: REVIEW } }; } } });
  brain.schedule({ session: SESSION, pack: {}, traceId: 'disabled' });
  assert.equal(await brain.wait(SESSION.sessionId, 'disabled', { timeoutMs: 30 }), null); assert.equal(calls.length, 0);
  prefs = { revision: 2, values: { backgroundReview: true, reviewDelaySeconds: 0 } };
  brain.schedule({ session: SESSION, pack: {}, traceId: 'running' }); await started;
  const wait = brain.wait(SESSION.sessionId, 'running');
  prefs = { revision: 3, values: { backgroundReview: false, reviewDelaySeconds: 0 } }; brain.reconfigure(false);
  assert.equal(calls[0].aborted, false, 'settings do not abort admitted runtime work'); release();
  assert.equal(await wait, null); await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(brain.latest(SESSION.sessionId), null);
});

// A synthetic stand-in for Core's conversation service: conditional session writes by turn count.
function storeFor(session, { failWrites = false } = {}) {
  const row = { ...session, turnCount: 1 }, writes = [];
  return { row, writes, getSession: async ({ sessionId }) => (sessionId === row.sessionId ? structuredClone(row) : null),
    updateSession: async (query, update) => {
      if (failWrites) throw Object.assign(new Error('synthetic storage outage'), { code: 'SYNTHETIC' });
      if (query.sessionId !== row.sessionId || query.packId !== row.packId || query.scopeId !== row.scopeId || query.turnCount !== row.turnCount) return null;
      writes.push(update);
      row.backgroundReview = { ...row.backgroundReview };
      for (const [path, value] of Object.entries(update.$set || {})) row.backgroundReview[path.split('.')[1]] = value;
      for (const path of Object.keys(update.$unset || {})) delete row.backgroundReview[path.split('.')[1]];
      return structuredClone(row);
    } };
}
const LIVE = { revision: 4, values: { backgroundReview: true, reviewDelaySeconds: 0 } };

test('a cancelled review writes nothing, and only the newest of two rapid turns is stored', async () => {
  const conversations = storeFor(SESSION), gates = [], calls = [];
  const brain = createBrain({ conversations, env: {}, preferencesFor: async () => structuredClone(LIVE), loadTurns: async () => TURNS,
    inference: { execute: async (body, options) => { calls.push(options.signal); await new Promise(resolve => gates.push(resolve));
      return { ok: true, body: { response: REVIEW } }; } } });
  brain.schedule({ session: SESSION, pack: {}, traceId: 'first' });
  while (!gates.length) await new Promise(resolve => setTimeout(resolve, 1));
  const firstWait = brain.wait(SESSION.sessionId, 'first');
  brain.schedule({ session: SESSION, pack: {}, traceId: 'second' });
  assert.equal(calls[0].aborted, true, 'the newer turn cancels the shared-host request');
  while (gates.length < 2) await new Promise(resolve => setTimeout(resolve, 1));
  gates[0](); gates[1]();
  const second = await brain.wait(SESSION.sessionId, 'second');
  assert.equal(await firstWait, null, 'a waiter for the superseded turn never receives the newer review');
  assert.equal(second.traceId, 'second');
  assert.equal(conversations.writes.length, 1);
  assert.equal(conversations.row.backgroundReview.review.traceId, 'second');
});

test('a private deeper review thinks and writes more only when configured; Famille stays standard', async () => {
  const calls = [];
  let prefs = { revision: 1, values: { backgroundReview: true, deepReview: true, reviewDelaySeconds: 0 } };
  const brain = createBrain({ inference: inferenceReturning(REVIEW, calls), env: {}, preferencesFor: async () => structuredClone(prefs), loadTurns: async () => TURNS });
  brain.schedule({ session: SESSION, pack: {}, traceId: 'deep' });
  assert.equal((await brain.wait(SESSION.sessionId, 'deep')).depth, 'deep');
  assert.equal(calls[0].body.think, true); assert.equal(calls[0].body.max_tokens, 4000); assert.equal(calls[0].body.timeoutMs, 300000);
  assert.match(calls[0].body.messages[0].content, /deeper review/); assert.match(calls[0].body.callerDetail, /private\/deep$/);
  brain.schedule({ session: { ...SESSION, sessionId: 'family-1' }, pack: { childSafe: true }, traceId: 'child' });
  assert.equal((await brain.wait('family-1', 'child')).depth, 'standard');
  assert.equal(calls[1].body.think, false); assert.equal(calls[1].body.max_tokens, 700);
  assert.doesNotMatch(calls[1].body.messages[0].content, /deeper review/);
  prefs = { revision: 2, values: { backgroundReview: true, deepReview: false, reviewDelaySeconds: 0 } };
  brain.schedule({ session: SESSION, pack: {}, traceId: 'standard' });
  await brain.wait(SESSION.sessionId, 'standard');
  assert.equal(calls[2].body.think, false);
});

test('a storage outage keeps the advisory result in this process and says so', async () => {
  const warnings = [];
  const brain = createBrain({ conversations: storeFor(SESSION, { failWrites: true }), env: {}, preferencesFor: async () => structuredClone(LIVE),
    loadTurns: async () => TURNS, inference: inferenceReturning(REVIEW), logger: { warn: (message, data) => warnings.push({ message, data }) } });
  brain.schedule({ session: SESSION, pack: {}, traceId: 'trace-1' });
  assert.equal((await brain.wait(SESSION.sessionId, 'trace-1')).traceId, 'trace-1');
  assert.deepEqual(warnings, [{ message: 'Household brain review was not stored', data: { error: 'synthetic storage outage', code: 'SYNTHETIC' } }]);
});

test('the stored record holds only the bounded review shape', async () => {
  const conversations = storeFor(SESSION);
  const oversized = JSON.stringify({ suggestions: Array(20).fill('q'.repeat(900)), corrections: Array(20).fill('c'.repeat(900)),
    revisions: Array(20).fill({ title: 't'.repeat(900), body: 'b'.repeat(90000) }), interjection: { text: 'i'.repeat(9000), urgent: 'yes' }, extra: 'x'.repeat(9000) });
  const brain = createBrain({ conversations, env: {}, preferencesFor: async () => structuredClone(LIVE), loadTurns: async () => TURNS, inference: inferenceReturning(oversized) });
  brain.schedule({ session: SESSION, pack: {}, traceId: 'trace-1' });
  await brain.wait(SESSION.sessionId, 'trace-1');
  const stored = conversations.row.backgroundReview.review;
  assert.equal(stored.extra, undefined);
  assert.equal(stored.suggestions.length, 3); assert.equal(stored.corrections.length, 3); assert.equal(stored.revisions.length, 2);
  assert.ok(stored.revisions.every(item => item.body.length <= 2000 && item.title.length <= 80));
  assert.equal(stored.interjection.text.length, 220); assert.equal(stored.interjection.urgent, false);
  assert.ok(JSON.stringify(conversations.row.backgroundReview).length < 12000);
});
