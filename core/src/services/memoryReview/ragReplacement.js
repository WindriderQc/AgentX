'use strict';

const { createHash } = require('node:crypto');
const { getRagServiceClient } = require('../ragServiceClient');

// Reviewed replacement of one owner RAG fact. RAG keeps both documents: the
// predecessor stays as owner history (invalidatedAt, supersededBy) and the
// successor becomes the current fact. Every step is idempotent by its review
// key, and each predecessor write is conditional on its reviewed fingerprint.
const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode, code: 'MEMORY_REPLACEMENT_CONFLICT' });
const successorFor = key => 'memory-review-replacement-' + createHash('sha256').update(String(key)).digest('hex').slice(0, 32);
const meta = doc => doc?.metadata || {};
const missing = error => error?.statusCode === 404 || error?.status === 404 || /\b404\b|not found/i.test(String(error?.message || ''));

async function read(client, documentId) {
  try {
    const doc = await client.getDocument(documentId);
    return doc?.documentId ? doc : null;
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

function createRagReplacement({ ragClient = getRagServiceClient(), now = () => new Date() } = {}) {
  async function source(ref) {
    const doc = await read(ragClient, ref);
    const m = meta(doc);
    if (!doc || m.invalidatedAt || m.supersededBy || m.scope !== 'owner' || !/^[a-f0-9]{64}$/.test(m.revisionFingerprint || '')) {
      throw fail('The source is not an available owner RAG fact');
    }
    return { authority: 'rag', ref, fingerprint: m.revisionFingerprint };
  }

  async function supersede({ ref, expectedFingerprint, key, text, scope, sensitivity, validFrom, sourceRefs }) {
    if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw fail('A replacement needs bounded text');
    const successorId = successorFor(key);
    const old = await read(ragClient, ref);
    if (!old) throw fail('The source no longer exists');
    const m = meta(old);
    if (m.supersededBy === successorId) {
      if (!(await read(ragClient, successorId))) throw fail('The recorded successor is missing; reconcile before any retry');
      return { id: successorId, predecessorId: ref, alreadyApplied: true };
    }
    if (m.supersededBy || m.invalidatedAt || m.revisionFingerprint !== expectedFingerprint
        || scope !== 'owner' || m.scope !== scope || m.sensitivity !== sensitivity) {
      throw fail('The reviewed source changed or its labels do not match');
    }
    const effectiveAt = validFrom ? new Date(validFrom) : now();
    if (!(effectiveAt <= now()) || (m.validFrom && effectiveAt < new Date(m.validFrom))) {
      throw fail('Replacement validity must be known now and follow the previous fact');
    }
    // The successor joins the same memory source, so recall and dedup keep finding it.
    await ragClient.upsertDocumentWithChunks(text.trim(), { documentId: successorId, source: old.source,
      scope, sensitivity, validFrom: effectiveAt.toISOString(), sourceRefs });
    await ragClient.setDocumentValidity(ref, { invalidatedAt: effectiveAt.toISOString(), supersededBy: successorId,
      expectedFingerprint });
    return { id: successorId, predecessorId: ref, alreadyApplied: false };
  }

  async function rollback({ ref, key }) {
    const successorId = successorFor(key);
    const [old, successor] = await Promise.all([read(ragClient, ref), read(ragClient, successorId)]);
    if (!old) throw fail('The predecessor no longer exists; restore refused');
    const m = meta(old), s = meta(successor);
    if (successor && (s.invalidatedAt || s.supersededBy)) throw fail('The replacement was itself replaced; restore refused');
    if (m.supersededBy === successorId) {
      await ragClient.setDocumentValidity(ref, { invalidatedAt: null, supersededBy: null, expectedFingerprint: m.revisionFingerprint });
    } else if (m.supersededBy || m.invalidatedAt) {
      throw fail('The predecessor changed after replacement; restore refused');
    }
    if (successor) await ragClient.deleteDocument(successorId);
    return { restored: ref, removedSuccessor: successor ? successorId : null, alreadyRolledBack: !successor && m.supersededBy !== successorId };
  }

  // Rendered from RAG on each review read, never stored as a second copy.
  async function preview(ref) {
    const doc = await read(ragClient, ref);
    if (!doc) return { unavailable: true };
    const chunks = await ragClient.getDocumentChunks(ref).catch(() => null);
    const first = Array.isArray(chunks?.chunks) ? chunks.chunks[0]?.text : null;
    return { text: typeof first === 'string' ? first.slice(0, 600) : '', validFrom: meta(doc).validFrom || null,
      invalidatedAt: meta(doc).invalidatedAt || null };
  }

  return { source, supersede, rollback, preview, successorFor };
}

module.exports = { createRagReplacement, ragReplacementSuccessorFor: successorFor };
