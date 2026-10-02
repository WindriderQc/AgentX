'use strict';

const { getRagServiceClient } = require('./ragServiceClient');
const { scoreFloor } = require('../helpers/scoreFloor');

// Vector similarity floor applied when a caller does not choose one, so an
// unrelated question returns nothing instead of the nearest noise. Measured on
// the live nomic-embed-text corpus: relevant top hits >= 0.65, unrelated
// questions mostly <= 0.57. Hybrid (RRF) scores use another scale. Another
// embedding model needs its own MEMORY_SEARCH_MIN_SCORE.
const DEFAULT_MIN_SCORE = 0.6;

function defaultMinScore(value = process.env.MEMORY_SEARCH_MIN_SCORE) {
  return scoreFloor(value, DEFAULT_MIN_SCORE);
}

// These capabilities are bound by trusted server code, never by a persona,
// request body or model-supplied filter. They reuse Memory Policy V2 labels.
function forAudience(audience, { ragClient = getRagServiceClient(), minScore = defaultMinScore() } = {}) {
  if (!['owner', 'household'].includes(audience)) {
    throw Object.assign(new Error('A server-selected memory audience is required'), {
      code: 'MEMORY_AUDIENCE_REQUIRED', statusCode: 400
    });
  }
  return Object.freeze({
    async search(query, options = {}) {
      if (typeof query !== 'string' || !query.trim() || query.length > 10000) {
        throw Object.assign(new Error('Memory query must contain 1-10000 characters'), {
          code: 'MEMORY_QUERY_INVALID', statusCode: 400
        });
      }
      const searchOptions = Object.fromEntries(
        ['minScore', 'filters', 'timeoutMs', 'expand', 'hybrid', 'rerank', 'compress', 'followLinks']
          .filter(key => Object.hasOwn(options, key)).map(key => [key, options[key]])
      );
      searchOptions.topK = Math.max(1, Math.min(Math.trunc(Number(options.topK)) || 5, 20));
      if (!Object.hasOwn(searchOptions, 'minScore') && options.hybrid !== true) searchOptions.minScore = minScore;
      if (audience === 'household') {
        // A tag, persona or caller filter cannot grant access to owner data.
        searchOptions.filters = { ...options.filters, scope: 'household', sensitivity: 'normal' };
      }
      const results = await ragClient.searchSimilarChunks(query.trim(), searchOptions);
      // Recheck returned labels before text can enter a prompt or UI. Missing
      // labels are not a family grant, even if an upstream adapter ignores its filter.
      return (Array.isArray(results) ? results : []).filter(result => audience === 'owner'
        || (result?.metadata?.scope === 'household' && result?.metadata?.sensitivity === 'normal'));
    }
  });
}

module.exports = { DEFAULT_MIN_SCORE, defaultMinScore, forAudience };
