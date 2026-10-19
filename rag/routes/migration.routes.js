/**
 * Embedding Migration Routes
 *
 * GET    /embedding-migration/status   — Check dimension mismatch between current model and stored vectors
 * POST   /embedding-migration/reindex  — Retired: it re-embedded the serving collection in place
 * GET    /embedding-profile            — The model and collection RAG serves, and the latest build
 * POST   /embedding-builds             — Start the build a dispatched Core heavy-work request names
 * GET    /embedding-builds/:id         — Build progress and outcome
 * POST   /embedding-builds/:id/cancel  — Stop a build before it switches collections
 *
 * A model change is requested from Core's Nerve Center. It queues a heavy-work
 * request whose launch starts the build here; search keeps the previous
 * collection until the new one is complete.
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const { getRagStore } = require('../src/services/ragStore');
const { getEmbeddingsService } = require('../src/services/embeddings');
const { getProfileService } = require('../src/services/embeddingProfile');
const { getBuildService } = require('../src/services/embeddingBuild');
const { sendError } = require('../src/utils/response');

/**
 * Compute the current embedding migration status.
 *
 * Consumed by GET /embedding-migration/status.
 *
 * @returns {Promise<{
 *   currentModel: string,
 *   currentDimension: number,
 *   storedDimension: number,
 *   dimensionMatch: boolean,
 *   documentCount: number,
 *   chunkCount: number,
 *   migrationNeeded: boolean,
 *   note?: string
 * }>}
 */
async function computeMigrationStatus() {
  const ragStore = getRagStore();
  const embeddingsService = getEmbeddingsService();

  const stats = await ragStore.getStats();
  const currentDimension = embeddingsService.getDimension();
  const currentModel = embeddingsService.model;
  const storedDimension = stats.vectorDimension || 0;
  const documentCount = stats.documentCount || 0;
  const chunkCount = stats.chunkCount || 0;

  const dimensionMatch = storedDimension === 0 || currentDimension === storedDimension;
  // Migration needed: dimensions differ AND there are documents to migrate
  const migrationNeeded = !dimensionMatch && documentCount > 0;

  const data = {
    currentModel,
    currentDimension,
    storedDimension,
    dimensionMatch,
    documentCount,
    chunkCount,
    migrationNeeded,
  };

  // Warn about dimension change requiring collection recreation
  if (migrationNeeded) {
    data.note = 'Dimension change requires collection recreation. Back up data before proceeding.';
  }

  return data;
}

// ── GET /embedding-migration/status ─────────────────────

router.get('/embedding-migration/status', async (req, res) => {
  try {
    const data = await computeMigrationStatus();
    res.json({ ok: true, data });
  } catch (err) {
    logger.error('Embedding migration status error:', err);
    sendError(res, 500, 'Failed to check migration status', err.message);
  }
});

// ── POST /embedding-migration/reindex (retired) ─────────

// Re-embedding the serving collection in place mixed vectors of two models
// until it finished. A model change now builds a new collection from Core's
// heavy-work queue and switches only when it is complete.
router.post('/embedding-migration/reindex', (req, res) => {
  res.status(410).json({
    ok: false,
    error: 'IN_PLACE_REINDEX_RETIRED',
    detail: 'Change the embedding model from the Nerve Center: it queues a full rebuild into a new collection and keeps search on the current one until it completes.'
  });
});

// ── Embedding profile and builds ────────────────────────

function sendBuildError(res, err) {
  if (err.statusCode) return res.status(err.statusCode).json({ ok: false, error: err.code, detail: err.message });
  logger.error('Embedding build route error:', err);
  return sendError(res, 500, 'Embedding build unavailable', err.message);
}

router.get('/embedding-profile', async (req, res) => {
  try {
    const [profile, build] = await Promise.all([getProfileService().read(), getBuildService().latest()]);
    res.json({ ok: true, data: { profile, build } });
  } catch (err) {
    sendBuildError(res, err);
  }
});

router.post('/embedding-builds', async (req, res) => {
  try {
    const { buildId, model, dimension } = req.body || {};
    const build = await getBuildService().start({ buildId, model, dimension });
    res.status(202).json({ ok: true, data: build });
  } catch (err) {
    sendBuildError(res, err);
  }
});

router.get('/embedding-builds/:id', async (req, res) => {
  try {
    const build = await getBuildService().get(req.params.id);
    if (!build) return res.status(404).json({ ok: false, error: 'EMBEDDING_BUILD_NOT_FOUND' });
    res.json({ ok: true, data: build });
  } catch (err) {
    sendBuildError(res, err);
  }
});

router.post('/embedding-builds/:id/cancel', async (req, res) => {
  try {
    res.json({ ok: true, data: await getBuildService().cancel(req.params.id) });
  } catch (err) {
    sendBuildError(res, err);
  }
});

module.exports = router;
