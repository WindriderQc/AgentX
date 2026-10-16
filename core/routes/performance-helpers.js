'use strict';
/**
 * Performance Routes — Pure Utility Helpers
 *
 * Stateless math / classification helpers shared by performance.js
 * and performance-data.js.
 *
 * Exports:
 *   calculateSystemHealth(metrics, baseline) — returns health string
 *   calculateDiff(current, baseline)         — % difference string
 */

/**
 * Calculate system health based on metrics and baseline.
 * @param {Object} metrics  - Current aggregated metrics
 * @param {Object} baseline - Active PerformanceBaseline document
 * @returns {string} 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
 */
function calculateSystemHealth(metrics, baseline) {
  // No measured request (only model-bound traffic, or none) is unknown, not healthy.
  if (!metrics || metrics.total_requests === 0) {
    return 'unknown';
  }

  // Check error rate
  if (metrics.error_rate > 5) {
    return 'unhealthy';
  }

  // The dashboard already renders >1% as an amber error rate. Its headline
  // must use the same threshold instead of claiming Healthy above it.
  if (metrics.error_rate > 1) {
    return 'degraded';
  }

  // Check against baseline if available
  if (baseline) {
    if (metrics.avg_p95 > baseline.metrics.p95_latency * 1.5) {
      return 'degraded';
    }

    if (metrics.error_rate > baseline.metrics.error_rate * 2) {
      return 'degraded';
    }
  }

  // Check absolute thresholds
  if (metrics.avg_p95 > 5000) { // 5 seconds
    return 'degraded';
  }

  return 'healthy';
}

/**
 * Calculate percentage difference between current and baseline value.
 * @param {number} current  - Current value
 * @param {number} baseline - Baseline value
 * @returns {string} Percentage difference (e.g. "12.50")
 */
function calculateDiff(current, baseline) {
  if (!baseline || baseline === 0) {
    return '0.00';
  }
  return ((current / baseline - 1) * 100).toFixed(2);
}

module.exports = { calculateSystemHealth, calculateDiff };
