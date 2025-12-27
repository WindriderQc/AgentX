const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));
const logger = require('../config/logger');

// Environment variables
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_HOST_2 = process.env.OLLAMA_HOST_2 || 'http://192.168.2.12:11434';
const DATAAPI_BASE_URL = process.env.DATAAPI_BASE_URL || 'http://localhost:3003';
const DATAAPI_API_KEY = process.env.DATAAPI_API_KEY;

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
            const tagsResponse = await checkUrl(`${OLLAMA_HOST}/api/tags`);
            status.ollama_primary.status = tagsResponse.status;
            if (tagsResponse.status === 'online') {
                const modelsRes = await fetch(`${OLLAMA_HOST}/api/tags`);
                if (modelsRes.ok) {
                    const data = await modelsRes.json();
                    status.ollama_primary.models = (data.models || []).map(m => m.name);
                }
            }
        })(),
        (async () => {
            const tagsResponse = await checkUrl(`${OLLAMA_HOST_2}/api/tags`);
            status.ollama_secondary.status = tagsResponse.status;
            if (tagsResponse.status === 'online') {
                const modelsRes = await fetch(`${OLLAMA_HOST_2}/api/tags`);
                if (modelsRes.ok) {
                    const data = await modelsRes.json();
                    status.ollama_secondary.models = (data.models || []).map(m => m.name);
                }
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
 * GET /api/dashboard/stats
 * Get basic statistics for AgentX database collections
 */
router.get('/stats', async (req, res) => {
    try {
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

module.exports = router;
