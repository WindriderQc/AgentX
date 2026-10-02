'use strict';

/**
 * Parse a vector-similarity floor (cosine, 0-1) from configuration. Floors are
 * calibrated for one embedding model, so each one can be overridden per
 * instance; an unset or invalid value keeps the code default.
 */
function scoreFloor(value, fallback) {
  const parsed = value === undefined || value === null || String(value).trim() === '' ? NaN : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

module.exports = { scoreFloor };
