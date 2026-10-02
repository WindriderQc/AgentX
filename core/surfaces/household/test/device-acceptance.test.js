'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const acceptance = require('../device-acceptance');

const NOW = new Date('2026-08-27T08:00:00.000Z');
const STARTED = '2026-08-27T07:30:00.000Z';

function validBody() {
  return {
    runId: '12345678-1234-4234-8234-123456789abc',
    deviceLabel: 'Household Surface',
    confirmedBy: 'Dad',
    startedAt: STARTED,
    origin: 'https://192.0.2.10',
    clientInfo: {
      platform: 'Windows',
      locale: 'fr-CA',
      viewportWidth: 1440,
      viewportHeight: 960,
      devicePixelRatio: 1.25,
      secureContext: true
    },
    checks: acceptance.CHECKS.map((check, index) => ({
      id: check.id,
      passed: true,
      evidenceCode: `${check.mode}:${check.id}`,
      observedAt: `2026-08-27T07:${String(31 + index).padStart(2, '0')}:00.000Z`
    }))
  };
}

test('Phase 0 contract separates browser observations, adult confirmations, privacy, and the separately accepted wake gate', () => {
  const contract = acceptance.contract();
  assert.equal(contract.phase, 'surface-phase0-v1');
  assert.equal(contract.status, 'physical_acceptance_pending');
  assert.ok(contract.checks.length >= 15);
  assert.ok(contract.checks.some((check) => check.id === 'microphone_transcription' && check.mode === 'observed'));
  assert.ok(contract.checks.some((check) => check.id === 'kiosk_launch' && check.mode === 'confirmed'));
  assert.equal(contract.checks.every((check) => check.required === true), true);
  assert.equal(contract.privacy.rawAudioPersisted, false);
  assert.equal(contract.privacy.transcriptPersisted, false);
  assert.equal(contract.wakeWord.required, false);
  assert.equal(contract.wakeWord.status, 'available_outside_phase0');
  assert.equal(contract.latest, null);
});

test('complete physical evidence becomes a deterministic, bounded Phase 0 receipt', () => {
  const first = acceptance.buildReceipt(validBody(), NOW);
  const second = acceptance.buildReceipt(validBody(), NOW);
  assert.equal(first.phase, 'surface-phase0-v1');
  assert.equal(first.status, 'phase0_passed');
  assert.equal(first.checks.length, acceptance.CHECKS.length);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(first.origin, 'https://192.0.2.10');
  assert.equal(first.checks.find((check) => check.id === 'speaker_playback').mode, 'observed');
  assert.equal(first.checks.find((check) => check.id === 'output_mute').mode, 'observed');
  assert.equal(Object.prototype.hasOwnProperty.call(first, 'rawAudio'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(first, 'transcript'), false);
  assert.equal(first.checks.every((check) => check.evidenceCode === `${check.mode}:${check.id}`), true);
  assert.equal(first.checks.every((check) => !Object.prototype.hasOwnProperty.call(check, 'localDetail')), true);
  assert.equal(first.checks.every((check) => !Object.prototype.hasOwnProperty.call(check, 'audio')), true);
  assert.equal(first.checks.every((check) => !Object.prototype.hasOwnProperty.call(check, 'transcript')), true);
});

test('receipt is fail closed when any required physical check is missing or false', () => {
  const missing = validBody();
  missing.checks = missing.checks.filter((check) => check.id !== 'offline_recovery');
  assert.throws(
    () => acceptance.buildReceipt(missing, NOW),
    (error) => error.code === 'DEVICE_ACCEPTANCE_INCOMPLETE' && error.status === 409 && /offline_recovery/.test(error.message)
  );

  const failed = validBody();
  failed.checks.find((check) => check.id === 'touch_input').passed = false;
  assert.throws(
    () => acceptance.buildReceipt(failed, NOW),
    (error) => error.code === 'DEVICE_ACCEPTANCE_INCOMPLETE' && /touch_input/.test(error.message)
  );
});

test('receipt rejects insecure, stale, unknown, and privacy-bearing submissions', () => {
  const insecure = validBody();
  insecure.origin = 'http://192.0.2.10:3080';
  assert.throws(() => acceptance.buildReceipt(insecure, NOW), /trusted HTTPS origin/);

  const stale = validBody();
  stale.startedAt = '2026-08-26T12:00:00.000Z';
  assert.throws(
    () => acceptance.buildReceipt(stale, NOW),
    (error) => error.code === 'DEVICE_ACCEPTANCE_STALE'
  );

  const unknown = validBody();
  unknown.checks.push({ id: 'wake_word', passed: true, evidenceCode: 'observed:wake_word', observedAt: NOW.toISOString() });
  assert.throws(() => acceptance.buildReceipt(unknown, NOW), /Unknown physical check/);

  const audio = validBody();
  audio.rawAudio = 'base64-is-never-accepted';
  assert.throws(
    () => acceptance.buildReceipt(audio, NOW),
    (error) => error.code === 'DEVICE_ACCEPTANCE_PRIVACY_REJECTED'
  );

  const transcript = validBody();
  transcript.transcript = 'recognized private words';
  assert.throws(
    () => acceptance.buildReceipt(transcript, NOW),
    (error) => error.code === 'DEVICE_ACCEPTANCE_PRIVACY_REJECTED'
  );

  const nestedTranscript = validBody();
  nestedTranscript.checks[0].evidence = 'recognized private words';
  assert.throws(
    () => acceptance.buildReceipt(nestedTranscript, NOW),
    (error) => error.code === 'DEVICE_ACCEPTANCE_PRIVACY_REJECTED'
  );
});

test('public receipt exposes evidence and fingerprint but no database metadata', () => {
  const receipt = acceptance.buildReceipt(validBody(), NOW);
  const projected = acceptance.publicReceipt({ _id: 'private-row', createdAt: NOW, ...receipt });
  assert.equal(projected.fingerprint, receipt.fingerprint);
  assert.equal(projected.checks.length, acceptance.CHECKS.length);
  assert.equal(Object.prototype.hasOwnProperty.call(projected, '_id'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(projected, 'createdAt'), false);
});
