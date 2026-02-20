/**
 * Model Warmup
 * Pre-execution model warmup and VRAM readiness verification
 */

const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));
const logger = require('../../../config/logger');

function normalizeWarmupError(err, timeoutMs) {
    const rawMessage = String(err?.message || '').trim();
    const aborted = err?.name === 'AbortError' ||
        err?.type === 'aborted' ||
        /aborted|aborterror/i.test(rawMessage);
    if (aborted) {
        const timeoutSec = Math.max(1, Math.round((Number(timeoutMs) || 0) / 1000));
        return `Warmup timed out after ${timeoutSec}s (model may still be loading)`;
    }
    return rawMessage || 'Warmup failed';
}

/**
 * Warm up a model by sending a minimal request
 * When response comes back, model is loaded in VRAM and ready for fast tests
 *
 * @param {string} hostUrl - Ollama host URL
 * @param {string} model - Model name to warm up
 * @param {Object} options - Optional settings
 * @param {string} options.timelinePrefix - Timeline event prefix for batch tracking
 * @param {Function} options.recordTimelineEvent - Async callback for timeline events
 * @param {boolean} options.strict - When true, throw on failure instead of swallowing
 * @returns {Object} Warmup data for validation/debugging
 */
async function warmupModel(hostUrl, model, options = {}) {
    const { timelinePrefix = null, recordTimelineEvent = null, strict = false, _fetch = fetch } = options;
    const warmupStart = Date.now();
    const warmupPrompt = 'Hi';
    let timeoutMs = 180000;
    const warmupData = {
        prompt: warmupPrompt,
        response: null,
        latency_ms: null,
        already_loaded: null,
        success: false,
        error: null
    };

    if (timelinePrefix && recordTimelineEvent) {
        await recordTimelineEvent(`${timelinePrefix}_start`, { model, success: null });
    }

    try {
        // Check if model is already loaded in VRAM via /api/ps
        let modelAlreadyLoaded = false;
        try {
            const psController = new AbortController();
            const psTimeoutId = setTimeout(() => psController.abort(), 5000);
            const psResponse = await _fetch(`${hostUrl}/api/ps`, {
                method: 'GET',
                signal: psController.signal
            });
            clearTimeout(psTimeoutId);

            if (psResponse.ok) {
                const psData = await psResponse.json();
                const loadedModels = (psData.models || []).map(m => m.name);
                const normalizeModelName = (name) => name.split(':')[0].toLowerCase();
                const requestedBase = normalizeModelName(model);
                modelAlreadyLoaded = loadedModels.some(loaded => {
                    const loadedBase = normalizeModelName(loaded);
                    return loaded === model ||
                           loadedBase === requestedBase ||
                           loaded.startsWith(model);
                });
                if (modelAlreadyLoaded) {
                    logger.debug('Model already loaded in VRAM', { host: hostUrl, model, loadedModels });
                }
            }
        } catch (psErr) {
            logger.debug('Could not check /api/ps', { host: hostUrl, error: psErr.message });
        }

        warmupData.already_loaded = modelAlreadyLoaded;

        timeoutMs = modelAlreadyLoaded ? 30000 : 180000;
        logger.info('Warming up model', { host: hostUrl, model, alreadyLoaded: modelAlreadyLoaded, timeoutMs });

        const url = `${hostUrl}/api/generate`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        let response;
        try {
            response = await _fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model,
                    prompt: warmupPrompt,
                    stream: false,
                    options: { num_predict: 1 }
                }),
                signal: controller.signal
            });
        } finally {
            clearTimeout(timeoutId);
        }

        const durationMs = Date.now() - warmupStart;
        warmupData.latency_ms = durationMs;

        if (response.ok) {
            const data = await response.json();
            warmupData.response = data.response || '';
            warmupData.success = true;
            logger.info('Model ready', { host: hostUrl, model, durationMs, wasLoaded: modelAlreadyLoaded });
            if (timelinePrefix && recordTimelineEvent) {
                await recordTimelineEvent(`${timelinePrefix}_complete`, {
                    model, duration_ms: durationMs, success: true
                });
            }
        } else {
            const errorText = await response.text().catch(() => '');
            warmupData.error = `Warmup failed: HTTP ${response.status} - ${errorText.substring(0, 100)}`;
            throw new Error(warmupData.error);
        }
    } catch (err) {
        const durationMs = Date.now() - warmupStart;
        warmupData.latency_ms = durationMs;
        warmupData.error = normalizeWarmupError(err, timeoutMs);
        logger.warn('Model warmup failed', { host: hostUrl, model, error: warmupData.error, durationMs });

        if (timelinePrefix && recordTimelineEvent) {
            await recordTimelineEvent(`${timelinePrefix}_complete`, {
                model, duration_ms: durationMs, success: false, error: warmupData.error
            });
        }
        // In strict mode, propagate the error (used for judge warmup)
        if (strict) {
            throw new Error(warmupData.error);
        }
        // Don't throw - let tests try anyway
    }

    return warmupData;
}

module.exports = { warmupModel };
