'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { phaseFor, createTokenMeter, defaultMode, sceneCaption, MODULE_URL } = require('../public/avatar-dock');

test('conversation states map to the face phases the embed understands', () => {
  assert.equal(phaseFor('paused'), 'idle');
  assert.equal(phaseFor('hearing'), 'listening');
  assert.equal(phaseFor('listening'), 'listening');
  assert.equal(phaseFor('thinking'), 'waiting');
  assert.equal(phaseFor('thinking', { generating: true }), 'generating');
  assert.equal(phaseFor('waiting', { hostBusy: true }), 'sleeping', 'a benchmark on the inference host reads as sleep');
  assert.equal(phaseFor('speaking', { hostBusy: true }), 'speaking');
  assert.equal(phaseFor('error'), 'error');
  // Eyes closed until Nestor is activated or woken, open on the first word of his greeting.
  for (const state of ['idle', 'starting', 'resuming']) assert.equal(phaseFor(state), 'sleeping', state);
  assert.equal(phaseFor('listening', { asleep: true }), 'sleeping', 'waiting for "Hey Nestor"');
  assert.equal(phaseFor('speaking', { asleep: true }), 'speaking', 'the greeting and the wake reply open the eyes');
  assert.equal(phaseFor('paused'), 'idle', 'a paused microphone keeps him awake and calm');
});

test('the token meter reports streamed characters as tokens per second over one second', () => {
  let clock = 0;
  const meter = createTokenMeter(() => clock);
  assert.equal(meter.active(), false);
  meter.add(40); meter.add(40);
  assert.equal(meter.rate(), 20);
  assert.equal(meter.active(), true);
  clock = 1500;
  assert.equal(meter.rate(), 0, 'old deltas fall out of the window');
  assert.equal(meter.active(), false);
});

test('the dock opens large on a desktop, family gets the half screen, phones get a bubble', () => {
  assert.equal(defaultMode('personal', 1400), 'quart');
  assert.equal(defaultMode('family', 1400), 'moitie');
  assert.equal(defaultMode('family', 390), 'bulle');
});

test('the conversation page feeds the dock and the face module is same-origin', () => {
  const page = fs.readFileSync(path.join(__dirname, '../public/conversation-page.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(page, /AvatarDock\?\.mount\(\{ space: family \? 'family' : 'personal' \}\)/);
  for (const kind of ['delta', 'tools', 'host-busy', 'turn', 'scene', 'done']) assert.ok(page.includes(`activity('${kind}'`), kind);
  assert.match(page, /asleep: \(\) =>/);
  assert.ok(html.indexOf('greetings.js') < html.indexOf('conversation-page.js'), 'the greetings load before the page that speaks them');
  assert.doesNotMatch(page, /I am ready\. I am listening\./);
  assert.match(page, /observeSpeech: true/);
  assert.match(page, /readInputLevel/);
  assert.equal(MODULE_URL.startsWith('/api/'), true);
  assert.ok(html.indexOf('avatar-dock.js') < html.indexOf('conversation-page.js'), 'the dock loads before the page that mounts it');
});

test('without the 3D face the picture is said in words', () => {
  assert.equal(sceneCaption({ kind: 'add', a: 8, b: 5 }), '8 + 5 = 13');
  assert.equal(sceneCaption({ kind: 'count', to: 47 }), 'On compte jusqu’à 47');
  assert.equal(sceneCaption(null), '');
});
