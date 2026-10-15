'use strict';
const crypto = require('node:crypto');
const ImageOperation = require('../../../models/ImageOperation');
const { decode, referenceWithin } = require('./codec');
const { limits, MAX_OUTPUT_PIXELS } = require('./sizes');
const TRANSFORM = 'decoded-pixels-to-png-v1';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

function validateParent(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'operationId') || !Object.hasOwn(value, 'sha256')
      || typeof value.operationId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value.operationId)
      || typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) {
    throw fail('The parent must name an operation and the SHA-256 of its original.');
  }
  return { operationId: value.operationId, sha256: value.sha256 };
}

async function resolveParent(parent, conversation, readBytes, { atelierOnly = false } = {}) {
  const op = await ImageOperation.findById(parent.operationId).lean();
  if (!op) throw fail('Image parent inconnue.', 404);
  if (atelierOnly && op.conversation) throw fail('Unknown parent image in the Atelier library.', 404);
  if (conversation && !['surface', 'sessionId', 'packId', 'scopeId'].every(key => op?.conversation?.[key] === conversation[key])) {
    throw fail('Unknown parent image in this conversation.', 404);
  }
  if (op.state !== 'completed' || op.runtimeRestored !== true || !op.artifact) {
    throw fail('The parent must be an archived image with its resources returned.', 409);
  }
  if (op.artifact.sha256 !== parent.sha256) throw fail('The SHA-256 does not match the parent original.', 409);
  const { bytes } = await readBytes(parent.operationId);
  if (hash(bytes) !== parent.sha256) throw fail('The integrity of the parent original cannot be confirmed.', 503);
  let decoded;
  try {
    const ceiling = limits(op.profile?.family).maxPixels;
    decoded = decode(bytes, Math.min(op.profile?.maxPixels || ceiling, ceiling));
    if (Math.max(decoded.width, decoded.height) / Math.min(decoded.width, decoded.height) > 8) throw new Error('Extreme aspect ratio');
  } catch {
    throw fail('The parent original must be a PNG/JPEG within its recipe limits, with a maximum aspect ratio of 8:1. No automatic resizing.');
  }
  return { bytes, artifact: op.artifact, parent: { ...parent, width: decoded.width, height: decoded.height } };
}

async function prepareReferences(originals, parent, conversation, readBytes) {
  const resolved = parent ? await resolveParent(parent, conversation, readBytes) : null;
  const sources = [...(resolved ? [resolved.bytes] : []), ...originals];
  const references = sources.map((bytes, index) => referenceWithin(bytes, resolved && index === 0 ? MAX_OUTPUT_PIXELS : 4194304));
  return { sources, references, ...(resolved && { parentArtifact: resolved.artifact }), ...(sources.length && { lineage: { version: 1,
    ...(resolved && { parent: resolved.parent }),
    references: sources.map((bytes, index) => ({ sourceSha256: hash(bytes), workerSha256: hash(references[index]),
      transform: TRANSFORM, ...(resolved && index === 0 && { parentOperationId: parent.operationId }) })) } }) };
}

module.exports = { TRANSFORM, validateParent, resolveParent, prepareReferences };
