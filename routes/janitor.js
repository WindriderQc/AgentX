const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const router = express.Router();

const DATAAPI_URL = process.env.DATAAPI_BASE_URL || 'http://localhost:3003';
const DATAAPI_KEY = process.env.DATAAPI_API_KEY;

if (!DATAAPI_KEY) {
    console.warn('WARNING: DATAAPI_API_KEY is not set. Janitor proxy may fail.');
} else {
    console.log('Janitor Proxy loaded with API Key:', DATAAPI_KEY.substring(0, 5) + '...');
}

// Proxy options
const proxyOptions = {
    target: DATAAPI_URL,
    changeOrigin: true,
    pathRewrite: {
        '^/': '/api/v1/janitor/' // Rewrite /analyze -> /api/v1/janitor/analyze
    },
    headers: {
        'x-api-key': DATAAPI_KEY
    }
};

// Mount proxy for all janitor routes
router.use('/', createProxyMiddleware(proxyOptions));

module.exports = router;
