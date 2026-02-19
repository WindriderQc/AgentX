/**
 * Judge Model Validator
 * Pre-batch validation: checks judge model availability and structured output capability
 */

const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));
const logger = require('../../../config/logger');

const VALIDATION_TIMEOUT_MS = 30000;

/**
 * Validate that a judge model is available and can produce structured JSON output.
 *
 * Step 1 (hard): model must exist on the host — fail if not found.
 * Step 2 (soft): test generation for JSON output — timeout is treated as valid
 *   (cold-loading a large model can exceed the timeout; the benchmark warmup
 *   phase handles that separately).
 *
 * @param {string} host - Ollama host URL (e.g. http://localhost:11434)
 * @param {string} model - Model name to validate
 * @param {Object} [options] - Options
 * @param {Function} [options._fetch] - Override fetch for testing
 * @returns {Promise<{valid: boolean, error?: string, warning?: string, available_models?: string[], latency_ms?: number}>}
 */
async function validateJudgeModel(host, model, options = {}) {
    const _fetch = options._fetch || fetch;
    const start = Date.now();

    if (!host || !model) {
        return { valid: false, error: 'host and model are required' };
    }

    // Step 1: Check model exists in host's model list
    let availableModels = [];
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        const res = await _fetch(`${host}/api/tags`, {
            method: 'GET',
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
            return {
                valid: false,
                error: `Failed to list models: HTTP ${res.status}`,
                latency_ms: Date.now() - start
            };
        }

        const data = await res.json();
        availableModels = (data.models || []).map(m => m.name);

        const found = availableModels.some(name => name === model);

        if (!found) {
            return {
                valid: false,
                error: `Judge model "${model}" not found on host`,
                available_models: availableModels,
                latency_ms: Date.now() - start
            };
        }
    } catch (err) {
        const msg = err.name === 'AbortError' ? 'Host unreachable (timeout)' : err.message;
        return {
            valid: false,
            error: `Cannot connect to judge host: ${msg}`,
            latency_ms: Date.now() - start
        };
    }

    // Step 2: Verify model can produce structured JSON output (soft check)
    // Timeout here is NOT a failure — cold-loading a model can take longer than
    // the validation window. The benchmark warmup phase handles cold starts.
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);

        const testPrompt = 'Rate this response on a scale of 0-10. Respond ONLY with JSON: {"score": 5, "reason": "test"}';
        const res = await _fetch(`${host}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                prompt: testPrompt,
                stream: false,
                options: { num_predict: 100, temperature: 0.1 }
            }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
            return {
                valid: false,
                error: `Judge model failed test generation: HTTP ${res.status}`,
                available_models: availableModels,
                latency_ms: Date.now() - start
            };
        }

        const data = await res.json();
        const text = (data.response || '').trim();

        // Try to parse JSON from response
        const firstBrace = text.indexOf('{');
        const lastBrace = text.lastIndexOf('}');
        if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
            logger.warn('Judge model validation: no JSON in output', { model, text: text.substring(0, 200) });
            return {
                valid: false,
                error: 'Judge model cannot produce structured JSON output',
                available_models: availableModels,
                latency_ms: Date.now() - start
            };
        }

        const jsonStr = text.substring(firstBrace, lastBrace + 1);
        JSON.parse(jsonStr); // throws if invalid

        logger.info('Judge model validated', { host, model, latency_ms: Date.now() - start });
        return {
            valid: true,
            available_models: availableModels,
            latency_ms: Date.now() - start
        };
    } catch (err) {
        if (err.name === 'AbortError') {
            // Timeout = model is loading (cold start). Still valid — warmup handles this.
            logger.info('Judge model validation: generation timed out (cold start), model exists — treating as valid', {
                host, model, timeout_ms: VALIDATION_TIMEOUT_MS, latency_ms: Date.now() - start
            });
            return {
                valid: true,
                warning: 'Judge model is loading (cold start). Warmup phase will handle this.',
                available_models: availableModels,
                latency_ms: Date.now() - start
            };
        }
        return {
            valid: false,
            error: `Judge output validation failed: ${err.message}`,
            available_models: availableModels,
            latency_ms: Date.now() - start
        };
    }
}

module.exports = { validateJudgeModel };
