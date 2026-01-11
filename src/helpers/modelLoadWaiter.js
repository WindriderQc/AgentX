/**
 * Model Load Waiter Helper
 * 
 * Intelligently waits for a model to load into GPU VRAM by polling nvidia-smi
 * instead of using arbitrary timeout values.
 * 
 * This solves the problem where:
 * - Fixed timeouts are either too short (causing failures) or too long (wasting time)
 * - Different models take different times to load based on size
 * - We can detect when a model is actually loaded by monitoring VRAM usage
 */

const logger = require('../../config/logger');
const ollamaVramService = require('../services/ollamaVramService');

/**
 * Wait for a model to finish loading by monitoring VRAM usage
 * 
 * @param {string} hostUrl - Ollama host URL (e.g., 'http://192.168.2.111:11434')
 * @param {string} modelName - Name of the model being loaded
 * @param {Object} options - Configuration options
 * @param {number} options.maxWaitMs - Maximum time to wait (default: 120000 = 120s)
 * @param {number} options.pollIntervalMs - How often to check VRAM (default: 2000 = 2s)
 * @param {number} options.stabilityChecks - Number of stable readings needed (default: 2)
 * @param {number} options.expectedSizeMiB - Expected model size in MiB (optional)
 * @returns {Promise<{loaded: boolean, durationMs: number, vramUsedMiB: number, error: string|null}>}
 */
async function waitForModelLoad(hostUrl, modelName, options = {}) {
    const {
        maxWaitMs = 120000,
        pollIntervalMs = 2000,
        stabilityChecks = 2,
        expectedSizeMiB = null
    } = options;

    const startTime = Date.now();
    let previousVramUsed = null;
    let stableCount = 0;

    logger.debug('Waiting for model to load', { 
        hostUrl, 
        modelName, 
        maxWaitMs, 
        pollIntervalMs,
        expectedSizeMiB 
    });

    // Get initial VRAM reading
    try {
        const initialResult = await ollamaVramService.getHostVram(hostUrl);
        if (!initialResult.ok) {
            logger.warn('Cannot monitor VRAM for model loading', { 
                hostUrl, 
                modelName,
                error: initialResult.error 
            });
            // Fall back to simple wait if VRAM monitoring not available
            return {
                loaded: null, // Unknown, VRAM monitoring unavailable
                durationMs: 0,
                vramUsedMiB: null,
                error: `VRAM monitoring unavailable: ${initialResult.error}`
            };
        }
        previousVramUsed = initialResult.memoryUsedMiBTotal;
    } catch (err) {
        logger.warn('Error checking initial VRAM', { 
            hostUrl, 
            modelName, 
            error: err.message 
        });
        return {
            loaded: null,
            durationMs: 0,
            vramUsedMiB: null,
            error: `Cannot check VRAM: ${err.message}`
        };
    }

    // Poll VRAM usage until it stabilizes (indicating model is loaded)
    while (Date.now() - startTime < maxWaitMs) {
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

        try {
            const vramResult = await ollamaVramService.getHostVram(hostUrl);
            
            if (!vramResult.ok) {
                logger.warn('VRAM check failed during polling', { 
                    hostUrl, 
                    modelName, 
                    error: vramResult.error 
                });
                continue;
            }

            const currentVramUsed = vramResult.memoryUsedMiBTotal;
            const vramChange = currentVramUsed - previousVramUsed;

            logger.debug('VRAM check', {
                hostUrl,
                modelName,
                previousVramUsed,
                currentVramUsed,
                vramChange,
                stableCount,
                elapsedMs: Date.now() - startTime
            });

            // Check if VRAM usage has stabilized (model finished loading)
            // Allow for small fluctuations (< 100 MiB)
            if (Math.abs(vramChange) < 100) {
                stableCount++;
                
                // If we have stable readings, model is likely loaded
                if (stableCount >= stabilityChecks) {
                    const durationMs = Date.now() - startTime;
                    logger.info('Model load detected (VRAM stabilized)', {
                        hostUrl,
                        modelName,
                        durationMs,
                        vramUsedMiB: currentVramUsed,
                        stableChecks: stableCount
                    });
                    
                    return {
                        loaded: true,
                        durationMs,
                        vramUsedMiB: currentVramUsed,
                        error: null
                    };
                }
            } else {
                // VRAM still changing, model still loading
                stableCount = 0;
                
                // Log significant changes
                if (vramChange > 500) {
                    logger.debug('Model loading in progress', {
                        hostUrl,
                        modelName,
                        vramIncreaseMiB: vramChange,
                        currentVramMiB: currentVramUsed
                    });
                }
            }

            previousVramUsed = currentVramUsed;

        } catch (err) {
            logger.warn('Error polling VRAM', { 
                hostUrl, 
                modelName, 
                error: err.message 
            });
            // Continue polling despite errors
        }
    }

    // Timeout reached
    const durationMs = Date.now() - startTime;
    logger.warn('Model load wait timed out', {
        hostUrl,
        modelName,
        durationMs,
        maxWaitMs,
        lastVramUsedMiB: previousVramUsed
    });

    return {
        loaded: false,
        durationMs,
        vramUsedMiB: previousVramUsed,
        error: `Timeout after ${durationMs}ms (VRAM did not stabilize)`
    };
}

/**
 * Wrapper that attempts to use VRAM monitoring, falls back to simple wait
 * 
 * @param {string} hostUrl - Ollama host URL
 * @param {string} modelName - Model name
 * @param {Object} options - Options including fallbackTimeoutMs
 * @returns {Promise<void>} - Resolves when model is ready or timeout
 */
async function waitForModelLoadWithFallback(hostUrl, modelName, options = {}) {
    const { fallbackTimeoutMs = 120000, ...waitOptions } = options;
    
    const result = await waitForModelLoad(hostUrl, modelName, waitOptions);
    
    if (result.loaded === null) {
        // VRAM monitoring not available, use simple timeout
        logger.info('Using fallback timeout for model load', { 
            hostUrl, 
            modelName, 
            timeoutMs: fallbackTimeoutMs 
        });
        await new Promise(resolve => setTimeout(resolve, fallbackTimeoutMs));
    } else if (!result.loaded) {
        // Timed out waiting for VRAM to stabilize
        logger.warn('Model may not be fully loaded', {
            hostUrl,
            modelName,
            ...result
        });
    }
    
    return result;
}

module.exports = {
    waitForModelLoad,
    waitForModelLoadWithFallback
};
