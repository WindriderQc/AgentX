'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../public/persona-presentation');

test('all catalog personas remain selectable and missing voice inherits the last choice', () => {
  const personas = [{ id: 'default_chat' }, { id: 'learning_guide' },
    { id: 'jarvis', voice: { presentation: 'masculine' } },
    { id: 'secretary', voice: { presentation: 'feminine' } }];
  const storage = { getItem: key => key.endsWith('v2') ? JSON.stringify({ personaId: 'default_chat', lastVoice: 'masculine' }) : null };
  const prefs = P.read(storage, personas);
  assert.equal(prefs.personaId, 'default_chat');
  assert.equal(Object.keys(prefs.profiles).length, personas.length);
  assert.equal(P.chosenVoice(personas[0], '', prefs.lastVoice), 'masculine');
  assert.equal(P.chosenVoice(personas[1], '', prefs.lastVoice), 'masculine');
  assert.equal(P.chosenVoice(personas[2], '', 'feminine'), 'masculine');
  assert.equal(P.chosenVoice(personas[3], '', prefs.lastVoice), 'feminine');
  assert.equal(P.chosenVoice(personas[3], 'masculine', 'feminine'), 'masculine');
  assert.equal(P.chosenVoice(personas[0], '', 'bad-value'), 'feminine');
});
const personas = [{ id: 'nestor' }, { id: 'secretary' }];
const storage = initial => {
  const data = { ...initial };
  return { getItem: key => data[key] || null, setItem: (key, value) => { data[key] = value; } };
};

test('legacy choices migrate into independent per-persona preferences without changing voices', () => {
  const store = storage({ 'household.conversation.preferences.v1': JSON.stringify({ personaId: 'secretary', language: 'fr', voices: { nestor: 'feminine' } }) });
  const value = P.read(store, personas);
  assert.equal(value.personaId, 'secretary');
  assert.equal(value.profiles.nestor.voice, 'feminine');
  assert.equal(value.profiles.secretary.language, 'fr');
  value.profiles.secretary = { language: 'en', voice: 'feminine', visual: { style: 'orb', color: '#abcdef' } };
  assert.equal(P.save(store, value), true);
  const restored = P.read(store, personas);
  assert.equal(restored.profiles.nestor.language, 'fr');
  assert.deepEqual(restored.profiles.secretary, value.profiles.secretary);
});

test('malformed or unavailable storage leaves usable defaults and never claims a save', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const prefs = P.read(broken, personas);
  assert.equal(prefs.personaId, 'nestor');
  assert.equal(P.save(broken, prefs), false);
  assert.deepEqual(P.profile({ language: 'xx', voice: 'script', visual: { style: 'url', color: 'url(evil)' } }), { language: 'auto', voice: '', visual: null });
  assert.equal(P.visual({ style: 'orb', color: 'red; background:url(evil)' }).color, '#52cfc5');
});

test('voice preview and server replies resolve the same persona defaults and override', () => {
  const persona = { voice: { presentation: 'masculine', voices: { fr: 'custom-masculine' } } };
  assert.equal(P.speechFor(persona, 'fr').voice, 'custom-masculine');
  assert.equal(P.speechFor(persona, 'fr', { presentation: 'feminine' }).voice, 'ff_siwis');
  assert.equal(P.speechFor(persona, 'en').voice, 'am_michael');
});

function audioFixture() {
  const previous = globalThis.AudioContext;
  const calls = [];
  const gains = [];
  globalThis.AudioContext = class {
    constructor() { calls.push('context'); this.destination = {}; }
    async resume() { calls.push('resume'); }
    async decodeAudioData() { calls.push('decode'); return {}; }
    async close() { calls.push('close'); }
    createGain() {
      const gain = { value: 1 }; gains.push(gain);
      return { gain, connect() {}, disconnect() {} };
    }
    createBufferSource() {
      return { connect() {}, disconnect() {}, stop() { calls.push('stop'); },
        start() { calls.push('play'); queueMicrotask(() => this.onended()); } };
    }
  };
  return { calls, gains, restore: () => { if (previous) globalThis.AudioContext = previous; else delete globalThis.AudioContext; } };
}

test('preview unlocks only a speaker context and closes it after playback', async () => {
  const fixture = audioFixture();
  try {
    await P.preview(async () => { fixture.calls.push('fetch'); return new ArrayBuffer(2); }, new AbortController().signal);
    assert.deepEqual(fixture.calls, ['context', 'resume', 'fetch', 'decode', 'play', 'stop', 'close']);
    assert.equal(fixture.gains[0].value, 1);
  } finally { fixture.restore(); }
});

test('recording replay uses its supplied gain without changing speech defaults', async () => {
  const fixture = audioFixture();
  try {
    await P.preview(async () => new ArrayBuffer(2), new AbortController().signal, 2.7);
    assert.equal(fixture.gains[0].value, 2.7);
    assert.equal(fixture.calls.includes('play'), true);
  } finally { fixture.restore(); }
});

test('cancelled preview ignores late synthesis bytes and cannot start playback', async () => {
  const fixture = audioFixture(), abort = new AbortController();
  let resolve;
  try {
    const preview = P.preview(() => new Promise(done => { resolve = done; }), abort.signal);
    await new Promise(done => setImmediate(done));
    abort.abort(); resolve(new ArrayBuffer(2)); await preview;
    assert.equal(fixture.calls.includes('play'), false);
    assert.equal(fixture.calls.filter(call => call === 'close').length, 1);
  } finally { fixture.restore(); }
});
