'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserSessionControls } = require('../browser-session-controls');
const replay = require('../public/reply-replay');

const session = { sessionId: 'personal-session', voice: { language: 'en' } };
const paused = {
  sessionId: session.sessionId, clientTurnId: 'original-turn', channel: 'voice', outcome: 'completed',
  textRetention: 'full', replyText: 'Voici la réponse interrompue.', speechLanguage: 'fr',
  voiceTimings: { playbackOutcome: 'user_paused' }
};

function fixture() {
  class Element {
    constructor() { this.children = []; this.dataset = { turn: paused.clientTurnId }; this.ownerDocument = doc; }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute() {}
    querySelector() { return this.children.find(node => node.className?.includes('conversation-reply-replay')); }
  }
  const doc = { createElement: () => new Element() };
  const row = new Element(), calls = [];
  const host = { querySelectorAll: () => [row], contains: node => node === row };
  let currentSession = session, micOpen = false, resolvePlayback;
  const player = {
    speak(fetch, { segments }) {
      calls.push(segments);
      return new Promise(resolve => {
        resolvePlayback = resolve;
        void fetch(new AbortController().signal, segments[0]);
      });
    },
    cancel() { calls.push('cancel'); resolvePlayback?.(); }
  };
  const controller = replay.create({
    host, base: '/sessions', getSession: () => currentSession, getLanguage: () => 'fr',
    api: async url => { calls.push(url); return { turn: paused }; },
    mayPlay: () => !micOpen, beforePlay: () => {},
    speech: { splitSpeechText: text => [text], speechText: text => text },
    makePlayer: () => player,
    synthesize: answer => { calls.push({ text: answer.text, language: answer.language }); }
  });
  return { row, calls, controller, mute: value => { micOpen = !value; },
    switchSession: () => { currentSession = { sessionId: 'another-session' }; } };
}

test('only a full saved voice answer tied to interrupted playback can be offered for replay', () => {
  assert.equal(replay.savedAnswer(paused, session).text, paused.replyText);
  for (const change of [
    { voiceTimings: { playbackOutcome: 'completed' } }, { channel: 'text' }, { outcome: 'cancelled' },
    { interrupted: true }, { textRetention: 'preview' }, { replyText: '' }, { sessionId: 'another-session' }
  ]) assert.equal(replay.savedAnswer({ ...paused, ...change }, session), null);
  assert.equal(replay.savedAnswer(paused, { ...session, ephemeral: true }), null);
});

test('the exact saved turn can be replayed once with the mic closed and stopped during playback', async () => {
  const h = fixture();
  await h.controller.refresh(session, paused.clientTurnId, paused.voiceTimings);
  h.controller.bind(h.row, paused);
  assert.equal(h.row.children.length, 1);
  const [button, status] = h.row.children[0].children;
  h.mute(false);
  await button.onclick();
  assert.match(status.textContent, /Mettez la voix en pause/);
  assert.equal(h.calls.length, 1);
  h.mute(true);
  const playing = button.onclick();
  assert.equal(button.textContent, 'Arrêter la relecture');
  await button.onclick();
  await playing;
  assert.deepEqual(h.calls, ['/sessions/personal-session/history?turnId=original-turn',
    [paused.replyText], { text: paused.replyText, language: 'fr' }, 'cancel']);
  assert.equal(status.textContent, 'Relecture arrêtée.');
  h.switchSession();
  await button.onclick();
  assert.equal(h.calls.length, 4);
});

test('exact OpenClaw history reads the retained turn in its own personal scope without native recovery', async () => {
  const routes = new Map(), lookups = [];
  const stored = { ...session, packId: 'personal_operator', scopeId: 'personal',
    modeId: 'operator', status: 'active', backend: 'openclaw' };
  const register = createBrowserSessionControls({
    personas: { get: (path, callback) => routes.set(path, callback), post() {} },
    conversations: {
      async getSession(filter) { return Object.entries(filter).every(([key, value]) => stored[key] === value) ? stored : null; },
      async getTurn(filter) { lookups.push(filter); return paused; }
    },
    envelope: (res, body, status = 200) => res.reply(status, body),
    fail: (res, status, message, code) => res.reply(status, { message, code }),
    cleanText: value => String(value || ''), validClientTurnId: value => value === paused.clientTurnId,
    reconcileConversation() { assert.fail('OpenClaw exact history must never invoke native recovery'); }
  });
  register('/private', 'personal_operator', 'personal');
  const get = sessionId => new Promise(resolve => routes.get('/private/sessions/:sessionId/history')(
    { params: { sessionId }, query: { turnId: paused.clientTurnId } },
    { set() {}, reply: (status, body) => resolve({ status, body }) }
  ));
  const received = await get(session.sessionId);
  assert.equal(received.status, 200);
  assert.equal(received.body.turn.replyText, paused.replyText);
  assert.equal((await get('another-session')).status, 404);
  assert.deepEqual(lookups, [{ sessionId: session.sessionId, packId: 'personal_operator',
    scopeId: 'personal', clientTurnId: paused.clientTurnId }]);
});
