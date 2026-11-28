'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFamilyKitchenTimer } = require('../../../src/services/familyKitchenTimer');
const { familyToolset } = require('../family-tools');
const { forTurn: guardTools } = require('../guardian-read-tools');
const { memoryMongoose } = require('./fixtures/kitchen-timer-memory.cjs');
const { harness } = require('./fixtures/persona-journey.cjs');
const { call, timerModel, name } = require('./fixtures/kitchen-timer-model.cjs');
const packId = 'kidx_nestor';
const makeTimer = now => createFamilyKitchenTimer({ mongoose: memoryMongoose(), now });

test('Core preserves the original deadline, extends once and claims a single alert', async () => {
  let now = 1_000_000;
  const timer = makeTimer(() => now);
  const perform = (action, seconds, requestId) => timer.perform({ action, seconds }, { requestId });
  const started = await perform('start', 120, 'first');
  assert.equal(started.timer.endsAt, 1_120_000);
  now += 15_000;
  assert.equal((await perform('start', 10, 'second')).timer.id, started.timer.id);
  assert.match((await perform('status')).text, /1 minute et 45 secondes/);
  const extend = () => perform('extend', 30, 'extend-one');
  const results = await Promise.all([extend(), extend()]);
  assert.equal(results.filter(result => result.outcome === 'extended').length, 1);
  const active = await timer.read();
  assert.equal(active.id, started.timer.id);
  assert.equal(active.endsAt, 1_150_000);
  now = started.timer.endsAt;
  assert.deepEqual(await timer.claimAlert(active.id), { claimed: false });
  now = active.endsAt;
  const claims = await Promise.all([timer.claimAlert(active.id), timer.claimAlert(active.id)]);
  assert.equal(claims.filter(row => row.claimed).length, 1);
  assert.equal((await perform('start', 120, 'first')).timer.id, active.id);
  const replacement = await perform('start', 15, 'new-start');
  assert.notEqual(replacement.timer.id, active.id);
  assert.equal((await perform('cancel', undefined, 'cancel')).outcome, 'cancelled');
  assert.equal((await timer.read()).state, 'idle');
});

test('old applied and no-op requests cannot alter a replacement timer', async () => {
  let time = 3_000_000;
  const timer = makeTimer(() => time);
  const run = (action, requestId, seconds) => timer.perform({ action, seconds }, { requestId });
  await run('cancel', 'cancel-while-empty');
  const a = await run('start', 'create-a', 60);
  await run('extend', 'extend-a', 30);
  await run('cancel', 'cancel-a');
  const b = await run('start', 'create-b', 120);
  for (const [action, id, seconds] of [['extend', 'extend-a', 30], ['cancel', 'cancel-a'], ['cancel', 'cancel-while-empty']]) {
    assert.equal((await run(action, id, seconds)).outcome, 'unchanged');
    assert.deepEqual(await timer.read(), b.timer);
  }
  time = b.timer.endsAt;
  assert.equal((await run('start', 'create-a', 60)).outcome, 'unchanged');
  assert.equal((await timer.read()).id, b.timer.id);
  assert.equal((await timer.read()).state, 'finished');
  assert.equal(a.timer.id === b.timer.id, false);
});

test('Famille inference chooses the operation from the current dialogue, in text or voice', async () => {
  let now = 1_000_000;
  const kitchenTimer = makeTimer(() => now);
  const family = harness({ packId, backend: 'agentx', kitchenTimer, response: timerModel });
  const say = (text, channel = 'voice') => family.turn(text, channel);
  const started = await say('Voudrais-tu mettre le chrono, à peu près le temps de se brosser les dents, deux minutes?');
  assert.match(started.reply.text, /2 minutes/);
  assert.equal(started.tools.receipts[0].outcome, 'started');
  assert.ok(family.sent[0].tools.some(row => row.function.name === name));
  now += 15_000;
  const statusQuestion = 'Combien il reste?';
  const statusCall = family.sent.length;
  assert.match((await say(statusQuestion)).reply.text, /1 minute et 45 secondes/);
  assert.match(family.sent[statusCall].request, /immediately preceding exchange used the kitchen timer/);
  const beforeExtend = (await kitchenTimer.read()).endsAt;
  assert.equal((await say('Donne-nous encore deux minutes')).tools.receipts[0].outcome, 'extended');
  assert.equal((await kitchenTimer.read()).endsAt, beforeExtend + 120_000);
  await say('Parlons de la Station spatiale.');
  const unrelatedCall = family.sent.length;
  const unrelated = await say(statusQuestion);
  assert.match(family.sent[unrelatedCall].request, /immediately preceding exchange did not use the kitchen timer/);
  assert.match(unrelated.reply.text, /ISS/);
  assert.deepEqual(unrelated.tools.receipts, []);
  assert.equal((await kitchenTimer.read()).endsAt, beforeExtend + 120_000);
  const cancelled = await say('Annule la minuterie', 'text');
  assert.match(cancelled.reply.text, /annulée/);
  assert.equal(cancelled.tools.receipts[0].outcome, 'cancelled');
  await say('Il a dit « Mets deux minutes » sans rien lancer.');
  assert.equal((await kitchenTimer.read()).state, 'idle');
});

test('timer is not a general or Gardien action and malformed or duplicate writes do not execute', async () => {
  const kitchenTimer = makeTimer(() => 1_000_000);
  const env = { HOUSEHOLD_FAMILY_TOOLS: name };
  assert.equal(familyToolset(env), null);
  assert.ok(!guardTools(env, { backend: 'agentx', packId })?.names.includes(name));
  const signal = new AbortController().signal, events = [];
  const tools = familyToolset(env, { onTimer: timer => events.push(timer), toolDeps: {
    kitchenTimer: { service: kitchenTimer, requestId: 'start-turn', language: 'fr', signal } } });
  const send = (action, seconds) => tools.execute(call(action, seconds).message.tool_calls[0]);
  assert.equal((await send('start', -1)).receipt.status, 'failed');
  assert.equal((await kitchenTimer.read()).state, 'idle');
  assert.equal((await send('start', 60)).receipt.outcome, 'started');
  await send('start', 120);
  assert.equal((await kitchenTimer.read()).endsAt, 1_060_000);
  assert.equal(events.length, 1);
});

test('unsupported model tools and occupied principal do not mutate Core', async () => {
  const kitchenTimer = makeTimer(() => 1_000_000);
  const failed = harness({ packId, backend: 'agentx', kitchenTimer,
    response: body => body.tools ? { ok: false, body: { error: 'does not support tools' }, status: 400 } : timerModel(body) });
  const reply = await failed.turn('Mets deux minutes', 'voice');
  assert.match(reply.reply.text, /ne peux pas vérifier/);
  assert.equal(reply.tools.status, 'not_supported');
  assert.equal((await kitchenTimer.read()).state, 'idle');
  const busy = harness({ packId, backend: 'agentx', kitchenTimer,
    conversationEnv: { HOUSEHOLD_CONVERSATION_RELAY_ENABLED: 'true' },
    continuityExecute: async () => ({ ok: true, body: { response: 'Nestor est occupé. Je ne peux pas lancer la minuterie.' },
      metadata: { model: 'agentx-status', conversationContinuity: { state: 'status_only' } } }) });
  const unavailable = await busy.turn('Mets deux minutes', 'voice');
  assert.match(unavailable.reply.text, /ne peux pas lancer/);
  assert.deepEqual(unavailable.tools.receipts, []);
  assert.equal((await kitchenTimer.read()).state, 'idle');
});
