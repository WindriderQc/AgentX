'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const prefs = require('../public/voice-preferences');

const SOURCE = path.join(__dirname, '..', 'public', 'voice-preferences.js');

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    dump: () => Object.fromEntries(map)
  };
}

test('the browser module loads as a classic script without CommonJS', () => {
  const context = { window: {} };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(SOURCE, 'utf8'), context, { filename: 'voice-preferences.js' });
  assert.equal(typeof context.PsyXVoicePreferences.synthesisRequest, 'function');
  // Compare structurally: the vm realm has its own Object.prototype.
  assert.equal(JSON.stringify(context.PsyXVoicePreferences.DEFAULTS), JSON.stringify(prefs.DEFAULTS));
  assert.equal(JSON.stringify(context.PsyXVoicePreferences.synthesisRequest('x', { ttsProvider: 'windows_sapi' })), JSON.stringify(prefs.synthesisRequest('x', { ttsProvider: 'windows_sapi' })));
});

test('missing or corrupt browser storage falls back to privacy-safe defaults', () => {
  assert.deepEqual(prefs.readPreferences(fakeStorage()), {
    spokenReplies: false, autoSend: false, language: 'fr', ttsProvider: 'kokoro', ttsVoice: '', inputDeviceId: ''
  });
  assert.deepEqual(prefs.readPreferences(fakeStorage({ [prefs.STORAGE_KEY]: '{not json' })), prefs.DEFAULTS);
  assert.deepEqual(prefs.readPreferences({ getItem() { throw new Error('storage blocked'); } }), prefs.DEFAULTS);
});

test('stored values are bounded to the supported engines, languages and voices', () => {
  const stored = fakeStorage({ [prefs.STORAGE_KEY]: JSON.stringify({
    spokenReplies: 'yes', autoSend: true, language: 'DE', ttsProvider: 'cloud-tts', ttsVoice: 'af_heart; drop', inputDeviceId: 42, brain: 'remote'
  }) });
  assert.deepEqual(prefs.readPreferences(stored), {
    spokenReplies: false, autoSend: true, language: 'fr', ttsProvider: 'kokoro', ttsVoice: '', inputDeviceId: '42'
  });
  assert.equal(prefs.normalizePreferences({ ttsProvider: 'WINDOWS_SAPI', language: 'en' }).ttsProvider, 'windows_sapi');
  assert.equal(prefs.normalizePreferences({ ttsVoice: 'af_heart:0.6+ff_siwis:0.4' }).ttsVoice, 'af_heart:0.6+ff_siwis:0.4');
  assert.equal(prefs.normalizePreferences({ ttsVoice: 'a'.repeat(121) }).ttsVoice, '');
  assert.equal(prefs.isValidVoice('ff_siwis'), true);
  assert.equal(prefs.isValidVoice('ff siwis'), false);
});

test('preferences persist across a reload in the same browser only', () => {
  const browserA = fakeStorage();
  const browserB = fakeStorage();
  prefs.writePreferences(browserA, { language: 'en', ttsProvider: 'kokoro', ttsVoice: 'af_heart', spokenReplies: true });
  prefs.writePreferences(browserB, { language: 'fr', ttsProvider: 'windows_sapi' });

  const reloadedA = prefs.readPreferences(browserA);
  const reloadedB = prefs.readPreferences(browserB);
  assert.deepEqual(reloadedA, { spokenReplies: true, autoSend: false, language: 'en', ttsProvider: 'kokoro', ttsVoice: 'af_heart', inputDeviceId: '' });
  assert.deepEqual(reloadedB, { spokenReplies: false, autoSend: false, language: 'fr', ttsProvider: 'windows_sapi', ttsVoice: '', inputDeviceId: '' });
  assert.deepEqual(Object.keys(browserA.dump()), [prefs.STORAGE_KEY]);
  assert.doesNotMatch(JSON.stringify(browserA.dump()), /audio|transcript|token/i);
  assert.deepEqual(prefs.writePreferences({ getItem() { return null; }, setItem() { throw new Error('quota'); } }, { language: 'en' }).language, 'en');
});

test('synthesis requests carry each browser preference for that request only', () => {
  assert.deepEqual(prefs.synthesisRequest('Bonjour', { language: 'fr', ttsProvider: 'kokoro', ttsVoice: 'ff_siwis' }), {
    text: 'Bonjour', ttsProvider: 'kokoro', language: 'fr', voice: 'ff_siwis'
  });
  assert.deepEqual(prefs.synthesisRequest('Hello', { language: 'en', ttsProvider: 'kokoro' }), { text: 'Hello', ttsProvider: 'kokoro', language: 'en' });
  assert.deepEqual(prefs.synthesisRequest('Hello', { language: 'en', ttsProvider: 'windows_sapi', ttsVoice: 'af_heart' }), { text: 'Hello', ttsProvider: 'windows_sapi', language: 'en' });
  assert.deepEqual(prefs.synthesisRequest('Bonjour', { language: 'fr', ttsProvider: 'windows_sapi', ttsVoice: 'Microsoft Claude' }), { text: 'Bonjour', ttsProvider: 'windows_sapi', language: 'fr', voice: 'Microsoft Claude' });
  assert.deepEqual(prefs.synthesisRequest('Bonjour', { language: 'fr', ttsProvider: 'voxcpm', ttsVoice: 'nestor-a' }), { text: 'Bonjour', ttsProvider: 'voxcpm', language: 'fr', voice: 'nestor-a' });
  assert.deepEqual(Object.keys(prefs.synthesisRequest('x', {})), ['text', 'ttsProvider', 'language']);
});

test('summaries describe the effective request without exposing service internals', () => {
  const status = { config: { ttsLanguageProfiles: [{ language: 'fr', locale: 'fr-fr', voice: 'ff_siwis' }, { language: 'en', locale: 'en-us', voice: 'af_heart' }] } };
  assert.equal(prefs.defaultVoiceFor({ language: 'en' }, status), 'af_heart');
  assert.equal(prefs.defaultVoiceFor({ language: 'en' }, null), '');
  assert.equal(prefs.describePreferences({ language: 'en', ttsProvider: 'kokoro' }, status), 'Kokoro · English · af_heart');
  assert.equal(prefs.describePreferences({ language: 'fr', ttsProvider: 'kokoro', ttsVoice: 'af_heart:0.6+ff_siwis:0.4' }, status), 'Kokoro · French · af_heart:0.6+ff_siwis:0.4');
  assert.equal(prefs.describePreferences({ language: 'fr', ttsProvider: 'windows_sapi', ttsVoice: 'af_heart' }, status), 'Windows SAPI · French · language default');
  assert.match(prefs.testSentence({ language: 'fr' }), /PsyX/);
  assert.match(prefs.testSentence({ language: 'en' }), /PsyX local voice/);
});
