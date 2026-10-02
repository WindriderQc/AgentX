'use strict';

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

function sanitizeConfig(payload = {}) {
  const runtime = payload.config || payload;
  const fixed = payload.static || {};
  const profiles = Array.isArray(fixed.tts_language_profiles) ? fixed.tts_language_profiles : [];
  return {
    language: runtime.language || 'auto',
    inputDevice: runtime.input_device || '',
    outputDevice: runtime.output_device || '',
    ttsProvider: runtime.tts_provider || 'kokoro',
    ttsVoice: (runtime.tts_provider === 'voxcpm' ? fixed.voxcpm_voice : runtime.tts_provider === 'windows_sapi' ? fixed.windows_sapi_voice : fixed.kokoro_voice) || '',
    ttsLanguageProfiles: profiles
      .map((item) => ({ language: choice(item?.language), locale: choice(item?.locale), voice: String(item?.voice || '').slice(0, MAX_TTS_VOICE_LENGTH) }))
      .filter((item) => ALLOWED_LANGUAGES.has(item.language)),
    whisperModel: fixed.whisper_model || '',
    running: Boolean(payload.running),
    applies: payload.applies || null
  };
}

function sanitizeDevices(payload = {}) {
  const devices = Array.isArray(payload.devices) ? payload.devices : [];
  return devices.map((item) => ({
    index: Number(item.index),
    name: String(item.name || 'Audio device').slice(0, 160),
    input: Number(item.max_input_channels) > 0,
    output: Number(item.max_output_channels) > 0,
    defaultInput: Boolean(item.default_input),
    defaultOutput: Boolean(item.default_output)
  })).filter((item) => Number.isInteger(item.index) && (item.input || item.output));
}

// Builds the request-scoped VoiX /api/tts payload. The selected engine, language and
// voice travel with this one request only; PsyX never writes VoiX /config.
function normalizeSynthesisRequest(request = {}) {
  const source = typeof request === 'string' ? { text: request } : (request || {});
  const text = String(source.text || '').trim();
  if (!text) throw voiceError('text is required', 'PSYX_VOICE_TEXT_REQUIRED', 400);
  if (text.length > MAX_TTS_TEXT_LENGTH) throw voiceError('text is too long', 'PSYX_VOICE_TEXT_TOO_LARGE', 413);

  const payload = { text, save: false, response_format: 'wav' };
  const ttsProvider = choice(source.ttsProvider);
  if (ttsProvider) {
    if (!ALLOWED_TTS_PROVIDERS.has(ttsProvider)) throw voiceError('ttsProvider must be kokoro, windows_sapi or voxcpm', 'PSYX_VOICE_INVALID_CONFIG', 400);
    payload.tts_provider = ttsProvider;
  }
  const language = choice(source.language);
  if (language && !ALLOWED_LANGUAGES.has(language)) throw voiceError('language must be en or fr', 'PSYX_VOICE_INVALID_CONFIG', 400);
  const voice = String(source.voice || '').trim();
  const validVoice = ttsProvider === 'windows_sapi' ? /^[\p{L}\p{N} _().-]+$/u.test(voice)
    : ttsProvider === 'voxcpm' ? /^[a-z0-9_-]+$/i.test(voice) : TTS_VOICE_PATTERN.test(voice);
  if (voice && (voice.length > MAX_TTS_VOICE_LENGTH || !validVoice)) {
    throw voiceError('Select an installed voice or a valid Kokoro blend', 'PSYX_VOICE_INVALID_CONFIG', 400);
  }
  // Every explicit provider receives its own request preferences. An omitted
  // provider retains the legacy service-default request shape.
  if (ttsProvider) {
    if (language) payload.language = language;
    if (voice) payload.voice = voice;
  }
  return payload;
}

function createVoiceClient(config, fetchImpl = globalThis.fetch) {
  const voice = config.voice || { mode: 'disabled' };
  const enabled = voice.mode === 'voix';

  function requireEnabled() {
    if (!enabled) throw voiceError('Local voice is not configured for this PsyX deployment.', 'PSYX_VOICE_DISABLED', 503);
  }

  async function upstream(path, options = {}, timeoutMs = voice.timeoutMs) {
    requireEnabled();
    let response;
    try {
      response = await fetchImpl(`${voice.baseUrl}${path}`, { ...options,
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
    } catch {
      throw voiceError('The local voice service is unavailable.', 'PSYX_VOICE_UNAVAILABLE', 503);
    }
    if (!response.ok) {
      const statusCode = response.status >= 400 && response.status < 500 ? 400 : 502;
      throw voiceError('The local voice service rejected the request.', 'PSYX_VOICE_UPSTREAM_ERROR', statusCode);
    }
    return response;
  }

  async function json(path, options = {}, timeoutMs) {
    const response = await upstream(path, options, timeoutMs);
    try { return await response.json(); }
    catch { throw voiceError('The local voice service returned an invalid response.', 'PSYX_VOICE_INVALID_RESPONSE'); }
  }

  return {
    enabled,
    async catalog() { return json('/api/voices'); },
    async player() { return (await upstream('/assets/voice-audio.js')).text(); },
    async stream(request, signal) {
      return upstream('/api/tts/stream', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(normalizeSynthesisRequest(request)) }, voice.longTimeoutMs);
    },

    async status() {
      requireEnabled();
      const [health, settings, devicePayload] = await Promise.all([
        json('/health'), json('/config'), json('/devices')
      ]);
      return {
        enabled: true,
        reachable: health.status === 'ok',
        serviceVersion: String(health.version || ''),
        nativeSessionRunning: Boolean(health.running),
        config: sanitizeConfig(settings),
        devices: sanitizeDevices(devicePayload)
      };
    },

    async config() {
      requireEnabled();
      return sanitizeConfig(await json('/config'));
    },

    async transcribe(buffer, { contentType, language, signal }) {
      requireEnabled();
      if (!Buffer.isBuffer(buffer) || !buffer.length) throw voiceError('An audio recording is required.', 'PSYX_VOICE_AUDIO_REQUIRED', 400);
      const normalizedLanguage = choice(language);
      if (normalizedLanguage && !ALLOWED_LANGUAGES.has(normalizedLanguage)) throw voiceError('language must be en or fr', 'PSYX_VOICE_INVALID_CONFIG', 400);
      const form = new FormData();
      const extension = contentType.includes('wav') ? 'wav' : contentType.includes('ogg') ? 'ogg' : contentType.includes('mp4') ? 'm4a' : 'webm';
      form.append('file', new Blob([buffer], { type: contentType }), `recording.${extension}`);
      if (normalizedLanguage) form.append('language', normalizedLanguage);
      form.append('response_format', 'json');
      const result = await json('/v1/audio/transcriptions', { method: 'POST', body: form, signal }, voice.longTimeoutMs);
      const text = String(result.text || '').trim();
      if (!text) throw voiceError('No speech was detected in the recording.', 'PSYX_VOICE_NO_SPEECH', 422);
      return { text, language: result.language || normalizedLanguage || 'auto' };
    },

    async synthesize(request) {
      requireEnabled();
      const payload = normalizeSynthesisRequest(request);
      const response = await upstream('/api/tts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      }, voice.longTimeoutMs);
      return {
        buffer: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get('content-type') || 'audio/wav',
        applied: { ttsProvider: response.headers.get('x-voix-provider') || payload.tts_provider || null,
          language: response.headers.get('x-voix-language') || payload.language || null,
          voice: response.headers.get('x-voix-voice') || payload.voice || null }
      };
    }
  };
}

module.exports = { createVoiceClient, normalizeSynthesisRequest, sanitizeConfig, sanitizeDevices };
