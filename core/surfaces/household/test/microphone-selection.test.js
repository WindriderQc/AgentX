'use strict';
// Browser storage, media tracks and errors are synthetic; no physical devices.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { Conversation } = require('../../../public/js/voice/browser-conversation');

function browser(failure) {
  const calls = [], contexts = [], values = new Map();
  for (const scope of ['personal', 'family', 'reading']) {
    values.set('agentx.voice.capture.v1.' + scope, JSON.stringify({ inputDeviceId: scope + '-mic' }));
  }
  const track = { enabled: true, stop() {}, getSettings: () => ({ echoCancellation: true }) };
  const window = {
    isSecureContext: true, AgentXVoiceCapture: require('../../../public/js/voice/voice-capture'),
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    navigator: { mediaDevices: { async getUserMedia(constraints) {
      calls.push(constraints);
      if (failure) throw failure;
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    } } },
    AudioContext: class {
      constructor() { this.sampleRate = 24000; this.state = 'running'; this.destination = {}; contexts.push(this); }
      audioWorklet = { addModule: async () => {} };
      async resume() {} async close() { this.state = 'closed'; }
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    },
    AudioWorkletNode: class { port = { postMessage() {} }; connect() {} disconnect() {} }
  };
  for (const file of ['voice-settings', 'browser-conversation']) {
    vm.runInNewContext(fs.readFileSync(require.resolve('../../../public/js/voice/' + file), 'utf8'),
      { window, URL, AbortController, setTimeout, clearTimeout });
  }
  return { window, api: window.AgentXVoice, calls, contexts, values };
}

for (const scope of ['personal', 'family', 'reading']) {
  test(`${scope} capture applies its saved microphone and accepts an explicit system-default override`, async () => {
    const h = browser(), signal = new AbortController().signal;
    const audio = await h.api.openAudio(signal, () => {}, { captureScope: scope });
    assert.equal(h.calls[0].audio.deviceId.exact, scope + '-mic'); audio.close();
    const fallback = await h.api.openAudio(signal, () => {}, { captureScope: scope, inputDeviceId: '' });
    assert.equal(h.calls[1].audio.deviceId, undefined); fallback.close();
    assert.equal(JSON.parse(h.values.get('agentx.voice.capture.v1.' + scope)).inputDeviceId, scope + '-mic');
  });

  for (const name of ['NotFoundError', 'OverconstrainedError']) {
    test(`${scope} ${name} stops visibly without replacing the chosen microphone or opening a session`, async () => {
      const error = Object.assign(new Error('Synthetic device missing'), { name, constraint: 'deviceId' });
      const h = browser(error), before = [...h.values], phases = []; let sessions = 0;
      const c = new Conversation({
        recoverCapture: true,
        openAudio: (signal, failed, options) => h.api.openAudio(signal, failed, { ...options, captureScope: scope }),
        createSession: async () => { sessions++; return {}; }
      }, (state, detail) => phases.push([state, detail]));
      await c.start({ language: 'fr' });
      assert.equal(c.state, 'error'); assert.match(phases.at(-1)[1], /micro choisi.*indisponible/i);
      assert.match(phases.at(-1)[1], /choisissez et enregistrez/);
      assert.equal(h.calls.length, 1); assert.equal(h.calls[0].audio.deviceId.exact, scope + '-mic');
      assert.equal(h.contexts[0].state, 'closed'); assert.equal(sessions, 0);
      assert.deepEqual([...h.values], before);
      c.stop();
    });
  }
}

test('capture preserves permission failures, unrelated constraints and system-default failures', async () => {
  for (const [name, constraint, options] of [
    ['NotAllowedError', undefined, {}], ['OverconstrainedError', 'sampleRate', {}],
    ['NotFoundError', undefined, { inputDeviceId: '' }]
  ]) {
    const error = Object.assign(new Error('Synthetic failure'), { name, constraint });
    const h = browser(error);
    await assert.rejects(h.api.openAudio(new AbortController().signal, () => {}, options), actual => actual === error);
    assert.equal(h.calls.length, 1); assert.equal(h.contexts[0].state, 'closed');
  }
});

test('an unavailable explicit microphone offers recovery in English and retains the native cause', async () => {
  const cause = Object.assign(new Error('Synthetic missing device'), { name: 'OverconstrainedError', constraint: 'deviceId' });
  const h = browser(cause);
  await assert.rejects(h.api.openAudio(new AbortController().signal), error => {
    assert.equal(error.code, 'VOICE_SELECTED_DEVICE_UNAVAILABLE'); assert.equal(error.cause, cause);
    assert.match(error.message, /Reconnect.*choose and save another microphone/); return true;
  });
});
