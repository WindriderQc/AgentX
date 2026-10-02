'use strict';

// Browser-local voice preferences for PsyX.
//
// Preferences live in this browser only and travel with each PsyX request.
// They are never written to the shared VoiX service configuration, so two
// PsyX browsers (or any other VoiX consumer) cannot overwrite each other.
// Loaded as a classic script by the UI and required by the Node test suite.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.PsyXVoicePreferences = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const STORAGE_KEY = 'psyx.voice.preferences.v1';
  const LANGUAGES = Object.freeze(['fr', 'en']);
  const TTS_PROVIDERS = Object.freeze(['kokoro', 'windows_sapi', 'voxcpm']);
  const MAX_TTS_VOICE_LENGTH = 120;
  const MAX_DEVICE_ID_LENGTH = 256;
  const TTS_VOICE_PATTERN = /^[a-z0-9_]+(?::\d+(?:\.\d+)?)?(?:\+[a-z0-9_]+(?::\d+(?:\.\d+)?)?)*$/i;
  const DEFAULTS = Object.freeze({
    spokenReplies: false,
    autoSend: false,
    language: 'fr',
    ttsProvider: 'kokoro',
    ttsVoice: '',
    inputDeviceId: ''
  });
  const PROVIDER_LABELS = Object.freeze({ kokoro: 'Kokoro', windows_sapi: 'Windows SAPI', voxcpm: 'VoxCPM2' });
  const LANGUAGE_LABELS = Object.freeze({ fr: 'French', en: 'English' });

  function lower(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
  }

  function isValidVoice(value, provider = 'kokoro') {
    // Older SAPI preferences retained a hidden, unused Kokoro field.
    if (provider === 'windows_sapi' && /^[abefhijpz][fm]_/.test(value)) return false;
    const pattern = provider === 'windows_sapi' ? /^[\p{L}\p{N} _().-]+$/u : provider === 'voxcpm' ? /^[a-z0-9_-]+$/i : TTS_VOICE_PATTERN;
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_TTS_VOICE_LENGTH && pattern.test(value);
  }

  // Coerces anything found in storage (or an older preference shape) into the
  // bounded preference set. Unknown or invalid values fall back to the defaults.
  function normalizePreferences(stored) {
    const source = stored && typeof stored === 'object' ? stored : {};
    const language = lower(source.language);
    const ttsProvider = lower(source.ttsProvider);
    const ttsVoice = String(source.ttsVoice == null ? '' : source.ttsVoice).trim();
    const inputDeviceId = String(source.inputDeviceId == null ? '' : source.inputDeviceId);
    return {
      spokenReplies: source.spokenReplies === true,
      autoSend: source.autoSend === true,
      language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
      ttsProvider: TTS_PROVIDERS.includes(ttsProvider) ? ttsProvider : DEFAULTS.ttsProvider,
      ttsVoice: isValidVoice(ttsVoice, ttsProvider) ? ttsVoice : DEFAULTS.ttsVoice,
      inputDeviceId: inputDeviceId.length <= MAX_DEVICE_ID_LENGTH ? inputDeviceId : DEFAULTS.inputDeviceId
    };
  }

  function readPreferences(storage) {
    try {
      return normalizePreferences(JSON.parse(storage.getItem(STORAGE_KEY) || '{}'));
    } catch {
      return normalizePreferences({});
    }
  }

  function writePreferences(storage, preferences) {
    const normalized = normalizePreferences(preferences);
    try { storage.setItem(STORAGE_KEY, JSON.stringify(normalized)); }
    catch { /* storage may be unavailable; the in-memory preference still applies */ }
    return normalized;
  }

  // The body PsyX sends to POST /api/psyx/voice/synthesize. Language and voice are
  // remain scoped to this browser request for every local provider.
  function synthesisRequest(text, preferences) {
    const prefs = normalizePreferences(preferences);
    const body = { text: String(text == null ? '' : text), ttsProvider: prefs.ttsProvider };
    if (TTS_PROVIDERS.includes(prefs.ttsProvider)) {
      body.language = prefs.language;
      if (prefs.ttsVoice) body.voice = prefs.ttsVoice;
    }
    return body;
  }

  // Default Kokoro voice VoiX would use for the selected language, from the sanitized
  // /api/psyx/voice/status profiles. Empty when the service did not report one.
  function defaultVoiceFor(preferences, status) {
    const prefs = normalizePreferences(preferences);
    const profiles = Array.isArray(status && status.config && status.config.ttsLanguageProfiles) ? status.config.ttsLanguageProfiles : [];
    const match = profiles.find((profile) => profile && lower(profile.language) === prefs.language);
    return match && match.voice ? String(match.voice) : '';
  }

  function describePreferences(preferences, status) {
    const prefs = normalizePreferences(preferences);
    const voice = prefs.ttsVoice || (prefs.ttsProvider === 'kokoro' ? defaultVoiceFor(prefs, status) : 'language default');
    return `${PROVIDER_LABELS[prefs.ttsProvider]} · ${LANGUAGE_LABELS[prefs.language]}${voice ? ` · ${voice}` : ''}`;
  }

  function testSentence(preferences) {
    return normalizePreferences(preferences).language === 'fr'
      ? 'Bonjour. La voix locale de PsyX est prête.'
      : 'Hello. PsyX local voice is ready.';
  }

  return Object.freeze({
    STORAGE_KEY,
    DEFAULTS,
    LANGUAGES,
    TTS_PROVIDERS,
    PROVIDER_LABELS,
    isValidVoice,
    normalizePreferences,
    readPreferences,
    writePreferences,
    synthesisRequest,
    defaultVoiceFor,
    describePreferences,
    testSentence
  });
});
