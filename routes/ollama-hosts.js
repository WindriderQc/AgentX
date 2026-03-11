/**
 * Ollama Hosts Routes
 * Returns configured Ollama hosts with their available models
 */

const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const logger = require('../config/logger');
const { getConfiguredHosts } = require('../src/helpers/ollamaHostConfig');

// Fetch models from a specific Ollama host
async function fetchModels(hostUrl) {
    try {
        const response = await fetch(`${hostUrl}/api/tags`, {
            method: 'GET',
            timeout: 3000
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        
        // Filter out embedding models
        const models = (data.models || [])
            .filter(m => {
                const name = m.name.toLowerCase();
                const family = m.details?.family?.toLowerCase() || '';
                
                // Exclude known embedding keywords
                if (name.includes('embed') || name.includes('nomic') || name.includes('bert')) {
                    return false;
                }
                
                // Exclude embedding families
                if (family === 'bert' || family === 'nomic-bert') {
                    return false;
                }

                // Exclude diagnostic models
                if (name.includes('diagnostic')) {
                    return false;
                }
                
                return true;
            })
            .map(m => m.name);

        return {
            success: true,
            models
        };
    } catch (err) {
        return {
            success: false,
            error: err.message,
            models: []
        };
    }
}

/**
 * GET /api/ollama-hosts
 * Get all configured Ollama hosts with their models
 */
router.get('/', async (req, res) => {
    try {
        const configuredHosts = getConfiguredHosts();

        // Fetch models from each host in parallel
        const hostsWithModels = await Promise.all(
            configuredHosts.map(async (host) => {
                const result = await fetchModels(host.url);
                return {
                    ...host,
                    available: result.success,
                    models: result.models,
                    error: result.error
                };
            })
        );

        res.json({
            status: 'success',
            data: {
                hosts: hostsWithModels,
                total: hostsWithModels.length,
                available: hostsWithModels.filter(h => h.available).length
            }
        });
    } catch (err) {
        logger.error('Failed to fetch Ollama hosts', { error: err.message });
        res.status(500).json({
            status: 'error',
            error: err.message
        });
    }
});

/**
 * GET /api/ollama-hosts/:hostId/models
 * Get models for a specific host
 */
router.get('/:hostId/models', async (req, res) => {
    try {
        const { hostId } = req.params;
        const configuredHosts = getConfiguredHosts();
        const host = configuredHosts.find(h => h.id === hostId);

        if (!host) {
            return res.status(404).json({
                status: 'error',
                error: 'Host not found'
            });
        }

        const result = await fetchModels(host.url);

        res.json({
            status: 'success',
            data: {
                host: host,
                available: result.success,
                models: result.models,
                error: result.error
            }
        });
    } catch (err) {
        logger.error('Failed to fetch models', { error: err.message });
        res.status(500).json({
            status: 'error',
            error: err.message
        });
    }
});

/**
 * GET /api/ollama-hosts/proxy/tags
 * Proxy endpoint for fetching models from configured Ollama host
 * This avoids CORS issues when frontend needs to access Ollama API
 */
router.get('/proxy/tags', async (req, res) => {
    try {
        // Use custom host from query param or default to primary configured host
        const customHost = req.query.host;
        let ollamaHost;

        if (customHost) {
            ollamaHost = customHost;
        } else {
            const configuredHosts = getConfiguredHosts();
            ollamaHost = configuredHosts[0]?.url;
            
            if (!ollamaHost) {
                throw new Error('No Ollama hosts configured');
            }
        }

        const response = await fetch(`${ollamaHost}/api/tags`, {
            method: 'GET',
            timeout: 5000
        });

        if (!response.ok) {
            throw new Error(`Ollama returned HTTP ${response.status}`);
        }

        const data = await response.json();
        
        // Return in Ollama's native format for compatibility
        res.json(data);
    } catch (err) {
        logger.error('Failed to proxy Ollama tags', { error: err.message });
        res.status(500).json({
            status: 'error',
            error: err.message,
            models: []
        });
    }
});

module.exports = router;
