'use strict';

// Recognition evidence crosses surface adapters without arbitrary upstream data.
// Missing or invalid evidence stays absent; no confidence or timing is invented.
function transcriptionMetadata(result = {}) {
  const metadata = {};
  if (typeof result.recognitionId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(result.recognitionId)) metadata.recognitionId = result.recognitionId;
  for (const key of ['model', 'effectiveModel', 'requestedModel', 'detectedLanguage']) {
    const value = result[key];
    if (typeof value === 'string' && value.length > 0 && value.length <= 512) metadata[key] = value;
  }
  if (result.requestedModel === null) metadata.requestedModel = null;
  if (typeof result.sttMs === 'number' && Number.isFinite(result.sttMs) && result.sttMs >= 0) {
    metadata.sttMs = Math.round(result.sttMs);
  }
  const evidence = result.recognition;
  if (evidence?.schema === 1) {
    const recognition = { schema: 1 };
    const choices = { requestedLanguage: ['fr', 'en', 'auto', 'fr-en'], languageSource: ['requested', 'detected', 'constrained'],
      device: ['cpu', 'cuda'], computeType: ['float32', 'float16', 'int8', 'int8_float16', 'int8_float32', 'bfloat16', 'int8_bfloat16'] };
    for (const [key, allowed] of Object.entries(choices)) if (allowed.includes(evidence[key])) recognition[key] = evidence[key];
    if (typeof evidence.decodedLanguage === 'string' && /^[a-z]{2,3}$/.test(evidence.decodedLanguage)) recognition.decodedLanguage = evidence.decodedLanguage;
    for (const [key, low, high] of [['audioSeconds', 0, 86400], ['speechSeconds', 0, 86400], ['queueMs', 0, 3600000],
      ['decodeMs', 0, 3600000], ['segments', 0, 100000], ['avgLogProbability', -100, 0],
      ['maxNoSpeechProbability', 0, 1], ['maxCompressionRatio', 0, 100]]) {
      const value = evidence[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high) recognition[key] = value;
    }
    if (typeof evidence.normalizationChanged === 'boolean') recognition.normalizationChanged = evidence.normalizationChanged;
    metadata.recognition = recognition;
  }
  return metadata;
}

module.exports = { transcriptionMetadata };
