'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Conversation } = require('../public/browser-conversation');

function harness() {
  const opened = [], created = [], greeted = [], calls = [];
  const audio = { listen() { calls.push('listen'); }, quiet() {}, close() { calls.push('close'); }, async play() { calls.push('play'); } };
  const conversation = new Conversation({
    async openAudio(_signal, _onError, options) { opened.push(options); return audio; },
    async createSession() { created.push('arrival'); return { sessionId: 'arrival' }; },
    async greet(session) { greeted.push(session.sessionId); return new ArrayBuffer(4); },
    message() {}
  });
  // The steps of resumeSession in conversation-page.js once the saved conversation is read.
  const load = (session, selection) => {
    conversation.stop(); conversation.session = session; conversation.show('paused');
    return conversation.start(selection, { automatic: true });
  };
  return { conversation, load, opened, created, greeted, calls };
}

test('a saved conversation opened over a live one listens again on its own session, without a greeting', async () => {
  const h = harness();
  await h.conversation.start({});
  assert.deepEqual(h.greeted, ['arrival']);
  await h.load({ sessionId: 'saved' }, { wakeWord: false });
  assert.equal(h.conversation.state, 'listening');
  assert.equal(h.conversation.session.sessionId, 'saved');
  assert.deepEqual(h.created, ['arrival'], 'no empty conversation opens beside the saved one');
  assert.deepEqual(h.greeted, ['arrival'], 'a resumed conversation is not greeted again');
  assert.deepEqual(h.calls, ['play', 'listen', 'close', 'listen'], 'the first microphone closes before the next one listens');
  assert.deepEqual(h.opened.at(-1), { automatic: true }, 'audio opens as it does on arrival, with no fresh press');
  h.conversation.stop();
});

test('a saved conversation opened with the wake word required waits for it', async () => {
  const h = harness();
  await h.load({ sessionId: 'saved' }, { wakeWord: true });
  assert.equal(h.conversation.state, 'listening');
  assert.equal(h.conversation.selection.wakeWord, true);
  assert.equal(h.conversation.wake.active(), false, 'standby until « Hey Nestor »');
  assert.deepEqual(h.created, []);
  h.conversation.stop();
});

test('the Household page resumes a loaded conversation the way a press on Reprendre does', () => {
  const page = fs.readFileSync(path.join(__dirname, '../public/conversation-page.js'), 'utf8');
  // One definition of starting voice, shared by the button and by a loaded conversation.
  assert.match(page, /const startVoice = options => \{[^}]*if \(open\.checked\) void openHold\.start\(\);\s*return conversation\.start\(selection\(\), options\);\s*\};/);
  assert.match(page, /\{ conversation\.stop\(true\); return; \}\s*return startVoice\(\);/);
  const load = page.slice(page.indexOf('async function resumeSession('), page.indexOf('async function loadRecent('));
  const shown = load.indexOf("conversation.show('paused')"), started = load.indexOf('startVoice({ automatic: true })');
  assert.ok(shown > 0 && shown < started, 'voice starts once the saved conversation is on screen');
  // Only where the microphone is already granted, and never for a load that was superseded.
  assert.match(load, /const permission = await navigator\.permissions\?\.query\(\{ name: 'microphone' \}\)\.catch\(\(\) => null\);/);
  assert.match(load, /if \(permission\?\.state === 'granted' && epoch === conversation\.epoch\) void startVoice\(\{ automatic: true \}\);/);
  // Starting voice moves the loop's epoch: the pictures still being restored follow the session shown.
  assert.match(load, /\{ current: \(\) => conversation\.session\?\.sessionId === data\.session\.sessionId \}/);
});

test('starting voice moves the epoch and keeps the loaded session', async () => {
  const h = harness(), saved = { sessionId: 'saved' };
  h.conversation.stop(); h.conversation.session = saved; h.conversation.show('paused');
  const loaded = h.conversation.epoch;
  await h.conversation.start({}, { automatic: true });
  assert.notEqual(h.conversation.epoch, loaded, 'the epoch cannot tell a resumed conversation from an abandoned load');
  assert.equal(h.conversation.session, saved);
  h.conversation.stop(true);
  assert.equal(h.conversation.session, saved, 'a pause keeps it');
  h.conversation.stop();
  assert.equal(h.conversation.session, null, 'a new or other conversation forgets it');
});
