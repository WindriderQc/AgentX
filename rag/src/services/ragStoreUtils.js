'use strict';
/**
 * RAG Store Utilities — pure helper functions.
 */

const crypto = require('crypto');
const logger = require('../../config/logger');

const DOCUMENT_IDENTITY_VERSION = 'source-content-v1';

function normalizeSourceIdentity(source) {
  const normalized = String(source || 'unknown').trim().normalize('NFC');
  return normalized || 'unknown';
}

function generateDocumentId(source, filePath) {
  const combined = `${source}:${filePath}`;
  return crypto.createHash('md5').update(combined).digest('hex');
}

function hashText(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

function hashContentIdentity(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Canonical identity for one knowledge source revision.
 *
 * Source labels are trimmed and Unicode-normalized. Content remains exact
 * after extraction: whitespace and line-ending changes intentionally create a
 * new revision. `generateDocumentId(source, text)` is retained for backward
 * compatibility with already-indexed automatic IDs.
 */
function buildDocumentIdentity(source, text, explicitDocumentId = null) {
  const sourceLabel = String(source || 'unknown');
  const canonicalSourceLabel = normalizeSourceIdentity(sourceLabel);
  // Explicit IDs are opaque, caller-owned source identities. Preserve their
  // exact spelling so case, path syntax, or intentional version suffixes are
  // never collapsed by source-label normalization.
  const stableDocumentId = explicitDocumentId || null;
  const sourceIdentityKind = stableDocumentId ? 'document_id' : 'source_label';
  const sourceIdentity = stableDocumentId
    ? `document-id:${stableDocumentId}`
    : `source-label:${canonicalSourceLabel}`;
  return {
    identityVersion: DOCUMENT_IDENTITY_VERSION,
    source: sourceLabel,
    sourceIdentity,
    sourceIdentityKind,
    contentHash: hashContentIdentity(text),
    documentId: stableDocumentId || generateDocumentId(sourceLabel, text)
  };
}

/**
 * True when `index` falls between the two halves of a UTF-16 surrogate pair,
 * where cutting the text would leave a lone surrogate on each side.
 */
function insideSurrogatePair(text, index) {
  if (index <= 0 || index >= text.length) return false;
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function splitIntoChunks(text, chunkSize, chunkOverlap) {
  if (typeof text !== 'string') {
    throw new Error('splitIntoChunks: text must be a string');
  }
  if (chunkSize <= 0 || !Number.isFinite(chunkSize)) {
    throw new Error(`splitIntoChunks: chunkSize must be a positive number, got ${chunkSize}`);
  }
  if (chunkOverlap < 0 || !Number.isFinite(chunkOverlap)) {
    throw new Error(`splitIntoChunks: chunkOverlap must be a non-negative number, got ${chunkOverlap}`);
  }
  if (chunkOverlap >= chunkSize) {
    throw new Error(`splitIntoChunks: chunkOverlap (${chunkOverlap}) must be less than chunkSize (${chunkSize})`);
  }

  const chunks = [];
  let start = 0;
  const MAX_CHUNKS = 10000;

  while (start < text.length) {
    if (chunks.length >= MAX_CHUNKS) {
      logger.error('Chunking safety limit reached', {
        chunkCount: chunks.length, chunkSize, chunkOverlap, textLength: text.length
      });
      throw Object.assign(new Error('Document exceeds the chunking safety limit; no partial document was indexed. Split the source and retry.'), {
        code: 'RAG_CHUNK_LIMIT_EXCEEDED', statusCode: 413, limit: MAX_CHUNKS
      });
    }

    const chunkStart = start;
    let end = Math.min(start + chunkSize, text.length);

    if (end < text.length) {
      const breakPoint = text.lastIndexOf('. ', end);
      if (breakPoint > start && breakPoint > start + chunkSize * 0.5) {
        end = breakPoint + 1;
      }
      // Never end a chunk between the halves of an emoji or other character
      // beyond the basic plane. Keep the whole pair in this chunk when moving
      // back would leave it empty.
      if (insideSurrogatePair(text, end)) end += end - 1 > start ? -1 : 1;
    }

    const chunk = text.substring(start, end).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }

    if (end >= text.length) {
      break;
    }

    const minAdvance = Math.max(50, Math.floor(chunkSize * 0.1));
    const overlap = Math.min(chunkOverlap, chunkSize - minAdvance);
    const nextStart = end - overlap;

    if (nextStart <= start) {
      const oldStart = start;
      start = oldStart + minAdvance;
      logger.warn('Chunking forced advance', {
        oldStart, newStart: start, chunkSize, chunkOverlap, minAdvance
      });
    } else {
      start = nextStart;
    }

    // The next chunk must not begin inside a pair either: step back so it
    // starts with the whole character, or forward when stepping back would
    // repeat this chunk.
    if (insideSurrogatePair(text, start)) start += start - 1 > chunkStart ? -1 : 1;

    if (start >= text.length) break;
  }

  return chunks;
}

/**
 * Reciprocal Rank Fusion (RRF) — merges two ranked result lists.
 *
 * Items appearing in both lists receive boosted scores (sum of reciprocal ranks).
 * Formula per list: 1 / (k + rank + 1)
 *
 * Ported from legacy AgentX ragStore._reciprocalRankFusion().
 *
 * @param {Array} list1 - First ranked list (e.g. vector search results)
 * @param {Array} list2 - Second ranked list (e.g. keyword search results)
 * @param {number} k - RRF constant (default: 60)
 * @returns {Array} Merged list sorted by fused score, each item gets an `rrfScore` field
 */
function reciprocalRankFusion(list1, list2, k = 60) {
  const scoreMap = new Map();

  // Score list1
  list1.forEach((item, rank) => {
    const meta = item.metadata || {};
    const key = `${meta.documentId || ''}:${meta.chunkIndex ?? ''}`;
    const rrfScore = 1 / (k + rank + 1);
    scoreMap.set(key, { item, score: rrfScore });
  });

  // Add/update with list2
  list2.forEach((item, rank) => {
    const meta = item.metadata || {};
    const key = `${meta.documentId || ''}:${meta.chunkIndex ?? ''}`;
    const rrfScore = 1 / (k + rank + 1);

    if (scoreMap.has(key)) {
      // Item in both lists — add scores (boost)
      const existing = scoreMap.get(key);
      existing.score += rrfScore;
    } else {
      scoreMap.set(key, { item, score: rrfScore });
    }
  });

  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .map(entry => ({
      ...entry.item,
      rrfScore: entry.score
    }));
}

/** Retrieval modes that run for the given options; hybrid takes precedence over expansion. */
function appliedSearchModes(options = {}) {
  const hybrid = options.hybrid === true;
  return { hybrid, expand: options.expand === true && !hybrid };
}

module.exports = {
  DOCUMENT_IDENTITY_VERSION,
  buildDocumentIdentity,
  generateDocumentId,
  hashContentIdentity,
  hashText,
  normalizeSourceIdentity,
  splitIntoChunks,
  reciprocalRankFusion,
  appliedSearchModes
};
