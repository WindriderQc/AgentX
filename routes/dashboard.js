const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));
const logger = require('../config/logger');

// Environment variables
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const DATAAPI_BASE_URL = process.env.DATAAPI_BASE_URL || 'http://localhost:3003';
const DATAAPI_API_KEY = process.env.DATAAPI_API_KEY;

// Helper to check URL
async function checkUrl(url, timeout = 2000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        return { status: response.ok ? 'online' : 'error', code: response.status };
    } catch (err) {
        clearTimeout(timeoutId);
        return { status: 'offline', error: err.message };
    }
}

/**
 * GET /api/dashboard/health
 * Aggregated health check for dashboard
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
        ollama: {
            status: 'unknown',
            models: []
        },
        dataapi: {
            status: 'unknown'
        },
        timestamp: new Date().toISOString()
    };

    // Check Ollama
    try {
        const tagsResponse = await checkUrl(`${OLLAMA_HOST}/api/tags`);
        status.ollama.status = tagsResponse.status;

        if (tagsResponse.status === 'online') {
            const modelsRes = await fetch(`${OLLAMA_HOST}/api/tags`);
            if (modelsRes.ok) {
                const data = await modelsRes.json();
                status.ollama.models = data.models || [];
            }
        }
    } catch (err) {
        status.ollama.error = err.message;
    }

    // Check DataAPI
    try {
        const dataApiHealth = await checkUrl(`${DATAAPI_BASE_URL}/health`);
        status.dataapi.status = dataApiHealth.status;
        status.dataapi.details = dataApiHealth;
    } catch (err) {
        status.dataapi.error = err.message;
    }

    res.json({
        status: 'success',
        data: status
    });
});

module.exports = router;
