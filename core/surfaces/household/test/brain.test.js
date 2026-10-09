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
  assert.equal(brain.contextFor(SESSION.sessionId), '');
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
  const context = brain.contextFor(SESSION.sessionId);
  assert.match(context, /advisory/);
  assert.match(context, /huit pattes, pas six/);
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
  const huge = transcript([{ display: [{ kind: 'text', body: 'x'.repeat(9000) }] }]);
  assert.match(huge, /shortened for this review only; the person saw the complete text\]$/);
  const prompt = reviewerPrompt({ family: false });
  assert.match(prompt, /never claim or suggest that Nestor was cut off/);
  assert.match(prompt, /Never praise, grade or comment on Nestor's answer/);
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
