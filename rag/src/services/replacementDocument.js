'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { revisionFingerprint } = require('./documentRevision');
const { buildDocumentIdentity } = require('./ragStoreUtils');
const { mergeMemoryFactMetadata } = require('../../../shared/memoryFactMetadata');
const { memoryClassification } = require('../../../shared/memoryClassification');

const conflict = (message, statusCode = 409) => Object.assign(new Error(`${message}; reconcile before any retry`), {
  statusCode, code: 'RAG_REPLACEMENT_CONFLICT'
});
const validKey = key => typeof key === 'string' && key.length > 0 && key.length <= 250;
const nativeRevision = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);

// Computed from the exact initial payload before dispatch, never from a later
// GET. The native revision also distinguishes a rewrite to identical content.
function fingerprint(doc) {
  return createHash('sha256').update(JSON.stringify({ fact: revisionFingerprint(doc), tags: doc.tags || [],
    hash: doc.hash || null, format: doc.format || null, chunkSize: doc.chunkSize, chunkOverlap: doc.chunkOverlap
  })).digest('hex');
}

function writeReceipt(documentId, payload, key) {
  return { key, fingerprint: fingerprint({ documentId, ...payload }), revision: randomUUID() };
}

function unchangedReplacement(doc, key) {
  const receipt = doc?.replacementWrite;
  return Boolean(doc && !doc.mixedRevision && !doc.invalidatedAt && !doc.supersededBy && validKey(key)
    && receipt?.key === key && /^[a-f0-9]{64}$/.test(receipt.fingerprint || '')
    && nativeRevision(receipt.revision) && receipt.revision === doc.revision && receipt.fingerprint === fingerprint(doc));
}

async function createReplacement(store, documentId, input) {
  const { key, text, source, scope, sensitivity, validFrom, sourceRefs } = input || {};
  if (!validKey(key) || typeof documentId !== 'string' || !documentId || typeof text !== 'string'
      || !text.trim() || text.length > 4000 || scope !== 'owner' || !['nestor-memory', 'agent-artifacts'].includes(source)
      || Object.keys(input).some(k => !['key', 'text', 'source', 'scope', 'sensitivity', 'validFrom', 'sourceRefs'].includes(k))) {
    throw conflict('Name a bounded reviewed owner replacement and stable key', 400);
  }
  memoryClassification({ scope, sensitivity });
  const fact = mergeMemoryFactMetadata({ validFrom, sourceRefs });
  const identity = buildDocumentIdentity(source, text, documentId);
  return store._withIdentityLock(identity.sourceIdentity, async () => {
    const existing = await store.vectorStore.getDocument(documentId);
    if (existing) {
      // A retry must not turn an edited successor back into the initial text.
      if (!unchangedReplacement(existing, key) || existing.contentHash !== identity.contentHash
          || existing.source !== source || existing.scope !== scope || existing.sensitivity !== sensitivity
          || (existing.validFrom || null) !== fact.validFrom
          || JSON.stringify(existing.sourceRefs || []) !== JSON.stringify(fact.sourceRefs)) {
        throw conflict('The replacement changed or its initial write proof is missing');
      }
      await store._backfillOriginalTextIfMissing(existing, identity, text);
      return { documentId, status: 'unchanged' };
    }
    return store._upsertDocumentWithIdentity(text, { documentId, source, scope, sensitivity, ...fact }, identity, key);
  });
}

async function deleteReplacement(store, documentId, input) {
  if (!input || !validKey(input.key) || Object.keys(input).some(k => k !== 'key')) throw conflict('Name the original replacement key', 400);
  return store._withIdentityLock(`document-id:${documentId}`, async () => {
    const doc = await store.vectorStore.getDocument(documentId);
    if (!doc) return { documentId, status: 'absent' };
    if (!unchangedReplacement(doc, input.key)) throw conflict('The replacement changed or its initial write proof is missing');
    // The storage predicate is atomic even if a writer bypasses the local
    // identity lock. A new native revision can never match this deletion.
    await store.vectorStore.deleteReplacementDocument(documentId, doc.replacementWrite);
    if (await store.vectorStore.getDocument(documentId)) throw conflict('The replacement changed during removal');
    return { documentId, status: 'removed' };
  });
}

module.exports = { createReplacement, deleteReplacement, writeReceipt, unchangedReplacement };
