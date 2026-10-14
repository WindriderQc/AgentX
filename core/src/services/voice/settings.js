'use strict';
// A read-only projection of service settings. Prompts, lexicons, paths and
// device names never leave the speech host through this endpoint.
function serviceSettings(payload = {}) {
  const fixed = payload.static || {};
  const text = key => typeof fixed[key] === 'string' ? fixed[key].slice(0, 120) : null;
  const number = key => typeof fixed[key] === 'number' && Number.isFinite(fixed[key]) ? fixed[key] : null;
  return { owner: 'speech-service', editable: false,
    model: text('whisper_model'), device: text('whisper_device'), computeType: text('whisper_compute_type'),
    vadThreshold: number('whisper_vad_threshold'), queueTimeoutSeconds: number('whisper_queue_timeout_seconds'),
    startupProvider: text('tts_provider'), settingsApply: 'Service startup settings; changes require an operator delivery.' };
}
module.exports = { serviceSettings };
