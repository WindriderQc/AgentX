'use strict';

/**
 * Copy every RAG document from one vector collection into another, re-embedded
 * by the target RagStore. The source collection is only read.
 *
 * Each document is rebuilt from its chunk-0 payload (originalText and the
 * document metadata) through RagStore.upsertDocumentWithChunks, so chunking,
 * Markdown parsing and identity rules are the ingestion ones. A document
 * without originalText is reported and skipped, never reconstructed.
 * A delta pass skips documents already in the target with the same hash;
 * with prune it also removes target documents the source no longer has.
 */

const { buildDocumentIdentity } = require('./ragStoreUtils');

class UsageError extends Error {}
class CancelledError extends Error {}

const CHUNK_ZERO_FIELDS = [
  'documentId', 'originalText', 'source', 'tags', 'scope', 'sensitivity', 'format',
  'chunkSize', 'chunkOverlap', 'hash', 'title', 'sourceIdentityKind', 'contentHash',
  'validFrom', 'recordedAt', 'sourceRefs'
];
// One page holds whole original texts (up to 2 M characters each) under the
// 32 MiB scroll response cap.
const DEFAULT_PAGE_SIZE = 4;
const MAX_PAGE_SIZE = 16;
const CHUNK_ZERO_FILTER = { must: [{ key: 'chunkIndex', match: { value: 0 } }] };


/** Ingestion metadata for one chunk-0 payload, or a skip/fail reason. */
function buildUpsertMetadata(payload) {
  const hasScope = payload.scope !== undefined && payload.scope !== null;
  const hasSensitivity = payload.sensitivity !== undefined && payload.sensitivity !== null;
  if (hasScope !== hasSensitivity) return { error: 'incomplete scope/sensitivity labels' };
  const source = payload.source || 'unknown';
  const keepsDocumentId = payload.sourceIdentityKind !== 'source_label';
  if (!keepsDocumentId
    && buildDocumentIdentity(source, payload.originalText).documentId !== payload.documentId) {
    // The automatic ID would change in the target; keep the row reviewable.
    return { error: 'automatic document id does not match its source and text' };
  }
  return {
    metadata: {
      ...(keepsDocumentId ? { documentId: payload.documentId } : {}),
      source,
      tags: Array.isArray(payload.tags) ? payload.tags : [],
      validFrom: payload.validFrom || null,
      recordedAt: payload.recordedAt || null,
      sourceRefs: payload.sourceRefs || [],
      restoreFactMetadata: true,
      ...(hasScope ? { scope: payload.scope, sensitivity: payload.sensitivity } : {}),
      ...(payload.format ? { format: payload.format } : {}),
      ...(payload.chunkSize != null ? { chunkSize: payload.chunkSize } : {}),
      ...(payload.chunkOverlap != null ? { chunkOverlap: payload.chunkOverlap } : {}),
      ...(payload.hash ? { hash: payload.hash } : {}),
      // The embedding model is what changed, not the content.
      forceReindex: true
    }
  };
}

async function readTargetIndex(targetStore) {
  const index = new Map();
  for await (const points of targetStore._scrollPages({
    filter: CHUNK_ZERO_FILTER,
    withPayload: { include: ['documentId', 'contentHash', 'hash', 'validFrom', 'recordedAt', 'sourceRefs'] },
    pageSize: 1000
  })) {
    for (const point of points) {
      const payload = point.payload || {};
      if (payload.documentId) index.set(payload.documentId, payload);
    }
  }
  return index;
}

function unchangedInTarget(targetIndex, payload) {
  const existing = targetIndex?.get(payload.documentId);
  return Boolean(existing)
    && (existing.contentHash || null) === (payload.contentHash || null)
    && (existing.hash || null) === (payload.hash || null)
    && (existing.validFrom || null) === (payload.validFrom || null)
    && (existing.recordedAt || null) === (payload.recordedAt || null)
    && JSON.stringify(existing.sourceRefs || []) === JSON.stringify(payload.sourceRefs || []);
}

async function copyPayloadIndexes(sourceSchema, targetStore, summary) {
  const targetInfo = await targetStore.getCollectionInfo();
  const existing = targetInfo?.payloadSchema || {};
  for (const [field, schema] of Object.entries(sourceSchema || {})) {
    if (existing[field]) continue;
    try {
      await targetStore.createPayloadIndex(field, schema.params || schema.data_type);
      summary.payloadIndexesCopied.push(field);
    } catch (err) {
      summary.failed.push({ payloadIndex: field, reason: err.message });
    }
  }
}

/**
 * @param {object} deps
 * @param {object} deps.sourceStore   QdrantVectorStore on the source collection
 * @param {object} deps.targetStore   QdrantVectorStore on the target collection
 * @param {object} deps.targetRagStore RagStore writing to the target collection
 */
async function migrateEmbeddingCollection(options, deps) {
  const { source, target, dryRun = false, delta = false, prune = false, limit = null, pageSize = DEFAULT_PAGE_SIZE } = options;
  const { sourceStore, targetStore, targetRagStore, embeddingModel, embeddingDimension } = deps;
  const { shouldStop = () => false, onProgress = () => {} } = deps;
  if (prune && (!delta || limit)) throw new UsageError('prune needs a complete delta pass');
  if (!source || !target) throw new UsageError('--source and --target are required');
  if (source === target) throw new UsageError('target collection must differ from the source collection');
  if (!Number.isSafeInteger(embeddingDimension) || embeddingDimension <= 0) {
    throw new UsageError('EMBEDDING_DIMENSION must be set to the target model dimension');
  }

  const summary = {
    source, target, embeddingModel, embeddingDimension, dryRun, delta,
    documents: 0, missingOriginalText: 0, sources: {},
    migrated: 0, wouldMigrate: 0, pruned: 0, skipped: [], failed: [], payloadIndexesCopied: []
  };
  const seen = new Set();

  const sourceInfo = await sourceStore.getCollectionInfo();
  if (!sourceInfo) throw new Error(`source collection "${source}" does not exist`);
  const targetInfo = await targetStore.getCollectionInfo();
  if (targetInfo?.vectorSize && targetInfo.vectorSize !== embeddingDimension) {
    throw new Error(`target collection "${target}" has vector size ${targetInfo.vectorSize}, EMBEDDING_DIMENSION is ${embeddingDimension}`);
  }
  const targetIndex = delta && targetInfo ? await readTargetIndex(targetStore) : null;
  let targetVerified = false;

  scan:
  for await (const points of sourceStore._scrollPages({
    filter: CHUNK_ZERO_FILTER,
    withPayload: { include: CHUNK_ZERO_FIELDS },
    pageSize
  })) {
    for (const point of points) {
      if (limit && summary.documents >= limit) break scan;
      if (shouldStop()) throw Object.assign(new CancelledError('migration cancelled'), { summary });
      const payload = point.payload || {};
      const documentId = payload.documentId;
      if (documentId) seen.add(documentId);
      summary.documents += 1;
      onProgress(summary);
      const sourceLabel = payload.source || 'unknown';
      summary.sources[sourceLabel] = (summary.sources[sourceLabel] || 0) + 1;

      if (typeof payload.originalText !== 'string' || payload.originalText.length === 0) {
        summary.missingOriginalText += 1;
        summary.skipped.push({ documentId, reason: 'missing originalText' });
        continue;
      }
      if (unchangedInTarget(targetIndex, payload)) {
        summary.skipped.push({ documentId, reason: 'already in target with the same hash' });
        continue;
      }
      const { metadata, error } = buildUpsertMetadata(payload);
      if (error) {
        summary.failed.push({ documentId, reason: error });
        continue;
      }
      if (dryRun) {
        summary.wouldMigrate += 1;
        continue;
      }

      try {
        await targetRagStore.upsertDocumentWithChunks(payload.originalText, metadata);
        summary.migrated += 1;
      } catch (err) {
        summary.failed.push({ documentId, reason: err.message });
        continue;
      }
      if (!targetVerified) {
        const written = await targetStore.getCollectionInfo();
        if (written?.vectorSize !== embeddingDimension) {
          throw Object.assign(new Error(`target collection "${target}" was written with vector size ${written?.vectorSize}, EMBEDDING_DIMENSION is ${embeddingDimension}; stopping`), { summary });
        }
        targetVerified = true;
        await copyPayloadIndexes(sourceInfo.payloadSchema, targetStore, summary);
      }
    }
  }

  if (!dryRun && !targetVerified && targetInfo) {
    await copyPayloadIndexes(sourceInfo.payloadSchema, targetStore, summary);
  }
  if (prune && targetIndex) {
    // A document deleted from the source since the copy must not survive in the target.
    for (const documentId of targetIndex.keys()) {
      if (seen.has(documentId)) continue;
      if (!dryRun) await targetStore.deleteDocument(documentId);
      summary.pruned += 1;
    }
  }
  onProgress(summary);
  return summary;
}

module.exports = { migrateEmbeddingCollection, buildUpsertMetadata, UsageError, CancelledError, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE };
