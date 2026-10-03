'use strict';

// VoiX upstream client and the public projections Core returns for VoiX
// sessions, events, metrics, configuration and media. Projections keep only
// the documented fields, so upstream additions never leak to browsers.

const VOIX_TIMEOUT_MS = () => Math.max(1000, Number(process.env.VOIX_TIMEOUT_MS) || 10000);
const VOIX_MEDIA_VAULT_CATEGORIES = Object.freeze([
  'acoustic-condition',
  'emotion-research',
  'pronunciation',
  'speaker-enrollment',
  'stt-correction'
]);
const VOIX_MEDIA_VAULT_SUBJECTS = Object.freeze(['adult', 'child', 'unknown']);

function cleanText(value, max = 4000) {
  return String(value || '').trim().slice(0, max);
}

const { fetchWithTimeout } = require('../../src/services/voice/transport');

function voixUrl(pathname) {
  const base = String(process.env.VOIX_BASE_URL || '').replace(/\/+$/, '');
  if (!base) throw Object.assign(new Error('VoiX is not configured for this instance'), { status: 503, code: 'VOIX_NOT_CONFIGURED' });
  return `${base}${pathname}`;
}

async function upstreamJson(pathname, options = {}, timeoutMs = VOIX_TIMEOUT_MS()) {
  return readUpstreamJson(await fetchWithTimeout(voixUrl(pathname), options, timeoutMs));
}

async function readUpstreamJson(response) {
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { response: text }; }
  if (!response.ok) {
    const error = new Error(body?.message || body?.error || `VoiX returned HTTP ${response.status}`);
    error.status = response.status >= 500 ? 503 : response.status;
    error.code = 'VOIX_BAD_RESPONSE';
    throw error;
  }
  return body;
}

const PUBLIC_VOIX_EVENT_TYPES = new Set([
  'session_created', 'session_started', 'session_warming', 'warmup', 'session_ready', 'session_stopped',
  'state', 'speech_started', 'speech_ended', 'wake_waiting', 'wake_ignored', 'transcript', 'transcript_empty',
  'utterance_ignored', 'inference_route', 'first_token', 'first_clause', 'clause',
  'inference_completed', 'tts_first_chunk', 'reply', 'turn_metrics', 'barge_in',
  'playback_echo_rejected', 'memory_context', 'memory_committed', 'memory_synchronized',
  'memory_commit_failed', 'memory_sync_degraded', 'media_candidate_ready',
  'media_clip_saved', 'media_clip_deleted', 'agent_tools', 'error'
]);

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function publicVoixMetrics(value) {
  const metrics = value && typeof value === 'object' ? value : {};
  const projected = {};
  for (const key of [
    'vad_tail_ms', 'stt_ms', 'first_token_ms', 'first_clause_ms', 'tts_first_chunk_ms',
    'first_audio_queued_ms', 'first_audio_callback_ms', 'first_audio_ms', 'reply_done_ms',
    'speech_end_to_first_token_ms', 'speech_end_to_first_clause_ms',
    'speech_end_to_first_audio_ms', 'speech_end_to_reply_done_ms',
    'cancel_flush_ms', 'cancel_silence_ms'
  ]) {
    projected[key] = finiteNumber(metrics[key]);
  }
  return {
    turn_id: cleanText(metrics.turn_id, 120),
    recorded_at: cleanText(metrics.recorded_at, 80),
    status: cleanText(metrics.status, 40),
    endpoint_reason: cleanText(metrics.endpoint_reason, 40),
    language: cleanText(metrics.language, 16),
    brain: cleanText(metrics.brain, 40),
    tts_provider: cleanText(metrics.tts_provider, 40),
    cancel_reason: cleanText(metrics.cancel_reason, 80),
    ...projected
  };
}

function publicVoixConfig(value) {
  const source = value && typeof value === 'object' ? value : {};
  const config = source.config && typeof source.config === 'object' ? source.config : {};
  const staticConfig = source.static && typeof source.static === 'object' ? source.static : {};
  const personalities = Array.isArray(staticConfig.nestor_personalities)
    ? staticConfig.nestor_personalities.slice(0, 20).map((profile) => ({
      id: cleanText(profile?.id, 80),
      label: cleanText(profile?.label, 120),
      description: cleanText(profile?.description, 320)
    })).filter((profile) => profile.id)
    : [];
  return {
    config: {
      brain: cleanText(config.brain, 40),
      nestor_operation: cleanText(config.nestor_operation, 40),
      conversation_mode: cleanText(config.conversation_mode, 16) === 'dad' ? 'dad' : 'family',
      language: cleanText(config.language, 16),
      persona: cleanText(config.persona, 80),
      use_rag: Boolean(config.use_rag),
      input_device: cleanText(config.input_device, 160),
      output_device: cleanText(config.output_device, 160),
      enable_barge_in: Boolean(config.enable_barge_in),
      tts_provider: cleanText(config.tts_provider, 40),
      ...(config.tts_voice_en !== undefined ? { tts_voice_en: cleanText(config.tts_voice_en, 120) } : {}),
      ...(config.tts_voice_fr !== undefined ? { tts_voice_fr: cleanText(config.tts_voice_fr, 120) } : {})
    },
    static: {
      tts_provider_default: cleanText(staticConfig.tts_provider_default, 40),
      kokoro_voice: cleanText(staticConfig.kokoro_voice, 240),
      kokoro_language: cleanText(staticConfig.kokoro_language, 16),
      voxcpm_voice: cleanText(staticConfig.voxcpm_voice, 80),
      voxcpm_configured: staticConfig.voxcpm_configured === true,
      nestor_personalities: personalities
    },
    running: Boolean(source.running),
    restart_note: cleanText(source.restart_note, 320)
  };
}

function publicVoixConversation(value) {
  const source = value && typeof value === 'object' ? value : {};
  const mode = cleanText(source.mode, 16) === 'dad' ? 'dad' : 'family';
  const family = mode === 'family';
  return {
    mode,
    label: family ? 'Nestor Famille' : 'Nestor Dad',
    packId: family ? 'kidx_nestor' : 'personal_operator',
    scopeId: family ? 'family' : 'personal',
    memoryOwner: family ? 'household-family' : source.memoryOwner === 'openclaw/main' ? 'openclaw/main' : 'voix-personal',
    toolsEnabled: !family && source.memoryOwner === 'openclaw/main' && source.toolsEnabled === true,
    activation: family ? 'default-safe' : 'explicit-operator-selection',
    dadActivationRequired: true,
    speakerIdentity: 'unknown',
    authorizesIdentity: false
  };
}

function publicVoixMediaVault(value, { includeCandidateId = false } = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const state = cleanText(source.state, 40) || 'unknown';
  const policy = cleanText(source.policy, 80);
  const protection = cleanText(source.protection, 80);
  const candidate = source.candidate && typeof source.candidate === 'object'
    ? source.candidate
    : {};
  const clips = source.clips && typeof source.clips === 'object' ? source.clips : {};
  const byCategory = clips.byCategory && typeof clips.byCategory === 'object'
    ? clips.byCategory
    : {};
  const safetyConfirmed = source.passiveCapture === false
    && source.continuousRecording === false
    && source.feedsMemory === false
    && source.feedsRag === false
    && source.authorizesIdentity === false
    && cleanText(source.emotionAuthority, 40) === 'none'
    && (state !== 'ready' || (
      source.enabled === true
      && policy === 'explicit-opt-in-encrypted-local'
      && protection === 'windows-dpapi-current-user'
    ));
  const candidateId = cleanText(candidate.candidateId, 40).toLowerCase();
  const candidateIdValid = /^[a-f0-9]{32}$/.test(candidateId);
  const projectedCandidate = {
    available: safetyConfirmed && Boolean(candidate.available) && (!includeCandidateId || candidateIdValid),
    durationMs: Math.max(0, finiteNumber(candidate.durationMs) || 0),
    sampleRate: Math.max(0, finiteNumber(candidate.sampleRate) || 0),
    source: cleanText(candidate.source, 80),
    conversationMode: cleanText(candidate.conversationMode, 16) === 'dad' ? 'dad' : 'family',
    ageSeconds: Math.max(0, finiteNumber(candidate.ageSeconds) || 0),
    expiresInSeconds: Math.max(0, Math.min(600, finiteNumber(candidate.expiresInSeconds) || 0))
  };
  if (includeCandidateId && projectedCandidate.available) {
    projectedCandidate.candidateId = candidateId;
  }
  return {
    enabled: Boolean(source.enabled),
    state: safetyConfirmed ? state : 'unsafe',
    safetyConfirmed,
    policy,
    protection,
    passiveCapture: Boolean(source.passiveCapture),
    continuousRecording: Boolean(source.continuousRecording),
    feedsMemory: Boolean(source.feedsMemory),
    feedsRag: Boolean(source.feedsRag),
    authorizesIdentity: Boolean(source.authorizesIdentity),
    emotionAuthority: cleanText(source.emotionAuthority, 40) || 'unknown',
    candidate: projectedCandidate,
    clips: {
      count: Math.max(0, Number(clips.count) || 0),
      bytes: Math.max(0, Number(clips.bytes) || 0),
      corrupt: Math.max(0, Number(clips.corrupt) || 0),
      byCategory: Object.fromEntries(VOIX_MEDIA_VAULT_CATEGORIES.map((category) => [
        category,
        Math.max(0, Number(byCategory[category]) || 0)
      ])),
      nextExpiry: cleanText(clips.nextExpiry, 80),
      maxClips: Math.max(0, Number(clips.maxClips) || 0),
      maxBytes: Math.max(0, Number(clips.maxBytes) || 0)
    }
  };
}

function publicVoixMediaClip(value) {
  const source = value && typeof value === 'object' ? value : {};
  const clipId = cleanText(source.clipId, 40).toLowerCase();
  const category = cleanText(source.category, 40);
  const subjectKind = cleanText(source.subjectKind, 20);
  if (!/^[a-f0-9]{32}$/.test(clipId)) return null;
  if (!VOIX_MEDIA_VAULT_CATEGORIES.includes(category)) return null;
  if (!VOIX_MEDIA_VAULT_SUBJECTS.includes(subjectKind)) return null;
  const safetyConfirmed = source.authorizesIdentity === false
    && source.memoryEligible === false
    && source.ragEligible === false
    && cleanText(source.emotionAuthority, 40) === 'none';
  if (!safetyConfirmed) return null;
  return {
    clipId,
    category,
    label: cleanText(source.label, 120),
    speakerLabel: cleanText(source.speakerLabel, 120),
    subjectKind,
    guardianApproved: Boolean(source.guardianApproved),
    researchConsent: Boolean(source.researchConsent),
    createdAt: cleanText(source.createdAt, 80),
    expiresAt: cleanText(source.expiresAt, 80),
    retentionDays: Math.max(0, Number(source.retentionDays) || 0),
    durationMs: Math.max(0, finiteNumber(source.durationMs) || 0),
    sampleRate: Math.max(0, finiteNumber(source.sampleRate) || 0),
    identityStatus: 'user-labelled-unverified',
    authorizesIdentity: false,
    memoryEligible: false,
    ragEligible: false,
    emotionAuthority: 'none'
  };
}

function publicVoixSession(value) {
  const status = value && typeof value === 'object' ? value : {};
  const warmup = status.warmup && typeof status.warmup === 'object' ? status.warmup : {};
  const inputSignal = status.input_signal && typeof status.input_signal === 'object'
    ? status.input_signal
    : null;
  const memory = status.memory && typeof status.memory === 'object' ? status.memory : {};
  const wake = status.wake && typeof status.wake === 'object' ? status.wake : {};
  const archive = status.archive && typeof status.archive === 'object' ? status.archive : {};
  const mediaVault = status.mediaVault && typeof status.mediaVault === 'object'
    ? status.mediaVault
    : {};
  const conversation = status.conversation && typeof status.conversation === 'object'
    ? status.conversation
    : { mode: status.conversation_mode };
  return {
    sessionId: cleanText(status.session_id, 120),
    state: cleanText(status.state, 40),
    running: Boolean(status.running),
    brain: cleanText(status.brain, 40),
    turns: Math.max(0, Number(status.turns) || 0),
    lastTranscript: cleanText(status.last_transcript, 5000),
    lastReply: cleanText(status.last_reply, 5000),
    metrics: status.metrics ? publicVoixMetrics(status.metrics) : null,
    conversation: publicVoixConversation(conversation),
    memory: {
      enabled: Boolean(memory.enabled),
      state: cleanText(memory.state, 40) || (memory.enabled ? 'unknown' : 'disabled'),
      pending: Math.max(0, Number(memory.pending) || 0),
      acknowledged: Math.max(0, Number(memory.acknowledged) || 0),
      oldestPendingSeconds: Math.max(0, finiteNumber(memory.oldestPendingSeconds) || 0),
      attempts: Math.max(0, Number(memory.attempts) || 0),
      lastError: cleanText(memory.lastError, 200)
    },
    archive: {
      enabled: Boolean(archive.enabled),
      policy: cleanText(archive.policy, 80),
      rawAudio: Boolean(archive.rawAudio),
      transcripts: Boolean(archive.transcripts),
      responses: Boolean(archive.responses),
      ttsAudio: Boolean(archive.ttsAudio),
      camera: cleanText(archive.camera, 80)
    },
    mediaVault: publicVoixMediaVault(mediaVault),
    wake: {
      enabled: Boolean(wake.enabled),
      state: cleanText(wake.state, 40) || (wake.enabled ? 'unknown' : 'off'),
      followupSeconds: Math.max(0, Math.min(120, finiteNumber(wake.followupSeconds) || 0)),
      remainingSeconds: Math.max(0, Math.min(120, finiteNumber(wake.remainingSeconds) || 0)),
      policy: cleanText(wake.policy, 80),
      unrelatedSpeechStored: typeof wake.unrelatedSpeechStored === 'boolean'
        ? wake.unrelatedSpeechStored
        : null
    },
    inputSignal: inputSignal ? {
      rms: finiteNumber(inputSignal.rms),
      peak: finiteNumber(inputSignal.peak),
      vadProbability: finiteNumber(inputSignal.vad_probability),
      ageMs: finiteNumber(inputSignal.age_ms),
      energyDetected: Boolean(inputSignal.energy_detected),
      recentEnergy: Boolean(inputSignal.recent_energy),
      speechLikely: Boolean(inputSignal.speech_likely),
      suppressedForPlayback: Boolean(inputSignal.suppressed_for_playback)
    } : null,
    warmup: {
      state: cleanText(warmup.state, 40),
      stage: cleanText(warmup.stage, 40)
    }
  };
}

function publicVoixEvent(value) {
  const event = value && typeof value === 'object' ? value : {};
  const type = cleanText(event.type, 80);
  if (!PUBLIC_VOIX_EVENT_TYPES.has(type)) return null;
  const source = event.payload && typeof event.payload === 'object'
    ? { ...event.payload, ...event }
    : event;
  const projected = {
    type,
    sessionId: cleanText(event.session_id || event.session, 120),
    timestamp: cleanText(event.timestamp, 80)
  };
  const text = cleanText(source.text, 5000);
  if (text) projected.text = text;
  for (const key of ['state', 'status', 'brain', 'language', 'operation', 'persona', 'lane', 'input_device', 'output_device', 'input_device_configured', 'input_device_resolved', 'output_device_configured', 'output_device_resolved', 'provider', 'reason', 'message', 'task_type', 'model', 'host_key', 'routing_source', 'stage', 'barge_in_mode', 'event_id', 'turn_id', 'category']) {
    const cleaned = cleanText(source[key], key === 'message' ? 1000 : 160);
    if (cleaned) projected[key] = cleaned;
  }
  for (const key of ['ms', 'duration_ms', 'expires_in_seconds', 'rms', 'peak', 'sample_rate', 'completion_tokens', 'similarity', 'sequence', 'recalled', 'delivered', 'pending']) {
    const number = finiteNumber(source[key]);
    if (number !== null) projected[key] = number;
  }
  if (type === 'agent_tools') {
    projected.receipts = (Array.isArray(source.receipts) ? source.receipts : []).slice(-40).map(row => ({
      tool: cleanText(row.tool, 160), status: cleanText(row.status, 40), runId: cleanText(row.runId, 80)
    }));
  }
  if (Object.hasOwn(source, 'barge_in')) projected.barge_in = Boolean(source.barge_in);
  if (Object.hasOwn(source, 'barge_in_during_playback')) projected.barge_in_during_playback = Boolean(source.barge_in_during_playback);
  if (Object.hasOwn(source, 'tools_enabled')) projected.tools_enabled = source.conversation_mode === 'dad' && source.memory_owner === 'openclaw/main' && source.tools_enabled === true;
  if (type === 'media_clip_saved') projected.authorizes_identity = false;
  if (Object.hasOwn(source, 'conversation_mode')) {
    const conversation = publicVoixConversation({ mode: source.conversation_mode, memoryOwner: source.memory_owner, toolsEnabled: source.tools_enabled });
    projected.conversation_mode = conversation.mode;
    projected.memory_scope = conversation.scopeId;
    projected.memory_owner = conversation.memoryOwner;
    projected.speaker_identity = conversation.speakerIdentity;
    projected.authorizes_identity = false;
  }
  if (Object.hasOwn(source, 'input_device_is_default')) projected.input_device_is_default = Boolean(source.input_device_is_default);
  if (Object.hasOwn(source, 'output_device_is_default')) projected.output_device_is_default = Boolean(source.output_device_is_default);
  if (source.metrics) projected.metrics = publicVoixMetrics(source.metrics);
  return projected;
}

module.exports = {
  VOIX_TIMEOUT_MS,
  VOIX_MEDIA_VAULT_CATEGORIES,
  VOIX_MEDIA_VAULT_SUBJECTS,
  fetchWithTimeout,
  voixUrl,
  upstreamJson,
  readUpstreamJson,
  finiteNumber,
  publicVoixConfig,
  publicVoixConversation,
  publicVoixEvent,
  publicVoixMediaClip,
  publicVoixMediaVault,
  publicVoixMetrics,
  publicVoixSession
};
