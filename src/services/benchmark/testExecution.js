/**
 * Test Execution
 * Single benchmark test runner against a model endpoint
 */

const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));
const logger = require('../../../config/logger');
const { getFetchOptions } = require('../../helpers/httpAgent');
const BenchmarkPrompt = require('../../../models/BenchmarkPrompt');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const { classifyBenchmarkError } = require('./errorClassifier');
const { DEFAULT_EXECUTION_CONFIG } = require('./config');
const ModelRegistry = require('../../../models/ModelRegistry');

/**
 * Get effective num_ctx for a model from registry, falling back to system default
 */
async function getEffectiveNumCtx(modelName) {
    try {
        const entry = await ModelRegistry.findOne({ modelName }).lean();
        if (entry) {
            const overrides = entry.executionOverrides || {};
            const defaults = entry.executionDefaults || {};
            return overrides.num_ctx ?? defaults.num_ctx ?? DEFAULT_EXECUTION_CONFIG.num_ctx;
        }
    } catch (_) { /* registry unavailable — use default */ }
    return DEFAULT_EXECUTION_CONFIG.num_ctx;
}

/**
 * Run a single benchmark test
 */
async function runTest({ model, host, prompt }) {
    if (!model || !host || !prompt) {
        throw new Error('model, host, and prompt are required');
    }

    const start = Date.now();
    const numCtx = await getEffectiveNumCtx(model);

    try {
        const url = `${host}/api/generate`;
        const fetchOptions = getFetchOptions(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                prompt,
                stream: false,
                options: {
                    num_ctx: numCtx
                }
            }),
            timeout: 120000
        });
        const response = await fetch(url, fetchOptions);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        const latency = Date.now() - start;
        const tokens = data.eval_count || Math.ceil((data.response || '').length / 4);

        let promptMeta = {};
        try {
            const promptDef = await BenchmarkPrompt.findOne({ prompt });
            if (promptDef) {
                promptMeta = {
                    prompt_level: promptDef.level,
                    prompt_category: promptDef.category,
                    prompt_name: promptDef.name
                };
            }
        } catch (err) {
            // Ignore lookup errors
        }

        const tokensPerSec = (tokens > 0 && latency > 0)
            ? Number((tokens / (latency / 1000)).toFixed(2))
            : 0;

        const result = new BenchmarkResult({
            model,
            host,
            prompt,
            ...promptMeta,
            latency,
            tokens,
            tokens_per_sec: tokensPerSec,
            response: data.response || '',
            success: true,
            timestamp: new Date()
        });

        await result.save();

        logger.info('Benchmark test completed', {
            model, host, latency, tokens_per_sec: result.tokens_per_sec
        });

        return result;

    } catch (err) {
        const classified = classifyBenchmarkError(err);
        const result = new BenchmarkResult({
            model,
            host,
            prompt,
            error: err.message,
            infra_error: classified.infra,
            error_type: classified.type,
            error_http_status: classified.httpStatus,
            success: false,
            timestamp: new Date()
        });

        await result.save();
        logger.error('Benchmark test failed', { model, host, error: err.message });

        throw err;
    }
}

module.exports = { runTest };
