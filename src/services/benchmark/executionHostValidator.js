/**
 * Execution Host Validator
 * Pre-batch validation that the execution host is a reachable Ollama endpoint
 * and all requested models are available.
 */

const logger = require('../../../config/logger');

/**
 * Validate that a host is a reachable Ollama endpoint with the requested models.
 * @param {string} host - Ollama host URL
 * @param {string[]} models - Model names to check
 * @returns {Promise<{valid: boolean, error?: string, available_models?: string[]}>}
 */
async function validateExecutionHost(host, models) {
    const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    let tagsRes;
    try {
        tagsRes = await fetch(`${host}/api/tags`, { method: 'GET', signal: controller.signal });
        clearTimeout(timeoutId);
    } catch (err) {
        clearTimeout(timeoutId);
        const msg = err.name === 'AbortError' ? 'timeout' : err.message;
        return { valid: false, error: `Cannot reach execution host ${host}: ${msg}` };
    }

    if (!tagsRes.ok) {
        return { valid: false, error: `Execution host is not a valid Ollama endpoint: HTTP ${tagsRes.status}` };
    }

    let tagsData;
    try {
        tagsData = await tagsRes.json();
    } catch {
        return { valid: false, error: 'Execution host returned invalid JSON' };
    }

    const available = (tagsData.models || []).map(m => m.name.replace(/:latest$/, ''));
    const normalizedModels = models.map(m => m.replace(/:latest$/, ''));
    const availableSet = new Set(available);
    const missing = normalizedModels.filter(m => !availableSet.has(m));

    if (missing.length > 0) {
        return {
            valid: false,
            error: `Models not found on execution host: ${missing.join(', ')}`,
            available_models: available
        };
    }

    return { valid: true, available_models: available };
}

module.exports = { validateExecutionHost };
