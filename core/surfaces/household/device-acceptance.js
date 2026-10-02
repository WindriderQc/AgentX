'use strict';

const crypto = require('crypto');

const PHASE = 'surface-phase0-v1';
const MAX_RUN_AGE_MS = 12 * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;

const CHECKS = Object.freeze([
  Object.freeze({ id: 'trusted_https', label: 'Trusted HTTPS and secure browser context', mode: 'observed' }),
  Object.freeze({ id: 'viewport_layout', label: 'Panel fits the physical display without horizontal overflow', mode: 'observed' }),
  Object.freeze({ id: 'microphone_transcription', label: 'Microphone capture reaches local transcription', mode: 'observed' }),
  Object.freeze({ id: 'microphone_mute', label: 'Microphone mute discards an active capture', mode: 'observed' }),
  Object.freeze({ id: 'speaker_playback', label: 'Local Nestor speech is audible from the intended speaker', mode: 'observed' }),
  Object.freeze({ id: 'output_mute', label: 'Output mute stops active speech immediately', mode: 'observed' }),
  Object.freeze({ id: 'touch_input', label: 'Touch input is detected on the physical screen', mode: 'observed' }),
  Object.freeze({ id: 'keyboard_input', label: 'Keyboard fallback works', mode: 'observed' }),
  Object.freeze({ id: 'offline_recovery', label: 'A real offline/online cycle recovers without restarting the browser', mode: 'observed' }),
  Object.freeze({ id: 'resume_recovery', label: 'The panel recovers after sleep, lock, or app resume', mode: 'observed' }),
  Object.freeze({ id: 'kiosk_launch', label: 'Cold boot reaches full-screen Panel with no certificate warning', mode: 'confirmed' }),
  Object.freeze({ id: 'reader_journal', label: 'Reader and Journal work by touch and keyboard', mode: 'confirmed' }),
  Object.freeze({ id: 'secretary_flow', label: 'A unique disposable personal task passes two-touch completion', mode: 'confirmed' }),
  Object.freeze({ id: 'output_device', label: 'Playback follows a changed Windows default output device', mode: 'confirmed' }),
  Object.freeze({ id: 'family_surface', label: 'Family home hides operator detail when diagnostics are closed', mode: 'confirmed' }),
  Object.freeze({ id: 'admin_verifier', label: 'The post-reboot admin verifier reports every automated check passed', mode: 'confirmed' })
]);

const TOP_LEVEL_KEYS = new Set(['runId', 'deviceLabel', 'confirmedBy', 'startedAt', 'origin', 'clientInfo', 'checks']);
const CLIENT_KEYS = new Set(['platform', 'locale', 'viewportWidth', 'viewportHeight', 'devicePixelRatio', 'secureContext']);
const CHECK_KEYS = new Set(['id', 'passed', 'evidenceCode', 'observedAt']);

function acceptanceError(message, code = 'DEVICE_ACCEPTANCE_INVALID', status = 400, details) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  if (details) error.details = details;
  return error;
}

function cleanText(value, max) {
  return String(value || '').trim().slice(0, max);
}

function unknownKeys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value).filter((key) => !allowed.has(key));
}

function validDate(value, name, now, earliest) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw acceptanceError(`${name} must be an ISO timestamp`);
  if (date.getTime() > now.getTime() + FUTURE_SKEW_MS) throw acceptanceError(`${name} cannot be in the future`);
  if (earliest && date.getTime() < earliest.getTime() - FUTURE_SKEW_MS) {
    throw acceptanceError(`${name} predates this acceptance run`);
  }
  return date;
}

function boundedNumber(value, minimum, maximum, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw acceptanceError(`${name} is outside the accepted range`);
  }
  return Math.round(number * 100) / 100;
}

function publicReceipt(value) {
  if (!value) return null;
  const row = typeof value.toObject === 'function' ? value.toObject() : value;
  return {
    phase: row.phase,
    status: row.status,
    runId: row.runId,
    deviceLabel: row.deviceLabel,
    confirmedBy: row.confirmedBy,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    origin: row.origin,
    clientInfo: row.clientInfo,
    checks: Array.isArray(row.checks) ? row.checks.map((check) => ({
      id: check.id,
      label: check.label,
      mode: check.mode,
      passed: check.passed === true,
      evidenceCode: check.evidenceCode,
      observedAt: check.observedAt
    })) : [],
    fingerprint: row.fingerprint
  };
}

function contract(latest = null) {
  return {
    phase: PHASE,
    status: latest?.status || 'physical_acceptance_pending',
    checks: CHECKS.map((check) => ({ ...check, required: true })),
    privacy: {
      rawAudioPersisted: false,
      transcriptPersisted: false,
      evidenceOnly: true
    },
    wakeWord: {
      required: false,
      status: 'available_outside_phase0',
      note: 'The native VoiX wake gate is accepted separately and does not count toward this Surface Phase 0 push-to-talk receipt.'
    },
    latest: publicReceipt(latest)
  };
}

function buildReceipt(body, nowValue = new Date()) {
  const now = new Date(nowValue);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw acceptanceError('receipt body is required');

  const extraTopLevel = unknownKeys(body, TOP_LEVEL_KEYS);
  if (extraTopLevel.length) {
    const privacyKey = extraTopLevel.some((key) => /audio|transcript|prompt|reply/i.test(key));
    throw acceptanceError(
      `Unsupported receipt field(s): ${extraTopLevel.join(', ')}`,
      privacyKey ? 'DEVICE_ACCEPTANCE_PRIVACY_REJECTED' : 'DEVICE_ACCEPTANCE_INVALID'
    );
  }

  const runId = cleanText(body.runId, 80);
  if (!/^[a-f0-9-]{20,80}$/i.test(runId)) throw acceptanceError('runId is invalid');
  const deviceLabel = cleanText(body.deviceLabel, 80);
  const confirmedBy = cleanText(body.confirmedBy, 60);
  if (deviceLabel.length < 2) throw acceptanceError('deviceLabel is required');
  if (confirmedBy.length < 2) throw acceptanceError('confirmedBy is required');

  const startedAt = validDate(body.startedAt, 'startedAt', now);
  if (now.getTime() - startedAt.getTime() > MAX_RUN_AGE_MS) {
    throw acceptanceError('Acceptance run is older than 12 hours; start a fresh physical check', 'DEVICE_ACCEPTANCE_STALE');
  }

  let origin;
  try { origin = new URL(String(body.origin || '')); } catch { throw acceptanceError('origin must be a valid URL'); }
  if (origin.protocol !== 'https:') throw acceptanceError('Physical acceptance requires the trusted HTTPS origin');

  const clientInfo = body.clientInfo;
  if (!clientInfo || typeof clientInfo !== 'object' || Array.isArray(clientInfo)) throw acceptanceError('clientInfo is required');
  const extraClient = unknownKeys(clientInfo, CLIENT_KEYS);
  if (extraClient.length) throw acceptanceError(`Unsupported clientInfo field(s): ${extraClient.join(', ')}`);
  if (clientInfo.secureContext !== true) throw acceptanceError('secureContext must be true');
  const normalizedClient = {
    platform: cleanText(clientInfo.platform, 80) || 'unknown',
    locale: cleanText(clientInfo.locale, 24) || 'unknown',
    viewportWidth: boundedNumber(clientInfo.viewportWidth, 240, 10000, 'viewportWidth'),
    viewportHeight: boundedNumber(clientInfo.viewportHeight, 240, 10000, 'viewportHeight'),
    devicePixelRatio: boundedNumber(clientInfo.devicePixelRatio, 0.5, 8, 'devicePixelRatio'),
    secureContext: true
  };

  if (!Array.isArray(body.checks)) throw acceptanceError('checks must be an array');
  const supplied = new Map();
  for (const entry of body.checks) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw acceptanceError('Every check must be an object');
    const extraCheck = unknownKeys(entry, CHECK_KEYS);
    if (extraCheck.length) {
      const privacyKey = extraCheck.some((key) => /audio|transcript|prompt|reply|evidence/i.test(key));
      throw acceptanceError(
        `Unsupported check field(s): ${extraCheck.join(', ')}`,
        privacyKey ? 'DEVICE_ACCEPTANCE_PRIVACY_REJECTED' : 'DEVICE_ACCEPTANCE_INVALID'
      );
    }
    const id = cleanText(entry.id, 64);
    if (supplied.has(id)) throw acceptanceError(`Duplicate check: ${id}`);
    supplied.set(id, entry);
  }

  const normalizedChecks = CHECKS.map((requirement) => {
    const entry = supplied.get(requirement.id);
    if (!entry || entry.passed !== true) {
      throw acceptanceError(`Required physical check has not passed: ${requirement.id}`, 'DEVICE_ACCEPTANCE_INCOMPLETE', 409);
    }
    const evidenceCode = cleanText(entry.evidenceCode, 100);
    const expectedEvidenceCode = `${requirement.mode}:${requirement.id}`;
    if (evidenceCode !== expectedEvidenceCode) {
      throw acceptanceError(`Exact evidenceCode is required for ${requirement.id}`);
    }
    const observedAt = validDate(entry.observedAt, `${requirement.id}.observedAt`, now, startedAt);
    return {
      id: requirement.id,
      label: requirement.label,
      mode: requirement.mode,
      passed: true,
      evidenceCode,
      observedAt
    };
  });
  const unknownChecks = [...supplied.keys()].filter((id) => !CHECKS.some((check) => check.id === id));
  if (unknownChecks.length) throw acceptanceError(`Unknown physical check(s): ${unknownChecks.join(', ')}`);

  const receipt = {
    phase: PHASE,
    status: 'phase0_passed',
    runId,
    deviceLabel,
    confirmedBy,
    startedAt,
    completedAt: now,
    origin: origin.origin,
    clientInfo: normalizedClient,
    checks: normalizedChecks
  };
  receipt.fingerprint = crypto.createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
  return receipt;
}

module.exports = {
  CHECKS,
  PHASE,
  buildReceipt,
  contract,
  publicReceipt
};
