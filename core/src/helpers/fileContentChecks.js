'use strict';
const { createHash } = require('node:crypto');

// Byte-level checks shared by the stores that keep user or worker files in
// Core (conversation attachments, task deliverables). Each store keeps its own
// limits, messages and ownership; these helpers only say what the bytes are.
const MIME_TYPES = new Set(['image/png', 'image/jpeg', 'text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/pdf']);
const DATA_URL_RE = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/;
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const JPEG = Buffer.from('ffd8ff', 'hex');

const sha256 = data => createHash('sha256').update(data).digest('hex');
const maxDataUrlLength = maxBytes => Math.ceil(maxBytes / 3) * 4 + 100;

// Returns null for a malformed data URL. `canonical` is false when the
// base64 text does not round-trip, which hides smuggled or truncated bytes.
function parseDataUrl(dataUrl) {
  const match = DATA_URL_RE.exec(dataUrl);
  if (!match) return null;
  const [, mimeType, encoded] = match;
  const data = Buffer.from(encoded, 'base64');
  return { mimeType, data, canonical: data.toString('base64') === encoded };
}
function imageSignatureMatches(mimeType, data) {
  if (mimeType === 'image/png') return data.subarray(0, 8).equals(PNG);
  if (mimeType === 'image/jpeg') return data.subarray(0, 3).equals(JPEG);
  return true;
}
const isPdf = data => data.subarray(0, 5).toString() === '%PDF-';
// Strict UTF-8 text without binary control characters: { text } or { error }.
function decodeText(data) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { return { error: 'utf8' }; }
  return /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text) ? { error: 'binary' } : { text };
}
function isJson(text) {
  try { JSON.parse(text); return true; } catch { return false; }
}

module.exports = { MIME_TYPES, sha256, maxDataUrlLength, parseDataUrl, imageSignatureMatches, isPdf, decodeText, isJson };
