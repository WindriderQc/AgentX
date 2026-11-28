'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFamilyKitchenTimer } = require('../../../src/services/familyKitchenTimer');
const { parse } = require('../../../src/services/familyKitchenTimerCommand');
const { memoryMongoose } = require('./fixtures/kitchen-timer-memory.cjs');
const { harness } = require('./fixtures/persona-journey.cjs');

test('French starts, checks and cancellations are narrow and normalize transcript punctuation', () => {
  assert.deepEqual(parse('Nestor, mets une minuterie de deux minutes, s’il te plaît.'), { action: 'start', seconds: 120 });
  assert.deepEqual(parse('Pars le chrono pour 1 minute et 30 secondes.'), { action: 'start', seconds: 90 });
  assert.deepEqual(parse('Combien de temps reste-t-il sur la minuterie ?'), { action: 'status', explicit: true });
  assert.deepEqual(parse('Combien il reste?'), { action: 'status', explicit: false });
  assert.deepEqual(parse('Arrête la minuterie.'), { action: 'cancel' });
  assert.deepEqual(parse('Lance une minuterie de 0 seconde.'), { action: 'invalid' });
  assert.deepEqual(parse('Pars la minuterie pour 25 heures.'), { action: 'invalid' });
  assert.equal(parse('Mets une minuterie de deux minutes et dessine un chat'), null);
  assert.equal(parse('Tu peux me raconter l’histoire d’une minuterie de deux minutes?'), null);
});
test('Québec shorthand and explicit polite starts require a complete timer-only command', () => {
  for (const [phrase, seconds] of [
    ['Mets deux minutes', 120],
    ['Nestor, mets-moi 2 minutes et 30 secondes, s’il te plaît.', 150],
    ['Peux-tu mettre une minuterie de deux minutes?', 120],
    ['Pourrais-tu démarrer le chrono pour une minute?', 60],
    ['Tu peux lancer une minuterie pour 45 secondes ?', 45]
  ]) assert.deepEqual(parse(phrase), { action: 'start', seconds }, phrase);
  for (const phrase of [
    'Deux minutes',
    'Mets deux minutes de musique',
    'Mets deux minutes et joue une chanson',
    'Mets deux minutes au micro-ondes',
    'Peux-tu mettre deux minutes?',
    'Peux-tu mettre une minuterie de deux minutes et jouer une chanson?',
    'Peux-tu mettre une minuterie de 2,5 minutes puis dessiner un chat?',
    'Ne mets pas deux minutes',
    'Mets -2 minutes',
    'Mets 2,5 minutes',
    'Mets 25 heures',
    'Il a dit : « Mets deux minutes »'
  ]) assert.equal(parse(phrase), null, phrase);
});
test('Core persists the original absolute deadline, does not overwrite, and claims one alert', async () => {
  let time = 1_000_000;
  const mongoose = memoryMongoose(), now = () => time;
  const timer = createFamilyKitchenTimer({ mongoose, now });
  assert.equal((await timer.command('Combien il reste?')).handled, false);
  const original = await timer.command('Mets une minuterie de 2 minutes');
  assert.equal(original.timer.endsAt, 1_120_000);
  assert.match(original.reply.text, /2 minutes/);
  time += 15_000;
  const concurrent = await timer.command('Lance une minuterie de 10 secondes');
  assert.equal(concurrent.timer.id, original.timer.id);
  assert.equal(concurrent.timer.endsAt, original.timer.endsAt);
  assert.match((await timer.command('Combien il reste?')).reply.text, /1 minute et 45 secondes/);
  assert.deepEqual(await timer.claimAlert(original.timer.id), { claimed: false });
  time = original.timer.endsAt;
  assert.equal((await timer.read()).state, 'finished');
  const claims = await Promise.all([timer.claimAlert(original.timer.id), timer.claimAlert(original.timer.id)]);
  assert.equal(claims.filter(x => x.claimed).length, 1);
  assert.equal((await timer.read()).alertClaimed, true);
  const next = await timer.command('Lance une minuterie pour 15 secondes');
  assert.notEqual(next.timer.id, original.timer.id);
  assert.match((await timer.command('Annule la minuterie.')).reply.text, /annulée/);
  assert.equal((await timer.read()).state, 'idle');
  time += 90_000;
  assert.deepEqual(await timer.claimAlert(next.timer.id), { claimed: false });
});
test('native Famille voice and typed turns use the same deterministic Core contract without inference', async () => {
  const kitchenTimer = createFamilyKitchenTimer({ mongoose: memoryMongoose(), now: () => 1_000_000 });
  const family = harness({ packId: 'kidx_nestor', backend: 'agentx', kitchenTimer });
  const started = await family.turn('Mets deux minutes', 'voice');
  const remaining = await family.turn('Combien il reste?', 'voice');
  const cancelled = await family.turn('Annule la minuterie', 'text');
  assert.match(started.reply.text, /2 minutes/);
  assert.match(remaining.reply.text, /2 minutes/);
  assert.match(cancelled.reply.text, /annulée/);
  assert.equal(family.sent.length, 0);
  assert.deepEqual(family.turns.map(t => t.channel), ['text', 'voice', 'voice']);
  const polite = await family.turn('Peux-tu mettre une minuterie de deux minutes?', 'voice');
  assert.match(polite.reply.text, /2 minutes/);
  assert.equal(family.sent.length, 0);
  await family.turn('Annule la minuterie', 'text');
  await family.turn('Combien il reste?', 'voice');
  assert.equal(family.sent.length, 1);
});
