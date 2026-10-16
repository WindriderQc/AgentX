'use strict';
const { createHash } = require('node:crypto');
const attachments = require('../conversationAttachmentService');
const { sniff, MAX_BYTES: MAX_ORIGINAL_BYTES } = require('../imageArchive');
const { MAX_IMAGE_BYTES } = require('../imageAnalysisService');
const { validateParent, resolveParent } = require('./parentReference');
const { decode } = require('./codec');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const SHA = /^[a-f0-9]{64}$/;
function selectors(value) {
  if (!Array.isArray(value) || value.length > 2) throw fail('Choose at most two ordered references.');
  const result = value.map((row, position) => {
    if (!row || !SHA.test(row.sha256 || '')) throw fail('A reference requires its exact SHA-256.');
    if (row.kind === 'parent') {
      if (position !== 0) throw fail('The archived parent must be reference 1.');
      return { kind: 'parent', ...validateParent({ operationId: row.operationId, sha256: row.sha256 }) };
    }
    if (!['upload', 'sketch'].includes(row.kind) || !/^[a-f0-9]{24}$/.test(row.attachmentId || '')) throw fail('Invalid selected attachment.');
    if (row.kind === 'sketch' && position !== value.length - 1) throw fail('The composition sketch must be the last reference.');
    return { kind: row.kind, attachmentId: row.attachmentId, sha256: row.sha256 };
  });
  if (new Set(result.map(row => row.operationId || row.attachmentId)).size !== result.length) throw fail('Select each reference once.');
  return result;
}
const digest = references => hash(JSON.stringify(references));
function createResolver({ attachmentFactory = attachments.forConversation,
  parentResolver = resolveParent, imageReader = id => require('./imageService').image(id) } = {}) {
  const scoped = sessionId => attachmentFactory({ surface: 'image-workshop', sessionId, packId: 'atelier', scopeId: 'workspace' });
  async function upload(sessionId, { kind, name, dataUrl } = {}) {
    if (!['upload', 'sketch'].includes(kind)) throw fail('Invalid reference kind.');
    // Fully decode before storing, in addition to the canonical attachment signature check.
    const match = typeof dataUrl === 'string' && dataUrl.match(/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match) throw fail('The working copy must be a PNG or JPEG.');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length > attachments.MAX_BYTES) throw fail('Each working copy must be 2 MiB or less.', 413);
    inspectBytes(bytes);
    const row = await scoped(sessionId).upload({ name, dataUrl });
    return (await resolve(sessionId, [{ kind, attachmentId: row.id, sha256: hash(bytes) }])).references[0];
  }
  async function original(sessionId, id, bytes, name) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_ORIGINAL_BYTES) throw fail('The original must contain at most 50 MiB.', 413);
    if (!sniff(bytes)) throw fail('The original is not a recognized image.');
    return require('../surfaceConversationService').withSessionWrite('image-workshop', sessionId, async () => {
      const service = scoped(sessionId), current = await service.downloadVerified(id);
      if (current.original) {
        if (current.original.sha256 !== hash(bytes)) throw fail('This working copy already has another archived original.', 409);
        return current.original;
      }
      return (await service.attachOriginal(id, { bytes, name })).original;
    });
  }
  async function resolve(sessionId, values, { forInspection = false } = {}) {
    const selected = selectors(values), references = [], inputs = [];
    for (const [position, row] of selected.entries()) {
      let bytes, original;
      if (row.kind === 'parent') ({ bytes } = await parentResolver(row, undefined, imageReader, { atelierOnly: true }));
      else {
        const stored = await scoped(sessionId).downloadVerified(row.attachmentId, { verifyOriginal: true });
        if (stored.kind !== 'image') throw fail('The selected attachment is not an image.');
        bytes = stored.data; original = stored.original;
      }
      const sha256 = hash(bytes);
      if (sha256 !== row.sha256) throw fail('The selected reference changed. Select it again.', 409);
      const decoded = inspectBytes(bytes, row.kind === 'parent' ? 16 * 1024 * 1024 : 4194304);
      const descriptor = { ...row, position, sha256, mimeType: decoded.mimeType, byteLength: bytes.length,
        width: decoded.width, height: decoded.height,
        ...(original && { original: { sha256: original.sha256, mimeType: original.mimeType, byteLength: original.size },
          ...(original.sha256 !== sha256 && { transform: 'browser-working-copy-v1' }) }) };
      references.push(descriptor); inputs.push({ bytes, mimeType: decoded.mimeType });
    }
    if (forInspection && (!inputs.length || inputs.reduce((sum, row) => sum + row.bytes.length, 0) > MAX_IMAGE_BYTES)) {
      throw fail('Inspection requires one or two references totaling at most 3 MiB. Keep your selection or explicitly choose smaller working copies.', 413);
    }
    return { references, sha256: digest(references), inputs };
  }
  async function download(sessionId, id) {
    const row = await scoped(sessionId).downloadVerified(id);
    if (row.kind !== 'image') throw fail('The selected attachment is not an image.');
    return { mimeType: inspectBytes(row.data).mimeType, data: row.data };
  }
  return { upload, original, resolve, download };
}
function inspectBytes(bytes, maxPixels = 4194304) {
  try {
    const image = decode(bytes, maxPixels);
    if (Math.max(image.width, image.height) / Math.min(image.width, image.height) > 8) throw new Error('Extreme aspect ratio');
    return image;
  } catch { throw fail('A working copy must be a complete PNG/JPEG of at most 4 MP, with a maximum aspect ratio of 8:1.'); }
}
module.exports = { createResolver, selectors, digest, hash };
