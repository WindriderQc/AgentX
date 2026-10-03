'use strict';

function bounded(value, fallback, min, max) {
  const number = value == null || value === '' ? fallback : Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new Error('Invalid PsyX numeric configuration');
  return number;
}

function loadConfig(env = process.env) {
  const accessMode = env.PSYX_ACCESS_MODE || 'token';
  if (!['token', 'trusted-network'].includes(accessMode)) throw new Error('Invalid PSYX_ACCESS_MODE');
  const mode = env.PSYX_VOICE_MODE || 'disabled';
  if (!['disabled', 'voix'].includes(mode)) throw new Error('Invalid PSYX_VOICE_MODE');
  let baseUrl = '';
  if (mode === 'voix') {
    const url = new URL(env.VOIX_BASE_URL);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid VOIX_BASE_URL');
    baseUrl = url.toString().replace(/\/$/, '');
  }
  // The frontier lane is off until an OpenClaw agent is named for it.
  const frontierAgent = env.PSYX_FRONTIER_AGENT || '';
  if (frontierAgent && !/^[a-z0-9_-]{1,64}$/.test(frontierAgent)) throw new Error('Invalid PSYX_FRONTIER_AGENT');
  const frontierMode = env.PSYX_FRONTIER_MODE || 'local';
  if (!['local', 'deep', 'all'].includes(frontierMode)) throw new Error('Invalid PSYX_FRONTIER_MODE');
  return {
    env: env.NODE_ENV || 'development', provider: 'agentx', accessMode,
    frontier: { agent: frontierAgent, model: env.PSYX_FRONTIER_MODEL || 'frontier', defaultMode: frontierMode },
    accessToken: env.PSYX_ACCESS_TOKEN || '',
    // Core may sit behind a loopback proxy. Socket loopback alone is not consent.
    loopbackBypass: env.PSYX_LOOPBACK_BYPASS === 'true',
    sessionTtlMs: bounded(env.PSYX_SESSION_TTL_HOURS, 8, 0.25, 168) * 3600000,
    maxBodyBytes: bounded(env.PSYX_MAX_BODY_BYTES, 256 * 1024, 1024, 2 * 1024 * 1024),
    requestTimeoutMs: bounded(env.PSYX_INFERENCE_TIMEOUT_MS, 300000, 1000, 900000),
    // The background review runs after completed turns unless explicitly disabled.
    review: { enabled: env.PSYX_AUTO_REVIEW !== 'false', taskType: env.PSYX_REVIEW_TASK || 'deep_reasoning',
      delayMs: bounded(env.PSYX_REVIEW_DELAY_MS, 4000, 0, 600000) },
    voice: { mode, baseUrl,
      timeoutMs: bounded(env.VOIX_TIMEOUT_MS, 10000, 1000, 60000),
      longTimeoutMs: bounded(env.VOIX_LONG_TIMEOUT_MS, 120000, 5000, 600000),
      maxAudioBytes: bounded(env.PSYX_VOICE_MAX_AUDIO_BYTES, 25 * 1024 * 1024, 64 * 1024, 100 * 1024 * 1024) }
  };
}
module.exports = { loadConfig };
