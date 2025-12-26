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
        dataapi: {
            status: 'unknown'
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

    // Check DataAPI aggregated health endpoint
    try {
        const healthUrl = `${DATAAPI_BASE_URL}/api/v1/system/health`;
        const headers = DATAAPI_API_KEY ? { 'x-api-key': DATAAPI_API_KEY } : {};
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        
        const response = await fetch(healthUrl, { 
            signal: controller.signal,
            headers 
        });
        clearTimeout(timeoutId);
        
        if (response.ok) {
            const data = await response.json();
            status.dataapi = {
                status: 'online',
                version: data.data?.dataapi?.version,
                mongodb: data.data?.mongodb?.status,
                overall: data.data?.overall
            };
        } else {
            status.dataapi.status = 'error';
            status.dataapi.code = response.status;
        }
    } catch (err) {
        status.dataapi.status = 'offline';
        status.dataapi.error = err.message;
    }

    // Calculate overall health
    const allOnline = 
        status.mongodb.status === 'connected' &&
        (status.ollama_primary.status === 'online' || status.ollama_secondary.status === 'online') &&
        status.dataapi.status === 'online';

    status.overall = allOnline ? 'healthy' : 'degraded';

    res.json({
        status: 'success',
        data: status
    });
});

module.exports = router;
