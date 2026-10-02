'use strict';

/** POST /api/rag/search — bounded similarity search with telemetry. */

const crypto = require('crypto');
const logger = require('../config/logger');
const { getRagStore } = require('../src/services/ragStore');
const SearchEvent = require('../models/SearchEvent');
const buddyRagEvents = require('../src/services/buddyRagEvents');
const { sendError } = require('../src/utils/response');
const { classifyRagAvailabilityError } = require('../src/utils/ragAvailability');

const MAX_QUERY_LENGTH = 10_000;
const TOP_K_MAX = 20;

async function handleSearch(req, res) {
  try {
    const { query, topK, minScore, filters, expand, hybrid, rerank, compress, followLinks } = req.body;
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return res.status(400).json({ ok: false, error: 'query is required and must be a non-empty string' });
    }
    if (query.length > MAX_QUERY_LENGTH) {
      return res.status(400).json({ ok: false, error: `query exceeds maximum length of ${MAX_QUERY_LENGTH} characters` });
    }

    // Clamp topK to valid range
    let safeTopK = topK !== undefined ? Math.floor(Number(topK)) : 5;
    if (!Number.isFinite(safeTopK) || safeTopK < 1) safeTopK = 1;
    if (safeTopK > TOP_K_MAX) safeTopK = TOP_K_MAX;

    // Clamp minScore to [0, 1]
    let safeMinScore = minScore !== undefined ? Number(minScore) : 0;
    if (!Number.isFinite(safeMinScore) || safeMinScore < 0) safeMinScore = 0;
    if (safeMinScore > 1) safeMinScore = 1;

    // Validate filters is a plain object (not array, not string)
    if (filters !== undefined && filters !== null) {
      if (typeof filters !== 'object' || Array.isArray(filters)) {
        return res.status(400).json({ ok: false, error: 'filters must be a plain object' });
      }
    }

    const ragStore = getRagStore();
    const searchStartedAt = Date.now();
    const searchOptions = {
      topK: safeTopK,
      minScore: safeMinScore,
      filters,
      expand: expand === true,
      hybrid: hybrid === true,
      rerank: rerank === true,
      compress: compress === true, followLinks
    };
    // Bounded, server-attested search telemetry. No query text, no passages.
    const searchEventBase = {
      surface: 'api',
      queryLength: query.length,
      topK: safeTopK,
      minScore: safeMinScore,
      filterCount: filters && typeof filters === 'object' ? Object.keys(filters).length : 0,
      hybrid: searchOptions.hybrid,
      rerank: searchOptions.rerank,
      expand: searchOptions.expand,
      compress: searchOptions.compress
    };

    let results;
    try {
      results = await ragStore.searchSimilarChunks(query, searchOptions);
    } catch (searchErr) {
      const classifiedSearch = classifyRagAvailabilityError(searchErr);
      recordSearchEvent({
        ...searchEventBase,
        status: 'failed',
        durationMs: Date.now() - searchStartedAt,
        errorCode: classifiedSearch?.code || 'search_failed'
      });
      throw searchErr;
    }

    const resultList = Array.isArray(results) ? results : [];
    const topScore = resultList.reduce((best, item) => {
      const score = Number(item?.score);
      return Number.isFinite(score) && score > best ? score : best;
    }, Number.NEGATIVE_INFINITY);
    recordSearchEvent({
      ...searchEventBase,
      status: resultList.length === 0 ? 'empty' : 'success',
      resultCount: resultList.length,
      topScore: Number.isFinite(topScore) ? topScore : undefined,
      durationMs: Date.now() - searchStartedAt
    });

    // Fire-and-forget Buddy surface event when a valid query yields nothing
    // (intent:suggesting, surfaceScope:rag) — guide the user to refine/ingest.
    if (resultList.length === 0) {
      buddyRagEvents.searchEmpty(`RAG search returned no matches (query length ${query.length})`);
    }

    res.json({ ok: true, data: { results: resultList, count: resultList.length } });
  } catch (err) {
    // Fire-and-forget Buddy surface event (intent:warning, surfaceScope:rag).
    buddyRagEvents.searchFailed(`RAG search failed: ${(err.message || 'unknown').slice(0, 120)}`);

    const classified = classifyRagAvailabilityError(err);
    if (classified) {
      logger.warn(`Search blocked: ${classified.code} — ${err.message}`);
      return sendError(res, classified.status, classified.code, classified.detail);
    }
    logger.error('Search error:', err);
    sendError(res, 500, 'Search failed', err.message);
  }
}

/** Fire-and-forget: a telemetry failure never fails a search. */
function recordSearchEvent(event) {
  try {
    SearchEvent.create({ eventId: crypto.randomUUID(), ...event })
      .catch((telErr) => logger.warn('Search telemetry write failed:', telErr.message));
  } catch (telErr) {
    logger.warn('Search telemetry skipped:', telErr.message);
  }
}

module.exports = { handleSearch };
