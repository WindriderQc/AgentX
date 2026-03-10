/**
 * Inference Telemetry Routes
 * Provides aggregated views of all Ollama inference calls across hosts.
 * Data is written by modelRouter.recordInference() after each call.
 *
 * GET /api/telemetry/recent          — last N inference calls
 * GET /api/telemetry/host-summary    — per-host aggregates
 * GET /api/telemetry/model-summary   — per-model aggregates
 * GET /api/telemetry/caller-summary  — per-caller aggregates
 * GET /api/telemetry/timeline        — time-bucketed series for charts
 */

const express = require('express');
const router = express.Router();
const InferenceLog = require('../models/InferenceLog');
const { attachUser } = require('../src/middleware/auth');

router.use(attachUser);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseTimeRange(query) {
    const hours = Math.min(parseInt(query.hours || '24', 10), 720); // max 30 days
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    return { hours, since };
}

function hostLabel(hostUrl) {
    if (!hostUrl) return 'unknown';
    if (hostUrl.includes('192.168.2.66')) return 'UGClawdX';
    if (hostUrl.includes('192.168.2.12')) return 'UGBrutal';
    if (hostUrl.includes('192.168.2.99')) return 'UGFrank';
    // Fallback: extract host:port
    try {
        const u = new URL(hostUrl);
        return u.hostname;
    } catch (_) {
        return hostUrl;
    }
}

// ---------------------------------------------------------------------------
// GET /api/telemetry/recent
// ---------------------------------------------------------------------------
router.get('/recent', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '50', 10), 500);
        const { since } = parseTimeRange(req.query);

        const filter = { timestamp: { $gte: since } };
        if (req.query.host) filter.host = req.query.host;
        if (req.query.model) filter.model = req.query.model;
        if (req.query.caller) filter.caller = req.query.caller;
        if (req.query.status) filter.status = req.query.status;

        const logs = await InferenceLog.find(filter)
            .sort({ timestamp: -1 })
            .limit(limit)
            .lean();

        res.json({
            count: logs.length,
            logs: logs.map(l => ({
                id: l._id,
                host: l.host,
                hostLabel: hostLabel(l.host),
                hostKey: l.hostKey,
                model: l.model,
                caller: l.caller,
                callerDetail: l.callerDetail,
                taskType: l.taskType,
                tokensIn: l.tokensIn,
                tokensOut: l.tokensOut,
                durationMs: l.durationMs,
                fallbackUsed: l.fallbackUsed,
                fallbackReason: l.fallbackReason,
                status: l.status,
                error: l.error,
                timestamp: l.timestamp
            }))
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ---------------------------------------------------------------------------
// GET /api/telemetry/host-summary
// ---------------------------------------------------------------------------
router.get('/host-summary', async (req, res) => {
    try {
        const { since, hours } = parseTimeRange(req.query);

        const agg = await InferenceLog.aggregate([
            { $match: { timestamp: { $gte: since } } },
            {
                $group: {
                    _id: { host: '$host', hostKey: '$hostKey' },
                    calls: { $sum: 1 },
                    successCalls: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
                    errorCalls: { $sum: { $cond: [{ $ne: ['$status', 'success'] }, 1, 0] } },
                    fallbacks: { $sum: { $cond: ['$fallbackUsed', 1, 0] } },
                    tokensIn: { $sum: '$tokensIn' },
                    tokensOut: { $sum: '$tokensOut' },
                    totalDurationMs: { $sum: '$durationMs' },
                    avgDurationMs: { $avg: '$durationMs' },
                    minDurationMs: { $min: '$durationMs' },
                    maxDurationMs: { $max: '$durationMs' },
                    models: { $addToSet: '$model' }
                }
            },
            { $sort: { calls: -1 } }
        ]);

        const wallClockMs = hours * 60 * 60 * 1000;

        res.json({
            windowHours: hours,
            since,
            hosts: agg.map(h => ({
                host: h._id.host,
                hostLabel: hostLabel(h._id.host),
                hostKey: h._id.hostKey,
                calls: h.calls,
                successCalls: h.successCalls,
                errorCalls: h.errorCalls,
                errorRate: h.calls > 0 ? (h.errorCalls / h.calls) : 0,
                fallbacks: h.fallbacks,
                tokensIn: h.tokensIn,
                tokensOut: h.tokensOut,
                totalTokens: h.tokensIn + h.tokensOut,
                totalDurationMs: h.totalDurationMs,
                avgDurationMs: Math.round(h.avgDurationMs || 0),
                minDurationMs: h.minDurationMs,
                maxDurationMs: h.maxDurationMs,
                // Utilization: fraction of wall-clock time spent on inference
                utilizationPct: wallClockMs > 0
                    ? Math.min(100, Math.round((h.totalDurationMs / wallClockMs) * 100))
                    : 0,
                models: h.models.sort()
            }))
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ---------------------------------------------------------------------------
// GET /api/telemetry/model-summary
// ---------------------------------------------------------------------------
router.get('/model-summary', async (req, res) => {
    try {
        const { since, hours } = parseTimeRange(req.query);

        const agg = await InferenceLog.aggregate([
            { $match: { timestamp: { $gte: since } } },
            {
                $group: {
                    _id: { model: '$model', host: '$host' },
                    calls: { $sum: 1 },
                    tokensIn: { $sum: '$tokensIn' },
                    tokensOut: { $sum: '$tokensOut' },
                    totalDurationMs: { $sum: '$durationMs' },
                    avgDurationMs: { $avg: '$durationMs' },
                    errors: { $sum: { $cond: [{ $ne: ['$status', 'success'] }, 1, 0] } }
                }
            },
            { $sort: { calls: -1 } },
            { $limit: 50 }
        ]);

        res.json({
            windowHours: hours,
            models: agg.map(m => ({
                model: m._id.model,
                host: m._id.host,
                hostLabel: hostLabel(m._id.host),
                calls: m.calls,
                tokensIn: m.tokensIn,
                tokensOut: m.tokensOut,
                totalDurationMs: m.totalDurationMs,
                avgDurationMs: Math.round(m.avgDurationMs || 0),
                errors: m.errors
            }))
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ---------------------------------------------------------------------------
// GET /api/telemetry/caller-summary
// ---------------------------------------------------------------------------
router.get('/caller-summary', async (req, res) => {
    try {
        const { since, hours } = parseTimeRange(req.query);

        const agg = await InferenceLog.aggregate([
            { $match: { timestamp: { $gte: since } } },
            {
                $group: {
                    _id: { caller: '$caller', callerDetail: '$callerDetail' },
                    calls: { $sum: 1 },
                    tokensIn: { $sum: '$tokensIn' },
                    tokensOut: { $sum: '$tokensOut' },
                    totalDurationMs: { $sum: '$durationMs' },
                    hosts: { $addToSet: '$host' },
                    models: { $addToSet: '$model' }
                }
            },
            { $sort: { calls: -1 } },
            { $limit: 100 }
        ]);

        res.json({
            windowHours: hours,
            callers: agg.map(c => ({
                caller: c._id.caller,
                callerDetail: c._id.callerDetail,
                calls: c.calls,
                tokensIn: c.tokensIn,
                tokensOut: c.tokensOut,
                totalDurationMs: c.totalDurationMs,
                hosts: c.hosts.map(h => hostLabel(h)),
                models: c.models.sort()
            }))
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ---------------------------------------------------------------------------
// GET /api/telemetry/timeline
// Query params:
//   hours   — lookback window (default 24, max 720)
//   bucket  — 'hour' | 'day' (default 'hour')
//   host    — filter by host URL (optional)
// ---------------------------------------------------------------------------
router.get('/timeline', async (req, res) => {
    try {
        const { since, hours } = parseTimeRange(req.query);
        const bucket = req.query.bucket === 'day' ? 'day' : 'hour';

        const dateFormat = bucket === 'day'
            ? { year: '$year', month: '$month', day: '$dayOfMonth' }
            : { year: '$year', month: '$month', day: '$dayOfMonth', hour: '$hour' };

        const match = { timestamp: { $gte: since } };
        if (req.query.host) match.host = req.query.host;

        const agg = await InferenceLog.aggregate([
            { $match: match },
            {
                $group: {
                    _id: {
                        bucket: { $dateToString: {
                            format: bucket === 'day' ? '%Y-%m-%d' : '%Y-%m-%dT%H:00',
                            date: '$timestamp'
                        }},
                        host: '$host'
                    },
                    calls: { $sum: 1 },
                    tokensOut: { $sum: '$tokensOut' },
                    totalDurationMs: { $sum: '$durationMs' },
                    errors: { $sum: { $cond: [{ $ne: ['$status', 'success'] }, 1, 0] } }
                }
            },
            { $sort: { '_id.bucket': 1 } }
        ]);

        // Reshape into series per host
        const seriesMap = {};
        for (const row of agg) {
            const label = hostLabel(row._id.host);
            if (!seriesMap[label]) seriesMap[label] = [];
            seriesMap[label].push({
                bucket: row._id.bucket,
                calls: row.calls,
                tokensOut: row.tokensOut,
                totalDurationMs: row.totalDurationMs,
                errors: row.errors
            });
        }

        res.json({
            windowHours: hours,
            bucketSize: bucket,
            series: seriesMap
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ---------------------------------------------------------------------------
// GET /api/telemetry/stats
// Quick summary card data for the dashboard header
// ---------------------------------------------------------------------------
router.get('/stats', async (req, res) => {
    try {
        const { since, hours } = parseTimeRange(req.query);

        const [totals, fallbackCount, errorCount] = await Promise.all([
            InferenceLog.aggregate([
                { $match: { timestamp: { $gte: since } } },
                {
                    $group: {
                        _id: null,
                        totalCalls: { $sum: 1 },
                        totalTokensIn: { $sum: '$tokensIn' },
                        totalTokensOut: { $sum: '$tokensOut' },
                        totalDurationMs: { $sum: '$durationMs' },
                        avgDurationMs: { $avg: '$durationMs' }
                    }
                }
            ]),
            InferenceLog.countDocuments({ timestamp: { $gte: since }, fallbackUsed: true }),
            InferenceLog.countDocuments({ timestamp: { $gte: since }, status: { $ne: 'success' } })
        ]);

        const t = totals[0] || { totalCalls: 0, totalTokensIn: 0, totalTokensOut: 0, totalDurationMs: 0, avgDurationMs: 0 };

        res.json({
            windowHours: hours,
            since,
            totalCalls: t.totalCalls,
            totalTokensIn: t.totalTokensIn,
            totalTokensOut: t.totalTokensOut,
            totalTokens: t.totalTokensIn + t.totalTokensOut,
            totalDurationMs: t.totalDurationMs,
            avgDurationMs: Math.round(t.avgDurationMs || 0),
            fallbackCount,
            errorCount,
            fallbackRate: t.totalCalls > 0 ? (fallbackCount / t.totalCalls) : 0,
            errorRate: t.totalCalls > 0 ? (errorCount / t.totalCalls) : 0
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

module.exports = router;
