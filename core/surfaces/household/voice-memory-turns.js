'use strict';

// Native voice memory turns: the turn and transcription payload contracts,
// and the explicit, forget and inferred memory statements a turn can carry.

const crypto = require('crypto');
const { detectMemoryRequest } = require('./persona-prompt');

function cleanText(value, max = 4000) {
  return String(value || '').trim().slice(0, max);
}

const VOIX_LEGACY_AUDIO_FIELD = Buffer.from('name="audio"; filename=');
const VOIX_NATIVE_FILE_FIELD = Buffer.from('name="file"; filename=');
const VOIX_MEMORY_SCHEMA_VERSION = 1;
const VOIX_MEMORY_SCOPE_ID = 'personal';

function stableVoixTraceId(sessionId, turnId) {
  return `voix:${cleanText(sessionId, 120)}:${cleanText(turnId, 120)}`;
}

function explicitMemoryStatement(text) {
  if (!detectMemoryRequest(text)) return '';
  return cleanText(text, 4000)
    .replace(/^(?:nestor[, ]+)?(?:s['’]il\s+te\s+pla[iî]t[, ]*)?(?:retiens(?:\s+ceci)?|souviens-toi|souvenez-vous|rappelle-toi|rappelez-vous|garde[sz]?\s+en\s+m[ée]moire|note[sz]?|prends?\s+note)\s*(?:que|:|-)?\s*/i, '')
    .replace(/^(?:please\s+)?(?:remember(?:\s+that|\s+this)?|don'?t\s+forget|do\s+not\s+forget|keep\s+in\s+mind|make\s+a\s+note)\s*(?:that|:|-)?\s*/i, '')
    .trim();
}

function forgetMemoryStatement(text) {
  const value = cleanText(text, 500);
  if (!/^(?:nestor[, ]+)?(?:s['’]il\s+te\s+pla[iî]t[, ]*)?(?:oublie[sz]?|efface[rz]?\s+(?:de\s+)?(?:ta\s+)?m[ée]moire|forget|remove\s+from\s+(?:your\s+)?memory)\b/i.test(value)) return '';
  return value
    .replace(/^(?:nestor[, ]+)?(?:s['’]il\s+te\s+pla[iî]t[, ]*)?(?:oublie[sz]?|efface[rz]?\s+(?:de\s+)?(?:ta\s+)?m[ée]moire|forget|remove\s+from\s+(?:your\s+)?memory)\s*(?:que|that|:|-)?\s*/i, '')
    .trim();
}

function normalizeVoixMemoryTurn(body = {}) {
  if (Number(body.schemaVersion) !== VOIX_MEMORY_SCHEMA_VERSION) {
    const error = new Error(`schemaVersion must be ${VOIX_MEMORY_SCHEMA_VERSION}`);
    error.statusCode = 400;
    error.code = 'VOIX_MEMORY_SCHEMA_UNSUPPORTED';
    throw error;
  }
  const sessionId = cleanText(body.sessionId, 120);
  const turnId = cleanText(body.turnId, 120);
  const eventId = cleanText(body.eventId, 260);
  const expectedEventId = stableVoixTraceId(sessionId, turnId);
  const userText = cleanText(body.userText, 4000);
  const assistantText = cleanText(body.assistantText, 5000);
  const sequence = Number(body.sequence);
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(sessionId)
      || !/^[a-zA-Z0-9_-]{1,120}$/.test(turnId)
      || eventId !== expectedEventId
      || !Number.isInteger(sequence) || sequence < 1
      || !userText || !assistantText) {
    const error = new Error('valid eventId, sessionId, turnId, sequence, userText and assistantText are required');
    error.statusCode = 400;
    error.code = 'VOIX_MEMORY_TURN_INVALID';
    throw error;
  }
  const completedAt = new Date(body.completedAt);
  if (Number.isNaN(completedAt.getTime())) {
    const error = new Error('completedAt must be an ISO timestamp');
    error.statusCode = 400;
    error.code = 'VOIX_MEMORY_TURN_INVALID';
    throw error;
  }
  return {
    eventId,
    sessionId,
    turnId,
    sequence,
    scopeId: VOIX_MEMORY_SCOPE_ID,
    persona: cleanText(body.persona || 'default_chat', 80),
    ...(Number.isInteger(body.personaVersion) && body.personaVersion > 0 ? { personaVersion: body.personaVersion } : {}),
    language: cleanText(body.language || 'fr', 16),
    userText,
    assistantText,
    completedAt,
    metrics: body.metrics && typeof body.metrics === 'object' && !Array.isArray(body.metrics)
      ? body.metrics : {}
  };
}

function inferredMemoryCandidate(text) {
  const statement = cleanText(text, 500);
  if (!statement || detectMemoryRequest(statement)) return null;
  const rules = [
    { type: 'preference', confidence: 0.88, pattern: /(?:^|\s)(je pr[ée]f[èe]re|j['’]aime mieux|je veux que tu|i prefer|i would rather|please always)(?=\s|[,.!?]|$)/i },
    { type: 'decision', confidence: 0.86, pattern: /(?:^|\s)(j['’]ai d[ée]cid[ée]|nous avons d[ée]cid[ée]|on a d[ée]cid[ée]|i decided|we decided)(?=\s|[,.!?]|$)/i },
    { type: 'correction', confidence: 0.82, pattern: /(?:^|\s)(en fait|correction|ce n['’]est pas .+ mais|actually|that['’]s not right|not .+ but)(?=\s|[,.!?]|$)/i }
  ];
  const matched = rules.find((rule) => rule.pattern.test(statement));
  if (!matched) return null;
  return {
    type: matched.type,
    statement,
    confidence: matched.confidence,
    rationale: 'Candidate inferred from a completed Dad voice turn; requires individual review.'
  };
}

function voiceMemoryCandidateId(traceId, type, statement) {
  return crypto.createHash('sha256')
    .update(`${traceId}\n${type}\n${cleanText(statement, 500).toLowerCase()}`)
    .digest('hex')
    .slice(0, 32);
}

function normalizeVoixTranscriptionMultipart(body, contentType = '') {
  if (!Buffer.isBuffer(body) || !/^multipart\/form-data\s*;/i.test(String(contentType || ''))) return body;
  if (body.indexOf(VOIX_NATIVE_FILE_FIELD) >= 0) return body;
  const legacyIndex = body.indexOf(VOIX_LEGACY_AUDIO_FIELD);
  if (legacyIndex < 0) return body;
  return Buffer.concat([
    body.subarray(0, legacyIndex),
    VOIX_NATIVE_FILE_FIELD,
    body.subarray(legacyIndex + VOIX_LEGACY_AUDIO_FIELD.length)
  ]);
}

module.exports = {
  VOIX_LEGACY_AUDIO_FIELD,
  VOIX_NATIVE_FILE_FIELD,
  VOIX_MEMORY_SCHEMA_VERSION,
  VOIX_MEMORY_SCOPE_ID,
  stableVoixTraceId,
  explicitMemoryStatement,
  forgetMemoryStatement,
  normalizeVoixMemoryTurn,
  inferredMemoryCandidate,
  voiceMemoryCandidateId,
  normalizeVoixTranscriptionMultipart
};
