const logger = require('../../config/logger');
const PerformanceSnapshot = require('../../models/PerformanceSnapshot');

/**
 * Performance Tracking Middleware
 *
 * Tracks HTTP request metrics and aggregates them hourly into PerformanceSnapshot.
 * Operates with in-memory buffering to avoid blocking request processing.
 *
 * Features:
 * - Non-blocking async processing
 * - Hourly aggregation with automatic flushing
 * - Per-endpoint tracking
 * - Status code distribution
 * - Percentile calculation (p50, p95, p99)
 *
 * @see /models/PerformanceSnapshot.js - Database schema
 * @see /routes/performance.js - Dashboard queries
 */

// In-memory buffer for request data (flushed every 60 seconds)
const requestBuffer = [];

// Paths to skip tracking (static files, health checks)
const SKIP_PATHS = [
  '/static',
  '/public',
  '/health',
  '/favicon.ico',
  '/assets',
  '/css',
  '/js',
  '/images'
];

/**
 * Track individual HTTP request
 *
 * Middleware function that measures request latency and buffers metrics.
 * Does NOT block request processing - uses event listener on response finish.
 *
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Next middleware
 */
function trackRequest(req, res, next) {
  // Skip static files and health checks
  if (SKIP_PATHS.some(path => req.path.startsWith(path))) {
    return next();
  }

  const start = Date.now();

  // Hook into response finish event (non-blocking)
  res.on('finish', () => {
    try {
      const latency = Date.now() - start;

      requestBuffer.push({
        path: req.path,
        method: req.method,
        status: res.statusCode,
        latency,
        timestamp: new Date()
      });

      // Log slow requests (> 2 seconds)
      if (latency > 2000) {
        logger.warn('Slow request detected', {
          path: req.path,
          method: req.method,
          latency,
          status: res.statusCode
        });
      }
    } catch (err) {
      // Don't let tracking errors break requests
      logger.error('Performance tracking error', { error: err.message });
    }
  });

  next();
}

/**
 * Flush buffered requests to database
 *
 * Aggregates buffered request data by hour and upserts to PerformanceSnapshot.
 * Runs asynchronously every 60 seconds via setInterval.
 *
 * Aggregations:
 * - Total, successful, failed request counts
 * - Latency statistics (min, max, avg, p95, p99)
 * - Per-endpoint breakdown
 * - Status code distribution
 */
async function flushToDatabase() {
  if (requestBuffer.length === 0) {
    return;
  }

  try {
    // Create copy and clear buffer atomically
    const requests = [...requestBuffer];
    requestBuffer.length = 0;

    const hour = new Date();
    hour.setMinutes(0, 0, 0); // Truncate to hour

    // Calculate aggregated metrics
    const summary = {
      hour,
      requests_total: requests.length,
      requests_successful: requests.filter(r => r.status >= 200 && r.status < 400).length,
      requests_failed: requests.filter(r => r.status >= 400).length,
      latency: calculateLatencyStats(requests),
      by_endpoint: groupByEndpoint(requests),
      by_status_code: groupByStatusCode(requests)
    };

    // Upsert to database (update if exists, insert if not)
    // Use $inc to increment counters, $set to update calculated fields
    const existingSnapshot = await PerformanceSnapshot.findOne({ hour });

    if (existingSnapshot) {
      // Merge with existing data
      existingSnapshot.requests_total += summary.requests_total;
      existingSnapshot.requests_successful += summary.requests_successful;
      existingSnapshot.requests_failed += summary.requests_failed;

      // Recalculate latency (merge new samples)
      const allLatencies = [
        ...Array(existingSnapshot.requests_total - summary.requests_total).fill(existingSnapshot.latency.avg || 0),
        ...requests.map(r => r.latency)
      ];
      existingSnapshot.latency = calculateLatencyStats(requests.map(r => ({ latency: r.latency })));

      // Merge endpoint data
      summary.by_endpoint.forEach(newEndpoint => {
        const existing = existingSnapshot.by_endpoint.find(
          e => e.path === newEndpoint.path && e.method === newEndpoint.method
        );

        if (existing) {
          existing.count += newEndpoint.count;
          existing.error_count += newEndpoint.error_count;
          // Recalculate average latency
          existing.avg_latency = (existing.avg_latency * existing.count + newEndpoint.avg_latency * newEndpoint.count) / (existing.count + newEndpoint.count);
        } else {
          existingSnapshot.by_endpoint.push(newEndpoint);
        }
      });

      // Merge status codes
      Object.entries(summary.by_status_code).forEach(([code, count]) => {
        existingSnapshot.by_status_code[code] = (existingSnapshot.by_status_code[code] || 0) + count;
      });

      await existingSnapshot.save();
    } else {
      // Create new snapshot
      await PerformanceSnapshot.create(summary);
    }

    logger.debug('Performance snapshot updated', {
      hour: hour.toISOString(),
      requests: summary.requests_total,
      avg_latency: summary.latency.avg
    });
  } catch (err) {
    logger.error('Performance snapshot flush failed', {
      error: err.message,
      buffer_size: requestBuffer.length
    });
  }
}

/**
 * Calculate latency statistics
 *
 * @param {Array} requests - Array of request objects with latency field
 * @returns {Object} Stats object with min, max, avg, p95, p99
 */
function calculateLatencyStats(requests) {
  if (!requests || requests.length === 0) {
    return { min: 0, max: 0, avg: 0, p95: 0, p99: 0 };
  }

  const latencies = requests.map(r => r.latency).sort((a, b) => a - b);

  const getPercentile = (p) => {
    const index = Math.ceil((p / 100) * latencies.length) - 1;
    return latencies[Math.max(0, index)];
  };

  const sum = latencies.reduce((acc, val) => acc + val, 0);

  return {
    min: latencies[0],
    max: latencies[latencies.length - 1],
    avg: Math.round(sum / latencies.length),
    p95: getPercentile(95),
    p99: getPercentile(99)
  };
}

/**
 * Group requests by endpoint (path + method)
 *
 * @param {Array} requests - Array of request objects
 * @returns {Array} Endpoint breakdown with count, avg_latency, error_count
 */
function groupByEndpoint(requests) {
  const endpoints = {};

  requests.forEach(req => {
    const key = `${req.method}:${req.path}`;

    if (!endpoints[key]) {
      endpoints[key] = {
        path: req.path,
        method: req.method,
        count: 0,
        latency_sum: 0,
        error_count: 0
      };
    }

    endpoints[key].count++;
    endpoints[key].latency_sum += req.latency;

    if (req.status >= 400) {
      endpoints[key].error_count++;
    }
  });

  // Convert to array and calculate averages
  return Object.values(endpoints).map(e => ({
    path: e.path,
    method: e.method,
    count: e.count,
    avg_latency: Math.round(e.latency_sum / e.count),
    error_count: e.error_count
  }));
}

/**
 * Group requests by HTTP status code
 *
 * @param {Array} requests - Array of request objects
 * @returns {Object} Status code counts (e.g., { "200": 1234, "500": 5 })
 */
function groupByStatusCode(requests) {
  const codes = {};

  requests.forEach(req => {
    const code = req.status.toString();
    codes[code] = (codes[code] || 0) + 1;
  });

  return codes;
}

/**
 * Get current buffer status (for debugging)
 *
 * @returns {Object} Buffer stats
 */
function getBufferStatus() {
  return {
    size: requestBuffer.length,
    oldest: requestBuffer.length > 0 ? requestBuffer[0].timestamp : null,
    newest: requestBuffer.length > 0 ? requestBuffer[requestBuffer.length - 1].timestamp : null
  };
}

// Start periodic flushing (every 60 seconds)
const flushInterval = setInterval(flushToDatabase, 60000);

// Graceful shutdown: flush on process exit
process.on('SIGTERM', async () => {
  clearInterval(flushInterval);
  await flushToDatabase();
  logger.info('Performance tracker shutdown complete');
});

process.on('SIGINT', async () => {
  clearInterval(flushInterval);
  await flushToDatabase();
  logger.info('Performance tracker shutdown complete');
});

module.exports = {
  trackRequest,
  flushToDatabase,
  getBufferStatus
};
