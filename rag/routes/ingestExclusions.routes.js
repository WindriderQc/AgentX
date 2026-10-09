'use strict';

/**
 * Files excluded from the index by "delete and exclude".
 *
 * GET  /ingestion/excluded          — List excluded scanned files (newest first)
 * POST /ingestion/excluded/restore  — Lift one exclusion; the next scan ingests the file
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const { listExcludedFiles, restoreExcludedFile } = require('../src/services/nasFileIndexState');
const { sendError } = require('../src/utils/response');

router.get('/ingestion/excluded', async (_req, res) => {
  try {
    const files = await listExcludedFiles();
    if (!files) return sendError(res, 503, 'MONGODB_UNAVAILABLE', 'MongoDB is not connected');
    res.json({ ok: true, data: { files, count: files.length } });
  } catch (err) {
    logger.error('List excluded files error:', err);
    sendError(res, 500, 'Failed to list excluded files', err.message);
  }
});

router.post('/ingestion/excluded/restore', async (req, res) => {
  const filePath = req.body?.path;
  if (typeof filePath !== 'string' || !filePath) {
    return res.status(400).json({ ok: false, error: 'path is required and must be a non-empty string' });
  }
  const restored = await restoreExcludedFile(filePath);
  if (restored === null) return sendError(res, 503, 'MONGODB_UNAVAILABLE', 'MongoDB is not connected');
  if (restored === 0) return res.status(404).json({ ok: false, error: 'No excluded file at that path' });
  res.json({ ok: true, data: { path: filePath, restored } });
});

module.exports = router;
