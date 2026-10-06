'use strict';

const ALLOWED_LANGUAGES = new Set(['en', 'fr']);
const MAX_TTS_VOICE_LENGTH = 120;
function voiceError(message, code, statusCode = 502) {
  return Object.assign(new Error(message), { code, statusCode });
}
function choice(value) { return String(value ?? '').trim().toLowerCase(); }
const { normalizeSynthesisRequest: coreSynthesisRequest } = require('../../../src/services/voice/request');
const { createVoiceTransport } = require('../../../src/services/voice/transport');
function normalizeSynthesisRequest(request) {
  return coreSynthesisRequest(request, { errorPrefix: 'PSYX_VOICE' });
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

// Protected surface projections and errors compose the shared Core transport.
// Voice selections are request-scoped; PsyX never writes VoiX /config.
function createVoiceClient(config, fetchImpl) {
  const voice = config.voice || { mode: 'disabled' };
  const enabled = voice.mode === 'voix';
  // A dedicated voice target never inherits another target's backup.
  const fallbackUrl = String(voice.baseUrl || '').replace(/\/+$/, '') === String(process.env.VOIX_BASE_URL || '').replace(/\/+$/, '') ? process.env.VOIX_FALLBACK_URL : '';
  const transport = createVoiceTransport({ baseUrl: voice.baseUrl, fallbackUrl, timeoutMs: voice.timeoutMs, fetchImpl });

  function requireEnabled() {
    if (!enabled) throw voiceError('Local voice is not configured for this PsyX deployment.', 'PSYX_VOICE_DISABLED', 503);
  }

  async function upstream(path, options = {}, timeoutMs = voice.timeoutMs) {
    requireEnabled();
    let response;
    try {
      response = await transport.request(path, options, timeoutMs);
    } catch (error) {
      if (options.signal?.aborted) throw error;
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
      let observed;
      try { observed = await transport.health(); }
      catch { throw voiceError('The local voice service is unavailable.', 'PSYX_VOICE_UNAVAILABLE', 503); }
      if (!observed.response.ok) throw voiceError('The local voice service is unavailable.', 'PSYX_VOICE_UNAVAILABLE', 503);
      let health;
      try { health = await observed.response.json(); }
      catch { throw voiceError('The local voice service returned an invalid response.', 'PSYX_VOICE_INVALID_RESPONSE'); }
      // Backup availability enables browser speech; native state still belongs
      // to primary. Never wait for or borrow a powered-off primary's devices.
      const [settings, devicePayload] = observed.upstream === 'primary' ? await Promise.all([
        json('/config').catch(() => null), json('/devices').catch(() => null)
      ]) : [null, null];
      return {
        enabled: true,
        reachable: health.status === 'ok',
        serviceVersion: String(health.version || ''),
        activeUpstream: observed.upstream,
        nativeAvailable: Boolean(settings && devicePayload),
        nativeSessionRunning: observed.upstream === 'primary' && Boolean(health.running),
        config: sanitizeConfig(settings || {}),
        devices: sanitizeDevices(devicePayload || {})
      };
    },

    async config() {
      requireEnabled();
      return sanitizeConfig(await json('/config'));
    },

    // Someone starts speaking: wake recognition while they talk. Best effort, like the
    // shared proxy: a disabled, unreachable or older speech service is not an error.
    async warm() {
      if (!enabled) return { warmed: false };
      try {
        const body = await (await transport.request('/api/stt/warm', { method: 'POST' }, 4000)).json();
        return { warmed: body?.warmed === true };
      } catch { return { warmed: false }; }
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
      const endpoint = process.env.VOIX_SPOKEN_CONTROLS_ENABLED === 'true'
        ? '/v1/audio/transcriptions/controls' : '/v1/audio/transcriptions';
      const result = await json(endpoint, { method: 'POST', body: form, signal }, voice.longTimeoutMs);
      if (result.control === 'stop') return { text: '', control: 'stop', language: normalizedLanguage || 'auto' };
      const text = String(result.text || '').trim();
      if (!text) throw voiceError('No speech was detected in the recording.', 'PSYX_VOICE_NO_SPEECH', 422);
      return { text, language: result.language || normalizedLanguage || 'auto' };
    },

    async synthesize(request, signal) {
      requireEnabled();
      const payload = normalizeSynthesisRequest(request);
      const response = await upstream('/api/tts', {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
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
