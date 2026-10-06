'use strict';

// Two small readings of a spoken request: the words that ask to forget a
// note, and the upload field name the speech service expects.

function cleanText(value, max = 4000) {
  return String(value || '').trim().slice(0, max);
}

const VOIX_LEGACY_AUDIO_FIELD = Buffer.from('name="audio"; filename=');
const VOIX_NATIVE_FILE_FIELD = Buffer.from('name="file"; filename=');

function forgetMemoryStatement(text) {
  const value = cleanText(text, 500);
  if (!/^(?:nestor[, ]+)?(?:s['’]il\s+te\s+pla[iî]t[, ]*)?(?:oublie[sz]?|efface[rz]?\s+(?:de\s+)?(?:ta\s+)?m[ée]moire|forget|remove\s+from\s+(?:your\s+)?memory)\b/i.test(value)) return '';
  return value
    .replace(/^(?:nestor[, ]+)?(?:s['’]il\s+te\s+pla[iî]t[, ]*)?(?:oublie[sz]?|efface[rz]?\s+(?:de\s+)?(?:ta\s+)?m[ée]moire|forget|remove\s+from\s+(?:your\s+)?memory)\s*(?:que|that|:|-)?\s*/i, '')
    .trim();
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

module.exports = { forgetMemoryStatement, normalizeVoixTranscriptionMultipart };
