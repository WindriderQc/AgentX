const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));
const logger = require('../config/logger');
const { getEmbeddingsService } = require('../src/services/embeddings');
let EmbeddingCacheStats;
try {
    EmbeddingCacheStats = require('../models/EmbeddingCacheStats');
} catch (_e) {
    EmbeddingCacheStats = null;
}

// Environment variables
const OLLAMA_HOST = process.env.OLLAMA_HOST;
const OLLAMA_HOST_2 = process.env.OLLAMA_HOST_2;
const DATAAPI_BASE_URL = process.env.DATAAPI_BASE_URL || 'http://192.168.2.33:3003';
const DATAAPI_API_KEY = process.env.DATAAPI_API_KEY;

function formatUptime(seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    const days = Math.floor(s / 86400);
    const hours = Math.floor((s % 86400) / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours || days) parts.push(`${hours}h`);
    parts.push(`${minutes}m`);
    return parts.join(' ');
}

function formatBytes(bytes) {
    const b = Number(bytes) || 0;
    if (b === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(b) / Math.log(k));
    return `${(b / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

if (!DATAAPI_API_KEY) {
    logger.warn('DATAAPI_API_KEY not set - dashboard scans proxy will not work');
}

// Helper to check URL with optional headers
async function checkUrl(url, options = {}) {
    const timeout = options.timeout || 3000;
    const headers = options.headers || {};
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers
        });
        clearTimeout(timeoutId);
        return { status: response.ok ? 'online' : 'error', code: response.status };
    } catch (err) {
        clearTimeout(timeoutId);
        return { status: 'offline', error: err.message };
    }
}

/**
 * GET /api/dashboard/health
 * Aggregated health check for dashboard - checks all SBQC Stack components
 */
router.get('/health', async (req, res) => {
    const status = {
        agentx: {
            status: 'ok',
            uptime: process.uptime(),
            memory: process.memoryUsage()
        },
        mongodb: {
            status: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
            host: mongoose.connection.host
        },
        ollama_primary: {
            status: 'unknown',
            host: OLLAMA_HOST,
            models: []
        },
        ollama_secondary: {
            status: 'unknown',
            host: OLLAMA_HOST_2,
            models: []
        },
        timestamp: new Date().toISOString()
    };

    // Check both Ollama hosts in parallel
    const ollamaChecks = await Promise.allSettled([
        (async () => {
            try {
                const tagsResponse = await checkUrl(`${OLLAMA_HOST}/api/tags`);
                status.ollama_primary.status = tagsResponse.status;
                if (tagsResponse.status === 'online') {
                    const modelsRes = await fetch(`${OLLAMA_HOST}/api/tags`);
                    if (modelsRes.ok) {
                        const data = await modelsRes.json();
                        status.ollama_primary.models = (data.models || []).map(m => m.name);
                    }
                }
            } catch (err) {
                status.ollama_primary.status = 'error';
                logger.warn('Failed to check Ollama primary', { error: err.message });
            }
        })(),
        (async () => {
            try {
                const tagsResponse = await checkUrl(`${OLLAMA_HOST_2}/api/tags`);
                status.ollama_secondary.status = tagsResponse.status;
                if (tagsResponse.status === 'online') {
                    const modelsRes = await fetch(`${OLLAMA_HOST_2}/api/tags`);
                    if (modelsRes.ok) {
                        const data = await modelsRes.json();
                        status.ollama_secondary.models = (data.models || []).map(m => m.name);
                    }
                }
            } catch (err) {
                status.ollama_secondary.status = 'error';
                logger.warn('Failed to check Ollama secondary', { error: err.message });
            }
        })()
    ]);


    // Calculate overall health
    const allOnline =
        status.mongodb.status === 'connected' &&
        (status.ollama_primary.status === 'online' || status.ollama_secondary.status === 'online');

    status.overall = allOnline ? 'healthy' : 'degraded';

    res.json({
        status: 'success',
        data: status
    });
});

/**
 * GET /api/dashboard/summary
 * Batched endpoint for the UI to reduce polling chattiness.
 * Intentionally excludes expensive per-collection counting.
 */
router.get('/summary', async (req, res) => {
    const eventsLimit = Number(req.query.eventsLimit || 15);
    const scansLimit = Number(req.query.scansLimit || 5);

    try {
        // --- Metrics summary (same shape as /api/metrics/summary) ---
        const embeddings = getEmbeddingsService();
        const cacheStats = embeddings.getCacheStats() || {};
        let hitCount = Number(cacheStats.hitCount) || 0;
        let missCount = Number(cacheStats.missCount) || 0;
        let evictionCount = Number(cacheStats.evictionCount) || 0;

        if (EmbeddingCacheStats && mongoose.connection.readyState === 1) {
            const global = await EmbeddingCacheStats.findById('embedding').lean();
            if (global) {
                hitCount = Number(global.hitCount) || hitCount;
                missCount = Number(global.missCount) || missCount;
                evictionCount = Number(global.evictionCount) || evictionCount;
            }
        }
        const total = hitCount + missCount;
        const hitRate = total > 0 ? hitCount / total : 0;

        const connected = mongoose.connection.readyState === 1 && mongoose.connection.db;
        let serverStatus;
        if (connected) {
            try {
                serverStatus = await mongoose.connection.db.admin().serverStatus();
            } catch (_e) {
                serverStatus = null;
            }
        }
        const current = Number(serverStatus?.connections?.current) || 0;
        const available = Number(serverStatus?.connections?.available) || 0;
        const maxConnections = current + available;
        const options = mongoose.connection.client?.options || {};
        const minPoolSize = Number(options.minPoolSize) || 0;

        const mem = process.memoryUsage();
        const seconds = process.uptime();

        const metrics = {
            cache: {
                size: Number(cacheStats.size) || 0,
                maxSize: Number(cacheStats.maxSize) || 0,
                hitCount,
                missCount,
                evictions: evictionCount,
                hitRate,
                ttlMs: Number(cacheStats.ttl) || 0
            },
            connection: {
                host: mongoose.connection.host,
                port: mongoose.connection.port,
                readyState: mongoose.connection.readyState,
                activeConnections: current,
                availableConnections: available,
                poolSize: maxConnections,
                minPoolSize
            },
            system: {
                uptime: {
                    seconds,
                    formatted: formatUptime(seconds)
                },
                nodeVersion: process.version,
                platform: process.platform,
                memory: {
                    rss: mem.rss,
                    heapTotal: mem.heapTotal,
                    heapUsed: mem.heapUsed,
                    formatted: {
                        rss: formatBytes(mem.rss),
                        heapTotal: formatBytes(mem.heapTotal),
                        heapUsed: formatBytes(mem.heapUsed)
                    }
                },
                timestamp: new Date().toISOString()
            }
        };

        // --- External health (reuses same target intent as /api/health/external) ---
        const fetchFn = require('node-fetch');
        const targets = [
            { name: 'dataapi', url: `${DATAAPI_BASE_URL}/health` },
            { name: 'ollama', url: OLLAMA_HOST + '/api/tags' },
            {
                name: 'n8n',
                url: process.env.N8N_WEBHOOK_BASE_URL
                    ? process.env.N8N_WEBHOOK_BASE_URL.split('/webhook')[0] + '/healthz'
                    : 'https://n8n.specialblend.icu/healthz'
            }
        ];

        const external = {};
        await Promise.all(
            targets.map(async (t) => {
                try {
                    const resp = await fetchFn(t.url, { timeout: 3000 });
                    external[t.name] = { status: resp.ok ? 'ok' : 'error' };
                } catch (_err) {
                    external[t.name] = { status: 'error' };
                }
            })
        );

        // --- Events (DataAPI appevents) ---
        let events = [];
        try {
            const response = await fetch(`${DATAAPI_BASE_URL}/api/v1/collection/appevents/items?limit=${eventsLimit}`, {
                headers: { 'x-api-key': DATAAPI_API_KEY }
            });
            const data = await response.json();
            events = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
        } catch (err) {
            logger.warn('Dashboard summary events fetch failed', { error: err.message });
        }

        // --- Scans (DataAPI) ---
        let scans = null;
        try {
            const url = `${DATAAPI_BASE_URL}/api/v1/storage/scans?limit=${scansLimit}`;
            const response = await fetch(url, {
                headers: { 'x-api-key': DATAAPI_API_KEY }
            });
            scans = await response.json();
        } catch (err) {
            logger.warn('Dashboard summary scans fetch failed', { error: err.message });
        }

        // --- Mongo status ---
        const mongodb = {
            status: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
            host: mongoose.connection.host
        };

        return res.json({
            status: 'success',
            data: {
                metrics,
                health: {
                    agentx: { status: 'ok' },
                    mongodb,
                    external
                },
                events,
                scans,
                timestamp: new Date().toISOString()
            }
        });
    } catch (err) {
        logger.error('Dashboard summary error', { error: err.message });
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * GET /api/dashboard/stats
 * Get basic statistics for AgentX database collections
 */
router.get('/stats', async (req, res) => {
    try {
        // Verify database connection before accessing
        if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
            return res.status(503).json({
                status: 'error',
                message: 'Database not connected'
            });
        }

        const db = mongoose.connection.db;
        const collections = await db.listCollections().toArray();
        const stats = await Promise.all(collections.map(async (col) => {
            // Skip system collections or internal ones if needed
            if (col.name.startsWith('system.')) return null;
            const count = await db.collection(col.name).countDocuments();
            return {
                collection: col.name,
                db: mongoose.connection.name,
                count
            };
        }));

        res.json({
            status: 'success',
            data: stats.filter(Boolean)
        });
    } catch (err) {
        logger.error('Dashboard stats error', { error: err.message });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * Proxy Routes for DataAPI Scans
 * These allow the dashboard to interact with DataAPI without exposing the API key
 */

// GET /api/dashboard/scans - List recent scans
router.get('/scans', async (req, res) => {
    try {
        const limit = req.query.limit || 5;
        const url = `${DATAAPI_BASE_URL}/api/v1/storage/scans?limit=${limit}`;
        
        const response = await fetch(url, {
            headers: { 'x-api-key': DATAAPI_API_KEY }
        });
        
        if (!response.ok) {
            throw new Error(`DataAPI responded with ${response.status}`);
        }
        
        const data = await response.json();
        res.json(data);
    } catch (err) {
        logger.error('Proxy scans error', { error: err.message });
        res.status(502).json({ status: 'error', message: 'Failed to fetch scans from DataAPI' });
    }
});

// POST /api/dashboard/scans/:id/stop - Stop a running scan
router.post('/scans/:id/stop', async (req, res) => {
    try {
        const { id } = req.params;
        const url = `${DATAAPI_BASE_URL}/api/v1/storage/stop/${id}`;
        
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'x-api-key': DATAAPI_API_KEY }
        });
        
        const data = await response.json();
        res.status(response.status).json(data);
    } catch (err) {
        logger.error('Proxy stop scan error', { error: err.message });
        res.status(502).json({ status: 'error', message: 'Failed to stop scan' });
    }
});

// GET /api/dashboard/scans/:id/report - Get scan report
router.get('/scans/:id/report', async (req, res) => {
    try {
        const { id } = req.params;
        const url = `${DATAAPI_BASE_URL}/api/v1/storage/status/${id}`;
        
        const response = await fetch(url, {
            headers: { 'x-api-key': DATAAPI_API_KEY }
        });
        
        const data = await response.json();
        res.status(response.status).json(data);
    } catch (err) {
        logger.error('Proxy scan report error', { error: err.message });
        res.status(502).json({ status: 'error', message: 'Failed to fetch scan report' });
    }
});

module.exports = router;
