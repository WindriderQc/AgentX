'use strict';

const { synthesisText, speechText } = require('../../../public/js/voice/speech-language');

const ALLOWED_LANGUAGES = new Set(['en', 'fr']);
const ALLOWED_TTS_PROVIDERS = new Set(['kokoro', 'windows_sapi', 'voxcpm']);
const MAX_TTS_TEXT_LENGTH = 50000;
const MAX_TTS_VOICE_LENGTH = 120;
// One Kokoro voice id (ff_siwis) or a weighted blend (af_heart:0.6+ff_siwis:0.4).
const TTS_VOICE_PATTERN = /^[a-z0-9_]+(?::\d+(?:\.\d+)?)?(?:\+[a-z0-9_]+(?::\d+(?:\.\d+)?)?)*$/i;

function voiceError(message, code, statusCode = 502) {
  return Object.assign(new Error(message), { code, statusCode });
}

function choice(value) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeSynthesisRequest(request = {}, { errorPrefix = 'VOICE' } = {}) {
  const source = typeof request === 'string' ? { text: request } : (request || {});
  const text = String(source.text || '').trim();
  if (!text) throw voiceError('text is required', `${errorPrefix}_TEXT_REQUIRED`, 400);
  if (text.length > MAX_TTS_TEXT_LENGTH) throw voiceError('text is too long', `${errorPrefix}_TEXT_TOO_LARGE`, 413);

  const ttsProvider = choice(source.ttsProvider);
  const spoken = ttsProvider ? synthesisText(text, ttsProvider) : speechText(text);
  if (!spoken) throw voiceError('text is required', `${errorPrefix}_TEXT_REQUIRED`, 400);
  const payload = { text: spoken, save: false, response_format: 'wav' };
  if (ttsProvider) {
    if (!ALLOWED_TTS_PROVIDERS.has(ttsProvider)) throw voiceError('ttsProvider must be kokoro, windows_sapi or voxcpm', `${errorPrefix}_INVALID_CONFIG`, 400);
    payload.tts_provider = ttsProvider;
  }
  const language = choice(source.language);
  if (language && !ALLOWED_LANGUAGES.has(language)) throw voiceError('language must be en or fr', `${errorPrefix}_INVALID_CONFIG`, 400);
  const voice = String(source.voice || '').trim();
  const validVoice = ttsProvider === 'windows_sapi' ? /^[\p{L}\p{N} _().-]+$/u.test(voice)
    : ttsProvider === 'voxcpm' ? /^[a-z0-9_-]+$/i.test(voice) : TTS_VOICE_PATTERN.test(voice);
  if (voice && (voice.length > MAX_TTS_VOICE_LENGTH || !validVoice)) {
    throw voiceError('Select an installed voice or a valid Kokoro blend', `${errorPrefix}_INVALID_CONFIG`, 400);
  }
  // Every explicit provider receives its own request preferences. An omitted
  // provider retains the legacy service-default request shape.
  if (ttsProvider) {
    if (language) payload.language = language;
    if (voice) payload.voice = voice;
  }
  return payload;
}

module.exports = { normalizeSynthesisRequest };
