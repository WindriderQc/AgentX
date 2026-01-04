const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const PerformanceLoadTest = require('../models/PerformanceLoadTest');
const PerformanceBaseline = require('../models/PerformanceBaseline');
const PerformanceSnapshot = require('../models/PerformanceSnapshot');
const artilleryParser = require('../src/services/artilleryParser');

/**
 * Performance Monitoring Routes
 *
 * Provides API endpoints for performance benchmarking dashboard.
 * Integrates Artillery load test results, baselines, and real-time snapshots.
 *
 * @see /models/PerformanceLoadTest.js - Load test schema
 * @see /models/PerformanceBaseline.js - Baseline schema
 * @see /models/PerformanceSnapshot.js - Real-time metrics schema
 * @see /src/services/artilleryParser.js - Artillery JSON parser
 */

/**
 * GET /api/performance/dashboard
 *
 * Dashboard overview with system health metrics
 *
 * Returns:
 * - System health status
 * - Average latency (24h)
 * - Throughput (requests per second)
 * - Error rate
 * - Uptime percentage
 *
 * @returns {Object} Dashboard metrics
 */
router.get('/dashboard', async (req, res) => {
  try {
    logger.info('Fetching performance dashboard metrics');

    const hours = parseInt(req.query.hours) || 24;
    const startDate = new Date(Date.now() - hours * 60 * 60 * 1000);
    const now = new Date();

    // Fetch aggregated metrics from snapshots
    const metrics = await PerformanceSnapshot.getAggregatedMetrics(startDate, now);

    // Snapshot provenance (for UI transparency)
    const [snapshotsCount, lastSnapshot] = await Promise.all([
      PerformanceSnapshot.countDocuments({ hour: { $gte: startDate, $lte: now } }),
      PerformanceSnapshot.findOne({ hour: { $gte: startDate, $lte: now } })
        .sort({ hour: -1 })
        .select('hour requests_total')
        .lean()
    ]);

    // Endpoint-derived provenance (exact breakdown + semantic grouping)
    const endpointFacet = await PerformanceSnapshot.aggregate([
      {
        $match: {
          hour: { $gte: startDate, $lte: now }
        }
      },
      { $unwind: '$by_endpoint' },
      {
        $addFields: {
          endpoint_path: '$by_endpoint.path',
          endpoint_method: '$by_endpoint.method',
          endpoint_count: '$by_endpoint.count',
          endpoint_error_count: '$by_endpoint.error_count',
          endpoint_avg_latency: '$by_endpoint.avg_latency'
        }
      },
      {
        $addFields: {
          endpoint_is_api: {
            $regexMatch: {
              input: '$endpoint_path',
              regex: '^/api/'
            }
          }
        }
      },
      {
        $addFields: {
          endpoint_category: {
            $cond: [
              '$endpoint_is_api',
              {
                $switch: {
                  branches: [
                    { case: { $regexMatch: { input: '$endpoint_path', regex: '^/api/(chat|chatkit)(/|$)' } }, then: 'chat' },
                    { case: { $regexMatch: { input: '$endpoint_path', regex: '^/api/(conversation|conversations)(/|$)' } }, then: 'conversations' },
                    { case: { $regexMatch: { input: '$endpoint_path', regex: '^/api/(history)(/|$)' } }, then: 'history' },
                    { case: { $regexMatch: { input: '$endpoint_path', regex: '^/api/(rag|search)(/|$)' } }, then: 'rag' },
                    { case: { $regexMatch: { input: '$endpoint_path', regex: '^/api/(workflow|workflows|batch|batches|job|jobs|task|tasks)(/|$)' } }, then: 'batch_workflows' },
                    { case: { $regexMatch: { input: '$endpoint_path', regex: '^/api/(auth|login|logout|session|sessions)(/|$)' } }, then: 'auth' },
                    { case: { $regexMatch: { input: '$endpoint_path', regex: '^/api/(alerts)(/|$)' } }, then: 'alerts' },
                    { case: { $regexMatch: { input: '$endpoint_path', regex: '^/api/(metrics|performance)(/|$)' } }, then: 'metrics' },
                    { case: { $regexMatch: { input: '$endpoint_path', regex: '^/api/(admin|config|settings)(/|$)' } }, then: 'admin' }
                  ],
                  default: 'other_api'
                }
              },
              {
                $switch: {
                  branches: [
                    { case: { $regexMatch: { input: '$endpoint_path', regex: '^/batch(/|$)' } }, then: 'batch_ui' },
                    { case: { $regexMatch: { input: '$endpoint_path', regex: '^/(dashboard|active-stats)(/|$)' } }, then: 'ui_pages' },
                    { case: { $regexMatch: { input: '$endpoint_path', regex: '^/performance(/|$)' } }, then: 'ui_performance' }
                  ],
                  default: 'other_non_api'
                }
              }
            ]
          }
        }
      },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: '$endpoint_is_api',
                count: { $sum: '$endpoint_count' },
                error_count: { $sum: '$endpoint_error_count' }
              }
            }
          ],
          categories: [
            {
              $group: {
                _id: '$endpoint_category',
                count: { $sum: '$endpoint_count' },
                error_count: { $sum: '$endpoint_error_count' },
                latency_weighted_sum: {
                  $sum: {
                    $multiply: [
                      { $ifNull: ['$endpoint_avg_latency', 0] },
                      '$endpoint_count'
                    ]
                  }
                },
                latency_count_sum: { $sum: '$endpoint_count' }
              }
            },
            {
              $project: {
                _id: 0,
                category: '$_id',
                count: 1,
                error_count: 1,
                error_rate: {
                  $cond: [
                    { $gt: ['$count', 0] },
                    { $round: [{ $multiply: [{ $divide: ['$error_count', '$count'] }, 100] }, 2] },
                    0
                  ]
                },
                avg_latency: {
                  $cond: [
                    { $gt: ['$latency_count_sum', 0] },
                    { $round: [{ $divide: ['$latency_weighted_sum', '$latency_count_sum'] }, 0] },
                    0
                  ]
                }
              }
            },
            { $sort: { count: -1 } }
          ],
          top_endpoints: [
            {
              $group: {
                _id: { path: '$endpoint_path', method: '$endpoint_method' },
                count: { $sum: '$endpoint_count' },
                error_count: { $sum: '$endpoint_error_count' },
                latency_weighted_sum: {
                  $sum: {
                    $multiply: [
                      { $ifNull: ['$endpoint_avg_latency', 0] },
                      '$endpoint_count'
                    ]
                  }
                },
                latency_count_sum: { $sum: '$endpoint_count' }
              }
            },
            {
              $project: {
                _id: 0,
                path: '$_id.path',
                method: '$_id.method',
                count: 1,
                error_count: 1,
                error_rate: {
                  $cond: [
                    { $gt: ['$count', 0] },
                    { $round: [{ $multiply: [{ $divide: ['$error_count', '$count'] }, 100] }, 2] },
                    0
                  ]
                },
                avg_latency: {
                  $cond: [
                    { $gt: ['$latency_count_sum', 0] },
                    { $round: [{ $divide: ['$latency_weighted_sum', '$latency_count_sum'] }, 0] },
                    0
                  ]
                }
              }
            },
            { $sort: { count: -1 } },
            { $limit: 5 }
          ],
          top_error_endpoints: [
            {
              $group: {
                _id: { path: '$endpoint_path', method: '$endpoint_method' },
                count: { $sum: '$endpoint_count' },
                error_count: { $sum: '$endpoint_error_count' },
                latency_weighted_sum: {
                  $sum: {
                    $multiply: [
                      { $ifNull: ['$endpoint_avg_latency', 0] },
                      '$endpoint_count'
                    ]
                  }
                },
                latency_count_sum: { $sum: '$endpoint_count' }
              }
            },
            { $match: { count: { $gte: 20 } } },
            {
              $project: {
                _id: 0,
                path: '$_id.path',
                method: '$_id.method',
                count: 1,
                error_count: 1,
                error_rate: {
                  $cond: [
                    { $gt: ['$count', 0] },
                    { $round: [{ $multiply: [{ $divide: ['$error_count', '$count'] }, 100] }, 2] },
                    0
                  ]
                },
                avg_latency: {
                  $cond: [
                    { $gt: ['$latency_count_sum', 0] },
                    { $round: [{ $divide: ['$latency_weighted_sum', '$latency_count_sum'] }, 0] },
                    0
                  ]
                }
              }
            },
            { $sort: { error_rate: -1, error_count: -1, count: -1 } },
            { $limit: 5 }
          ],
          top_slow_endpoints: [
            {
              $group: {
                _id: { path: '$endpoint_path', method: '$endpoint_method' },
                count: { $sum: '$endpoint_count' },
                error_count: { $sum: '$endpoint_error_count' },
                latency_weighted_sum: {
                  $sum: {
                    $multiply: [
                      { $ifNull: ['$endpoint_avg_latency', 0] },
                      '$endpoint_count'
                    ]
                  }
                },
                latency_count_sum: { $sum: '$endpoint_count' }
              }
            },
            { $match: { count: { $gte: 20 } } },
            {
              $project: {
                _id: 0,
                path: '$_id.path',
                method: '$_id.method',
                count: 1,
                error_count: 1,
                error_rate: {
                  $cond: [
                    { $gt: ['$count', 0] },
                    { $round: [{ $multiply: [{ $divide: ['$error_count', '$count'] }, 100] }, 2] },
                    0
                  ]
                },
                avg_latency: {
                  $cond: [
                    { $gt: ['$latency_count_sum', 0] },
                    { $round: [{ $divide: ['$latency_weighted_sum', '$latency_count_sum'] }, 0] },
                    0
                  ]
                }
              }
            },
            { $match: { avg_latency: { $gt: 0 } } },
            { $sort: { avg_latency: -1, count: -1 } },
            { $limit: 5 }
          ]
        }
      }
    ]);

    const facet = Array.isArray(endpointFacet) && endpointFacet.length ? endpointFacet[0] : {};
    const totals = Array.isArray(facet.totals) ? facet.totals : [];
    const categories = Array.isArray(facet.categories) ? facet.categories : [];
    const topEndpoints = (Array.isArray(facet.top_endpoints) ? facet.top_endpoints : [])
      .map(e => ({
        path: e?.path,
        method: e?.method,
        count: e?.count || 0,
        error_count: e?.error_count || 0,
        error_rate: Number.isFinite(e?.error_rate) ? e.error_rate : 0,
        avg_latency: e?.avg_latency || 0
      }))
      .filter(e => typeof e.path === 'string' && e.path.length > 0);

    const topErrorEndpoints = (Array.isArray(facet.top_error_endpoints) ? facet.top_error_endpoints : [])
      .map(e => ({
        path: e?.path,
        method: e?.method,
        count: e?.count || 0,
        error_count: e?.error_count || 0,
        error_rate: Number.isFinite(e?.error_rate) ? e.error_rate : 0,
        avg_latency: e?.avg_latency || 0
      }))
      .filter(e => typeof e.path === 'string' && e.path.length > 0);

    const topSlowEndpoints = (Array.isArray(facet.top_slow_endpoints) ? facet.top_slow_endpoints : [])
      .map(e => ({
        path: e?.path,
        method: e?.method,
        count: e?.count || 0,
        error_count: e?.error_count || 0,
        error_rate: Number.isFinite(e?.error_rate) ? e.error_rate : 0,
        avg_latency: e?.avg_latency || 0
      }))
      .filter(e => typeof e.path === 'string' && e.path.length > 0);

    const breakdown = {
      api_requests: 0,
      non_api_requests: 0,
      total_endpoint_requests: 0,
      delta_vs_total_requests: 0
    };
    for (const t of totals) {
      const isApi = !!t?._id;
      const count = t?.count || 0;
      breakdown.total_endpoint_requests += count;
      if (isApi) breakdown.api_requests += count;
      else breakdown.non_api_requests += count;
    }

    const totalRequests = metrics?.total_requests || 0;
    breakdown.delta_vs_total_requests = breakdown.total_endpoint_requests - totalRequests;

    // Fetch latest load test result
    const latestLoadTest = await PerformanceLoadTest.getLatest();

    // Fetch active baseline for comparison
    const activeBaseline = await PerformanceBaseline.getActive();

    // Calculate system health
    const systemHealth = calculateSystemHealth(metrics, activeBaseline);

    // Get throughput trend
    const throughputTrend = await PerformanceSnapshot.getThroughputTrend(hours);
    const avgRps = throughputTrend.length > 0
      ? throughputTrend.reduce((sum, t) => sum + parseFloat(t.rps), 0) / throughputTrend.length
      : 0;

    // Calculate uptime (percentage of successful requests)
    const uptimePercent = metrics && metrics.total_requests > 0
      ? ((metrics.total_successful / metrics.total_requests) * 100).toFixed(2)
      : 100;

    const dashboard = {
      status: 'success',
      data: {
        system_health: systemHealth,
        metrics_24h: {
          avg_latency: metrics?.avg_latency || 0,
          p95_latency: metrics?.avg_p95 || 0,
          p99_latency: metrics?.avg_p99 || 0,
          error_rate: metrics?.error_rate || 0,
          total_requests: metrics?.total_requests || 0,
          throughput_rps: parseFloat(avgRps.toFixed(2)),
          uptime_percent: parseFloat(uptimePercent)
        },
        latest_load_test: latestLoadTest ? {
          name: latestLoadTest.name,
          scenario: latestLoadTest.scenario,
          timestamp: latestLoadTest.timestamp,
          p95_latency: latestLoadTest.latency.p95,
          error_rate: latestLoadTest.summary.error_rate
        } : null,
        active_baseline: activeBaseline ? {
          name: activeBaseline.name,
          p95_latency: activeBaseline.metrics.p95_latency,
          error_rate: activeBaseline.metrics.error_rate
        } : null,
        sources: {
          production: {
            hours,
            snapshots: snapshotsCount,
            total_requests: metrics?.total_requests || 0,
            last_snapshot_hour: lastSnapshot?.hour || null,
            breakdown,
            category_breakdown: categories,
            top_endpoints: topEndpoints,
            top_error_endpoints: topErrorEndpoints,
            top_slow_endpoints: topSlowEndpoints
          },
          latest_load_test: latestLoadTest ? {
            name: latestLoadTest.name,
            scenario: latestLoadTest.scenario,
            timestamp: latestLoadTest.timestamp
          } : null,
          active_baseline: activeBaseline ? {
            name: activeBaseline.name
          } : null,
          tracking_scope: 'Non-static, non-health HTTP requests (middleware-based)'
        }
      }
    };

    res.json(dashboard);
  } catch (err) {
    logger.error('Dashboard metrics fetch failed', { error: err.message });
    res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
});

/**
 * GET /api/performance/load-tests
 *
 * List load test history with optional filtering
 *
 * Query params:
 * - limit: Number of results (default: 20)
 * - scenario: Filter by scenario name
 *
 * @returns {Array} Load test records
 */
router.get('/load-tests', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const scenario = req.query.scenario;

    logger.info('Fetching load test history', { limit, scenario });

    const tests = await PerformanceLoadTest.findRecentByScenario(scenario, limit);

    res.json({
      status: 'success',
      data: {
        tests,
        count: tests.length
      }
    });
  } catch (err) {
    logger.error('Load test fetch failed', { error: err.message });
    res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
});

/**
 * POST /api/performance/load-tests
 *
 * Import Artillery JSON report and create load test record
 *
 * Body:
 * - name: Test name (required)
 * - scenario: Scenario name (optional, default: "unknown")
 * - raw_report: Artillery JSON output (required)
 * - timestamp: Test execution time (optional, default: now)
 *
 * @returns {Object} Created load test document
 */
router.post('/load-tests', async (req, res) => {
  try {
    const { name, scenario, raw_report, timestamp } = req.body;

    // Validate required fields
    if (!name) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required field: name'
      });
    }

    if (!raw_report) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required field: raw_report'
      });
    }

    logger.info('Importing Artillery report', { name, scenario });

    // Validate Artillery report structure
    const validation = artilleryParser.validateReport(raw_report);
    if (!validation.valid) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid Artillery report',
        errors: validation.errors
      });
    }

    // Parse Artillery JSON
    const parsed = artilleryParser.parseArtilleryReport(raw_report);

    // Create load test record
    const loadTest = new PerformanceLoadTest({
      name,
      scenario: scenario || 'unknown',
      config: parsed.config,
      summary: parsed.summary,
      latency: parsed.latency,
      codes: parsed.codes,
      errors: parsed.errors,
      raw_report,
      timestamp: timestamp ? new Date(timestamp) : new Date()
    });

    await loadTest.save();

    logger.info('Load test imported successfully', {
      id: loadTest._id,
      name: loadTest.name,
      requests: parsed.summary.requests_completed
    });

    res.status(201).json({
      status: 'success',
      data: {
        id: loadTest._id,
        name: loadTest.name,
        scenario: loadTest.scenario,
        summary: loadTest.summary,
        latency: loadTest.latency
      }
    });
  } catch (err) {
    logger.error('Load test import failed', { error: err.message });
    res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
});

/**
 * GET /api/performance/latency-trends
 *
 * Get latency trends over time
 *
 * Query params:
 * - hours: Lookback period (default: 24)
 * - endpoint: Filter by specific endpoint (optional)
 *
 * @returns {Array} Time-series latency data
 */
router.get('/latency-trends', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const endpoint = req.query.endpoint;

    logger.info('Fetching latency trends', { hours, endpoint });

    const trends = await PerformanceSnapshot.getLatencyTrend(hours, endpoint);

    res.json({
      status: 'success',
      data: {
        trends,
        count: trends.length,
        hours,
        endpoint: endpoint || 'all'
      }
    });
  } catch (err) {
    logger.error('Latency trends fetch failed', { error: err.message });
    res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
});

/**
 * GET /api/performance/throughput
 *
 * Get throughput trends (requests per second)
 *
 * Query params:
 * - hours: Lookback period (default: 24)
 *
 * @returns {Array} Time-series throughput data
 */
router.get('/throughput', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;

    logger.info('Fetching throughput trends', { hours });

    const throughput = await PerformanceSnapshot.getThroughputTrend(hours);

    res.json({
      status: 'success',
      data: {
        throughput,
        count: throughput.length,
        hours
      }
    });
  } catch (err) {
    logger.error('Throughput fetch failed', { error: err.message });
    res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
});

/**
 * GET /api/performance/percentiles
 *
 * Get percentile breakdown for endpoint
 *
 * Query params:
 * - endpoint: Endpoint path (optional, default: system-wide)
 * - hours: Lookback period (default: 24)
 *
 * @returns {Object} Percentile breakdown with histogram data
 */
router.get('/percentiles', async (req, res) => {
  try {
    const endpoint = req.query.endpoint;
    const hours = parseInt(req.query.hours) || 24;

    logger.info('Fetching percentile breakdown', { endpoint, hours });

    const trends = await PerformanceSnapshot.getLatencyTrend(hours, endpoint);

    // Extract all latency values for percentile calculation
    const latencies = trends
      .map(t => [t.p50, t.p95, t.p99])
      .flat()
      .filter(v => v > 0);

    const percentiles = PerformanceSnapshot.calculatePercentiles(latencies);

    // Build histogram buckets
    const histogram = buildHistogram(latencies);

    res.json({
      status: 'success',
      data: {
        percentiles,
        histogram,
        sample_size: latencies.length,
        endpoint: endpoint || 'all',
        hours
      }
    });
  } catch (err) {
    logger.error('Percentiles fetch failed', { error: err.message });
    res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
});

/**
 * GET /api/performance/endpoints
 *
 * List known endpoint paths observed in performance snapshots.
 *
 * Query params:
 * - hours: Lookback window (default: 24)
 *
 * @returns {Array<String>} Endpoint paths
 */
router.get('/endpoints', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const startDate = new Date(Date.now() - hours * 60 * 60 * 1000);

    logger.info('Fetching known endpoints', { hours });

    const endpoints = await PerformanceSnapshot.aggregate([
      {
        $match: {
          hour: { $gte: startDate }
        }
      },
      { $unwind: '$by_endpoint' },
      {
        $group: {
          _id: '$by_endpoint.path'
        }
      },
      { $sort: { _id: 1 } }
    ]);

    const paths = endpoints
      .map(e => e._id)
      .filter(p => typeof p === 'string' && p.length > 0);

    res.json({
      status: 'success',
      data: paths,
      count: paths.length,
      hours
    });
  } catch (err) {
    logger.error('Endpoints fetch failed', { error: err.message });
    res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
});

/**
 * GET /api/performance/baselines
 *
 * List all performance baselines
 *
 * @returns {Array} Baseline records
 */
router.get('/baselines', async (req, res) => {
  try {
    logger.info('Fetching performance baselines');

    const baselines = await PerformanceBaseline.listAll();

    res.json({
      status: 'success',
      data: {
        baselines,
        count: baselines.length
      }
    });
  } catch (err) {
    logger.error('Baselines fetch failed', { error: err.message });
    res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
});

/**
 * POST /api/performance/baselines
 *
 * Create new performance baseline
 *
 * Body:
 * - name: Baseline name (required)
 * - description: Description (optional)
 * - metrics: Baseline metrics (required)
 * - endpoints: Per-endpoint baselines (optional)
 * - source: Source type (optional: manual, load_test, production_sample)
 * - source_test_id: Reference to load test (optional)
 * - activate: Set as active baseline (optional, default: false)
 *
 * @returns {Object} Created baseline document
 */
router.post('/baselines', async (req, res) => {
  try {
    const { name, description, metrics, endpoints, source, source_test_id, activate, loadTestId } = req.body;

    // Validate required fields
    if (!name) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required field: name'
      });
    }

    // Allow creating baselines from a load test without explicitly supplying metrics.
    // UI may send loadTestId when source is load_test.
    let resolvedMetrics = metrics;
    let resolvedSourceTestId = source_test_id || loadTestId;

    if (!resolvedMetrics) {
      if (resolvedSourceTestId) {
        const loadTest = await PerformanceLoadTest.findById(resolvedSourceTestId);
        if (!loadTest) {
          return res.status(404).json({
            status: 'error',
            message: 'Load test not found'
          });
        }
        resolvedMetrics = {
          avg_response_time: loadTest.latency?.median || 0,
          p95_latency: loadTest.latency?.p95 || 0,
          error_rate: loadTest.summary?.error_rate || 0,
          throughput_rps: loadTest.summary?.rps_mean || 0
        };
      } else {
        return res.status(400).json({
          status: 'error',
          message: 'Missing required metrics or loadTestId'
        });
      }
    }

    if (
      resolvedMetrics.avg_response_time === undefined ||
      resolvedMetrics.p95_latency === undefined ||
      resolvedMetrics.error_rate === undefined ||
      resolvedMetrics.throughput_rps === undefined
    ) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required metrics: avg_response_time, p95_latency, error_rate, throughput_rps'
      });
    }

    logger.info('Creating performance baseline', { name, source });

    const baseline = new PerformanceBaseline({
      name,
      description,
      metrics: resolvedMetrics,
      endpoints: endpoints || [],
      source: source || (resolvedSourceTestId ? 'load_test' : 'manual'),
      source_test_id: resolvedSourceTestId
    });

    await baseline.save();

    // Activate if requested
    if (activate) {
      await PerformanceBaseline.setActive(baseline._id);
      baseline.active = true;
    }

    logger.info('Baseline created successfully', {
      id: baseline._id,
      name: baseline.name,
      active: baseline.active
    });

    res.status(201).json({
      status: 'success',
      data: baseline
    });
  } catch (err) {
    logger.error('Baseline creation failed', { error: err.message });
    res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
});

/**
 * GET /api/performance/baseline-compare
 *
 * Compare current metrics against baseline
 *
 * Query params:
 * - baseline_id: Baseline to compare against (optional, uses active if not specified)
 * - hours: Lookback period for current metrics (default: 24)
 *
 * @returns {Object} Comparison results with regression detection
 */
router.get('/baseline-compare', async (req, res) => {
  try {
    const baselineId = req.query.baseline_id;
    const hours = parseInt(req.query.hours) || 24;

    logger.info('Comparing against baseline', { baselineId, hours });

    // Get baseline (active or specified)
    let baseline;
    if (baselineId) {
      baseline = await PerformanceBaseline.findById(baselineId);
    } else {
      baseline = await PerformanceBaseline.getActive();
    }

    if (!baseline) {
      return res.status(404).json({
        status: 'error',
        message: 'No baseline found'
      });
    }

    // Get current metrics
    const startDate = new Date(Date.now() - hours * 60 * 60 * 1000);
    const currentMetrics = await PerformanceSnapshot.getAggregatedMetrics(startDate, new Date());

    if (!currentMetrics) {
      return res.status(404).json({
        status: 'error',
        message: 'No current metrics available'
      });
    }

    // Calculate differences
    const comparison = {
      baseline: {
        name: baseline.name,
        metrics: baseline.metrics
      },
      current: {
        avg_response_time: currentMetrics.avg_latency,
        p95_latency: currentMetrics.avg_p95,
        error_rate: currentMetrics.error_rate,
        throughput_rps: (currentMetrics.total_requests / (hours * 3600)).toFixed(2)
      },
      diff_percentage: {
        avg_response_time: calculateDiff(currentMetrics.avg_latency, baseline.metrics.avg_response_time),
        p95_latency: calculateDiff(currentMetrics.avg_p95, baseline.metrics.p95_latency),
        error_rate: calculateDiff(currentMetrics.error_rate, baseline.metrics.error_rate),
        throughput_rps: calculateDiff(
          currentMetrics.total_requests / (hours * 3600),
          baseline.metrics.throughput_rps
        )
      }
    };

    // Detect regressions
    const regressions = [];

    if (currentMetrics.avg_p95 > baseline.metrics.p95_latency * 1.2) {
      regressions.push({
        metric: 'p95_latency',
        threshold: '20% increase',
        current: currentMetrics.avg_p95,
        baseline: baseline.metrics.p95_latency
      });
    }

    if (currentMetrics.error_rate > baseline.metrics.error_rate * 2) {
      regressions.push({
        metric: 'error_rate',
        threshold: '2x increase',
        current: currentMetrics.error_rate,
        baseline: baseline.metrics.error_rate
      });
    }

    comparison.regression_detected = regressions.length > 0;
    comparison.regressions = regressions;

    res.json({
      status: 'success',
      data: comparison
    });
  } catch (err) {
    logger.error('Baseline comparison failed', { error: err.message });
    res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Calculate system health based on metrics and baseline
 *
 * @param {Object} metrics - Current metrics
 * @param {Object} baseline - Active baseline
 * @returns {String} Health status (healthy, degraded, unhealthy)
 */
function calculateSystemHealth(metrics, baseline) {
  if (!metrics) {
    return 'unknown';
  }

  // Check error rate
  if (metrics.error_rate > 5) {
    return 'unhealthy';
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
 * Calculate percentage difference
 *
 * @param {Number} current - Current value
 * @param {Number} baseline - Baseline value
 * @returns {String} Percentage difference
 */
function calculateDiff(current, baseline) {
  if (!baseline || baseline === 0) {
    return '0.00';
  }
  return ((current / baseline - 1) * 100).toFixed(2);
}

/**
 * Build histogram buckets from latency values
 *
 * @param {Array<Number>} latencies - Array of latency values
 * @returns {Array} Histogram buckets
 */
function buildHistogram(latencies) {
  if (!latencies || latencies.length === 0) {
    return [];
  }

  // Define buckets (in milliseconds)
  const buckets = [
    { label: '0-50ms', min: 0, max: 50 },
    { label: '50-100ms', min: 50, max: 100 },
    { label: '100-200ms', min: 100, max: 200 },
    { label: '200-500ms', min: 200, max: 500 },
    { label: '500-1000ms', min: 500, max: 1000 },
    { label: '1000-2000ms', min: 1000, max: 2000 },
    { label: '2000ms+', min: 2000, max: Infinity }
  ];

  // Count latencies in each bucket
  const histogram = buckets.map(bucket => ({
    label: bucket.label,
    count: latencies.filter(l => l >= bucket.min && l < bucket.max).length
  }));

  return histogram;
}

module.exports = router;
