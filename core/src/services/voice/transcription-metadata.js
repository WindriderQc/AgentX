'use strict';

// Recognition evidence crosses surface adapters without arbitrary upstream data.
// Missing or invalid evidence stays absent; no confidence or timing is invented.
function transcriptionMetadata(result = {}) {
  const metadata = {};
  for (const key of ['model', 'effectiveModel', 'requestedModel', 'detectedLanguage']) {
    const value = result[key];
    if (typeof value === 'string' && value.length > 0 && value.length <= 512) metadata[key] = value;
  }
  if (result.requestedModel === null) metadata.requestedModel = null;
  if (typeof result.sttMs === 'number' && Number.isFinite(result.sttMs) && result.sttMs >= 0) {
    metadata.sttMs = Math.round(result.sttMs);
  }
  return metadata;
}

module.exports = { transcriptionMetadata };
