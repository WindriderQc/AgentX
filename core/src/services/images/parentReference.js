'use strict';
const crypto = require('node:crypto');
const ImageOperation = require('../../../models/ImageOperation');
const { decode, reference } = require('./codec');
const TRANSFORM = 'decoded-pixels-to-png-v1';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

function validateParent(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'operationId') || !Object.hasOwn(value, 'sha256')
      || typeof value.operationId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value.operationId)
      || typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) {
    throw fail('Le parent doit désigner une opération et le SHA-256 de son original.');
  }
  return { operationId: value.operationId, sha256: value.sha256 };
}

async function resolveParent(parent, conversation, readBytes) {
  const op = await ImageOperation.findById(parent.operationId).lean();
  if (!op) throw fail('Image parent inconnue.', 404);
  if (conversation && !['surface', 'sessionId', 'packId', 'scopeId'].every(key => op?.conversation?.[key] === conversation[key])) {
    throw fail('Image parent inconnue dans cette conversation.', 404);
  }
  if (op.state !== 'completed' || op.runtimeRestored !== true || !op.artifact) {
    throw fail('Le parent doit être une image archivée et ses ressources restituées.', 409);
  }
  if (op.artifact.sha256 !== parent.sha256) throw fail('Le SHA-256 ne correspond pas à l’original parent.', 409);
  const { bytes } = await readBytes(parent.operationId);
  if (hash(bytes) !== parent.sha256) throw fail('L’intégrité de l’original parent ne peut pas être confirmée.', 503);
  let decoded;
  try {
    decoded = decode(bytes, 4194304);
    if (Math.max(decoded.width, decoded.height) / Math.min(decoded.width, decoded.height) > 8) throw new Error('Extreme aspect ratio');
  } catch {
    throw fail('L’original parent doit être un PNG/JPEG de 4 MP maximum, avec un ratio maximal de 8:1. Aucun redimensionnement automatique.');
  }
  return { bytes, parent: { ...parent, width: decoded.width, height: decoded.height } };
}

async function prepareReferences(originals, parent, conversation, readBytes) {
  const resolved = parent ? await resolveParent(parent, conversation, readBytes) : null;
  const sources = [...(resolved ? [resolved.bytes] : []), ...originals];
  const references = sources.map(reference);
  return { references, ...(sources.length && { lineage: { version: 1,
    ...(resolved && { parent: resolved.parent }),
    references: sources.map((bytes, index) => ({ sourceSha256: hash(bytes), workerSha256: hash(references[index]),
      transform: TRANSFORM, ...(resolved && index === 0 && { parentOperationId: parent.operationId }) })) } }) };
}

module.exports = { TRANSFORM, validateParent, prepareReferences };
