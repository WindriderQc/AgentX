/**
 * Document Detail Routes — metadata and chunk retrieval.
 *
 * GET /documents/:id        — Get document metadata
 * GET /documents/:id/chunks — Get all chunks for a document
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const { getRagStore } = require('../src/services/ragStore');
const { revisionFingerprint } = require('../src/services/documentRevision');
const { sendError } = require('../src/utils/response');
const { memoryFactProjection, memoryValidityProjection } = require('../../shared/memoryFactMetadata');

// ── GET /documents/:id ──────────────────────────────────

router.get('/documents/:id', async (req, res) => {
  try {
    const ragStore = getRagStore();
    const doc = await ragStore.getDocument(req.params.id);
    if (!doc) {
      return res.status(404).json({ ok: false, error: 'Document not found' });
    }

    const chunks = await ragStore.getDocumentChunks(req.params.id);

    res.json({
      ok: true,
      data: {
        documentId: doc.documentId,
        source: doc.source,
        chunkCount: chunks.length,
        metadata: { tags: doc.tags, hash: doc.hash,
          ...memoryFactProjection(doc), ...memoryValidityProjection(doc),
          ...(doc.scope ? { scope: doc.scope, sensitivity: doc.sensitivity } : {}),
          revisionFingerprint: revisionFingerprint(doc) }
      }
    });
  } catch (err) {
    logger.error('Get document error:', err);
    sendError(res, 500, 'Failed to get document', err.message);
  }
});

// ── GET /documents/:id/chunks ────────────────────────────

router.get('/documents/:id/chunks', async (req, res) => {
  try {
    const ragStore = getRagStore();
    const doc = await ragStore.getDocument(req.params.id);
    if (!doc) {
      return res.status(404).json({ ok: false, error: 'Document not found' });
    }

    const chunks = await ragStore.getDocumentChunks(req.params.id);

    res.json({
      ok: true,
      data: {
        documentId: doc.documentId,
        chunks: chunks.map(c => ({
          chunkIndex: c.chunkIndex,
          text: c.text,
          metadata: { ...(c.metadata || {}),
            ...memoryFactProjection(doc), ...memoryValidityProjection(doc),
            ...(doc.scope ? { scope: doc.scope, sensitivity: doc.sensitivity } : {}) }
        }))
      }
    });
  } catch (err) {
    logger.error('Get document chunks error:', err);
    sendError(res, 500, 'Failed to get document chunks', err.message);
  }
});

// ── POST /documents/:id/validity ─────────────────────────
// A reviewed replacement or its restore: validity only, conditional on the
// fingerprint the reviewer saw. Text, labels and provenance are re-used.
router.post('/documents/:id/validity', async (req, res) => {
  try {
    const result = await getRagStore().setDocumentValidity(req.params.id, req.body || {});
    const doc = await getRagStore().getDocument(req.params.id);
    res.json({ ok: true, data: { documentId: req.params.id, status: result?.status || 'updated',
      ...memoryValidityProjection(doc), revisionFingerprint: revisionFingerprint(doc) } });
  } catch (err) {
    const status = err.statusCode || (err.code === 'INVALID_MEMORY_FACT_METADATA' ? 400 : 500);
    if (status >= 500) logger.error('Set document validity error:', err);
    res.status(status).json({ ok: false, error: err.code || 'VALIDITY_UPDATE_FAILED', detail: err.message });
  }
});

module.exports = router;
