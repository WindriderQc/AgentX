'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { transcriptionMetadata } = require('../../../src/services/voice/transcription-metadata');
const { AudioHistory } = require('../../../public/js/voice/browser-conversation');

test('recognition evidence crosses the private adapter with numerical diagnostics and no arbitrary payload', () => {
  const recognitionId = '550e8400-e29b-41d4-a716-446655440000';
  assert.deepEqual(transcriptionMetadata({ recognitionId }), { recognitionId });
  assert.deepEqual(transcriptionMetadata({ recognitionId: 'private-path' }), {});
  const recognition = { schema: 1, requestedLanguage: 'fr', decodedLanguage: 'fr', languageSource: 'requested',
    device: 'cuda', computeType: 'int8_float16', audioSeconds: 2, speechSeconds: 0.6, segments: 1,
    avgLogProbability: -0.2, maxNoSpeechProbability: 0.1, maxCompressionRatio: 1.3,
    queueMs: 40, decodeMs: 100, normalizationChanged: false };
  assert.deepEqual(transcriptionMetadata({ recognition: { ...recognition, rawAudio: 'private', text: 'private', path: 'private' } }), { recognition });
  assert.deepEqual(transcriptionMetadata({ recognition: { schema: 1, queueMs: NaN, decodeMs: -1,
    device: 'private-path', maxNoSpeechProbability: 4, decodedLanguage: 'private-path', normalizationChanged: 'false' } }), { recognition: { schema: 1 } });
  assert.deepEqual(transcriptionMetadata({ recognition: { schema: 2 } }), {});
});

test('ephemeral audio review keeps requested and decoded languages separate and clears all evidence with the clip', () => {
  const history = new AudioHistory(1000, () => 0);
  history.push(new Float32Array(100));
  const clip = history.freeze('utterance');
  try {
    history.transcription(clip.id, 'transcribed', 'Bonjour', { language: 'auto', detectedLanguage: 'fr',
      effectiveModel: 'recognizer', bytes: 100, captureBytes: 200, recognitionMode: 'early',
      recognition: { schema: 1, queueMs: 40, decodeMs: 100, audioSeconds: 2, speechSeconds: 0.6,
        languageSource: 'detected', privateText: 'private', invalid: NaN } });
    assert.deepEqual(history.last().attempt, { language: 'auto', detectedLanguage: 'fr', effectiveModel: 'recognizer',
      bytes: 100, captureBytes: 200, recognitionMode: 'early', recognition: {
        queueMs: 40, decodeMs: 100, audioSeconds: 2, speechSeconds: 0.6, languageSource: 'detected' } });
  } finally { history.clear(); }
  assert.equal(history.last(), null);
  assert.equal(clip.samples.every(value => value === 0), true);
});
