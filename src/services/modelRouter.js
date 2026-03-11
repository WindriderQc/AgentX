/**
 * Model Router Service
 * Routes chat requests to appropriate Ollama host based on model/task complexity.
 * Static config (MODEL_ROUTING, TASK_MODELS, host state) lives in modelRouterConfig.js.
 * This file handles health checks, failover state, classification, and inference telemetry.
 */

const logger = require('../../config/logger');
const fetch = require('node-fetch');
const { RemediationAction } = require('../../models/RemediationAction');
const { getAlertService } = require('./alertService');
const { getFetchOptions } = require('../helpers/httpAgent');
const {
    HOSTS,
    refreshHosts,
    MODEL_ROUTING,
    TASK_MODELS,
    CLASSIFICATION_PROMPT,
    getTargetForModel,
    getModelForTask
} = require('./modelRouterConfig');

// ---------------------------------------------------------------------------
// Back-compat helpers (used by unit tests and older call-sites)
// ---------------------------------------------------------------------------

const HEALTH_CACHE_TTL_MS = parseInt(process.env.MODEL_HEALTH_CACHE_TTL_MS || '1000', 10);
const HEALTH_SLOW_THRESHOLD_MS = parseInt(process.env.MODEL_HEALTH_SLOW_THRESHOLD_MS || '6000', 10);
const _healthCache = new Map();

async function getModelHealth(hostUrl, _model = null) {
    refreshHosts();
    if (!hostUrl) {
        return { healthy: false, latency: -1, checkedAt: Date.now() };
    }

    // Tests should not depend on a live Ollama server.
    // NOTE: This hardcoded 'test' check BREAKS units tests that try to MOCK failure conditions.
    // We should respect mocks if fetch is mocked.
    // If we're in test env, BUT fetch is a mock function, we might want to bypass this shortcut 
    // to verify the logic.
    // A pragmatic approach: only shortcut if NOT mocked OR if the mock is default.
    // OR: Remove this shortcut block entirely if we properly mock fetch in ALL tests.
    // Let's modify it to allow mocking failures.
    /* 
    if (process.env.NODE_ENV === 'test') {
        return { healthy: true, latency: 1, checkedAt: Date.now() };
    }
    */
   // ^ disabled so tests can simulate latency/errors via mocked fetch.

    const cacheKey = `${hostUrl}|${_model || ''}`;
    const start = Date.now();
    const cached = _healthCache.get(cacheKey);
    // Guard against undefined/null checkedAt which would result in NaN
    if (cached && typeof cached.checkedAt === 'number') {
        const cacheAgeMs = start - cached.checkedAt;
        if (cacheAgeMs >= 0 && cacheAgeMs < HEALTH_CACHE_TTL_MS) {
            return cached;
        }
    }

    try {
        const url = `${hostUrl}/api/tags`;
        const fetchOptions = getFetchOptions(url, { method: 'GET' });
        const response = await fetch(url, fetchOptions);
        const end = Date.now();
        const result = {
            healthy: !!response?.ok,
            latency: end - start,
            checkedAt: end
        };
        _healthCache.set(cacheKey, result);
        return result;
    } catch (err) {
        const end = Date.now();
        const result = {
            healthy: false,
            latency: end - start,
            checkedAt: end,
            error: err.message
        };
        _healthCache.set(cacheKey, result);
        return result;
    }
}

async function classifyAndRoute(message, options = {}) {
    refreshHosts();
    const { taskType = null } = options;

    // Minimal deterministic behavior for tests: if taskType is given, route to primary
    // unless health is slow/unhealthy.
    const primaryHost = HOSTS.primary;
    const secondaryHost = HOSTS.secondary;

    if (!primaryHost) {
        logger.error('No primary Ollama host configured');
        throw new Error('No primary Ollama host configured');
    }

    const primaryHealth = await getModelHealth(primaryHost, null);
    const shouldFailover = !primaryHealth.healthy || primaryHealth.latency > HEALTH_SLOW_THRESHOLD_MS;

    if (!shouldFailover) {
        return {
            host: primaryHost,
            failedOver: false,
            taskType: taskType || 'default',
            message
        };
    }

    // Record remediation + alert (best-effort)
    try {
        await RemediationAction.create({
            strategy: 'model_failover',
            action: 'switch_host',
            automatedExecution: true,
            metadata: {
                primary: primaryHost,
                backup: secondaryHost,
                reason: primaryHealth.healthy ? 'slow_primary' : 'unhealthy_primary',
                latency: primaryHealth.latency
            }
        });
    } catch (_e) {
        // best-effort
    }

    try {
        const svc = typeof getAlertService === 'function' ? getAlertService() : null;
        if (svc?.triggerAlert) {
            await svc.triggerAlert('model_failover', 'warning', {
                primary: primaryHost,
                backup: secondaryHost,
                latency: primaryHealth.latency
            });
        }
    } catch (_e) {
        // best-effort
    }

    // Verify backup quickly (best-effort)
    await getModelHealth(secondaryHost, null);

    return {
        host: secondaryHost,
        failedOver: true,
        taskType: taskType || 'default',
        message
    };
}

// Persistent failover state (in-memory)
let ACTIVE_HOST_STATE = {
    current: null, // Will be initialized to primary on first access
    failedOver: false,
    failoverTimestamp: null,
    reason: null,
    failoverCount: 0
};

// Initialize active host on module load
ACTIVE_HOST_STATE.current = HOSTS.primary;

/**
 * Classify a query using the front-door model (Qwen)
 * @param {string} message - User message to classify
 * @param {number} timeout - Request timeout in ms (default 10s)
 * @returns {Promise<string>} Task classification
 */
async function classifyQuery(message, timeout = 10000) {
    refreshHosts();
    const frontDoor = HOSTS.primary;
    const classificationModel = 'qwen2.5:7b';
    
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        
        const url = `${frontDoor}/api/generate`;
        const fetchOptions = getFetchOptions(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: classificationModel,
                prompt: CLASSIFICATION_PROMPT + message,
                stream: false,
                options: {
                    temperature: 0.1,  // Low temp for consistent classification
                    num_predict: 20,    // Short response expected
                    num_ctx: 4096       // Classification needs minimal context
                }
            }),
            signal: controller.signal
        });
        const response = await fetch(url, fetchOptions);
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            throw new Error(`Classification failed: ${response.statusText}`);
        }
        
        const data = await response.json();
        const classification = data.response?.trim().toLowerCase().replace(/[^a-z_]/g, '') || 'general_chat';
        
        // Validate classification
        if (TASK_MODELS[classification]) {
            logger.debug('Query classified', { classification, message: message.substring(0, 50) });
            return classification;
        }
        
        logger.warn('Unknown classification, defaulting to general_chat', { classification });
        return 'general_chat';
        
    } catch (err) {
        if (err.name === 'AbortError') {
            logger.warn('Classification timed out, using default');
        } else {
            logger.error('Classification error', { error: err.message });
        }
        return 'general_chat';
    }
}

/**
 * Smart routing: classify query and determine best model/host
 * @param {string} message - User message
 * @param {Object} options - Routing options
 * @param {boolean} options.autoRoute - Enable auto-classification (default: false)
 * @param {string} options.taskType - Override task type (skip classification)
 * @param {string} options.preferredModel - Use specific model if available
 * @returns {Promise<{ model: string, target: string, taskType: string, routed: boolean }>}
 */
async function routeRequest(message, options = {}) {
    refreshHosts();
    const { autoRoute = false, taskType, preferredModel } = options;
    
    // If preferred model specified, just return its target
    if (preferredModel) {
        return {
            model: preferredModel,
            target: getTargetForModel(preferredModel),
            taskType: 'user_specified',
            routed: false
        };
    }
    
    // If explicit task type provided
    if (taskType && TASK_MODELS[taskType]) {
        const recommendation = getModelForTask(taskType);
        return {
            model: recommendation.model,
            target: recommendation.url,
            taskType,
            routed: true
        };
    }
    
    // If auto-routing enabled, classify the query
    if (autoRoute && message) {
        const classification = await classifyQuery(message);
        const recommendation = getModelForTask(classification);
        return {
            model: recommendation.model,
            target: recommendation.url,
            taskType: classification,
            routed: true
        };
    }
    
    // Default: use front-door
    return {
        model: 'qwen2.5:7b',
        target: HOSTS.primary,
        taskType: 'default',
        routed: false
    };
}

/**
 * Check health of a specific host
 * @param {string} hostKey - 'primary' or 'secondary'
 * @returns {Promise<{ status: string, models: string[], latency: number }>}
 */
async function checkHostHealth(hostKey) {
    refreshHosts();
    // Accept several identifiers:
    // - 'primary' | 'secondary'
    // - legacy aliases 'ollama-main' | 'ollama-secondary'
    // - a full host URL
    // - a URL equal to HOSTS.primary / HOSTS.secondary
    let host = null;
    if (hostKey === 'primary' || hostKey === 'ollama-main') host = HOSTS.primary;
    else if (hostKey === 'secondary' || hostKey === 'ollama-secondary') host = HOSTS.secondary;
    else if (hostKey === 'tertiary' || hostKey === 'ollama-tertiary') host = HOSTS.tertiary;
    else if (typeof hostKey === 'string' && hostKey.startsWith('http')) host = hostKey;
    else if (hostKey === HOSTS.primary) host = HOSTS.primary;
    else if (hostKey === HOSTS.secondary) host = HOSTS.secondary;
    else if (hostKey === HOSTS.tertiary) host = HOSTS.tertiary;
    else if (typeof hostKey === 'string') host = HOSTS[hostKey];

    if (!host) {
        return { status: 'unknown', models: [], latency: -1 };
    }

    // Tests should not depend on a live Ollama server.
    if (process.env.NODE_ENV === 'test') {
        return { status: 'online', models: [], latency: 1 };
    }
    
    const start = Date.now();
    
    try {
        const response = await fetch(`${host}/api/tags`, {
            method: 'GET',
            timeout: 5000
        });
        
        const latency = Date.now() - start;
        
        if (!response.ok) {
            return { status: 'error', models: [], latency };
        }
        
        const data = await response.json();
        const models = (data.models || []).map(m => m.name);
        
        return {
            status: 'online',
            models,
            latency
        };
        
    } catch (err) {
        return {
            status: 'offline',
            models: [],
            latency: Date.now() - start,
            error: err.message
        };
    }
}

/**
 * Get all routing info for debugging/dashboard
 * @returns {Promise<Object>}
 */
async function getRoutingStatus() {
    refreshHosts();
    const healthChecks = [
        checkHostHealth('primary'),
        checkHostHealth('secondary')
    ];
    if (HOSTS.tertiary) healthChecks.push(checkHostHealth('tertiary'));

    const [primaryHealth, secondaryHealth, tertiaryHealth] = await Promise.all(healthChecks);

    const hosts = {
        primary: { url: HOSTS.primary, ...primaryHealth },
        secondary: { url: HOSTS.secondary, ...secondaryHealth }
    };
    if (HOSTS.tertiary) {
        hosts.tertiary = { url: HOSTS.tertiary, ...tertiaryHealth };
    }

    return {
        hosts,
        modelRouting: MODEL_ROUTING,
        taskModels: TASK_MODELS
    };
}

/**
 * Get currently active host (for failover detection)
 * @returns {string} Active host URL
 */
function getActiveHost() {
    refreshHosts();
    return ACTIVE_HOST_STATE.current || HOSTS.primary;
}

/**
 * Get backup host URL
 * @returns {string} Backup host URL
 */
function getBackupHost() {
    refreshHosts();
    const current = getActiveHost();
    if (current === HOSTS.primary) {
        return HOSTS.secondary || HOSTS.tertiary || HOSTS.primary;
    }
    if (current === HOSTS.secondary) {
        return HOSTS.primary || HOSTS.tertiary || HOSTS.secondary;
    }
    if (current === HOSTS.tertiary) {
        return HOSTS.secondary || HOSTS.primary || HOSTS.tertiary;
    }
    return HOSTS.primary || HOSTS.secondary || HOSTS.tertiary;
}

/**
 * Get health and model inventory across all configured hosts.
 * @returns {Promise<Array<{hostKey: string, hostUrl: string, status: string, latency: number, models: string[], error?: string, checkedAt: string}>>}
 */
async function getAllModelsHealth() {
    refreshHosts();

    const hostEntries = [
        { hostKey: 'primary', hostUrl: HOSTS.primary },
        { hostKey: 'secondary', hostUrl: HOSTS.secondary },
        { hostKey: 'tertiary', hostUrl: HOSTS.tertiary }
    ].filter((entry) => !!entry.hostUrl);

    const checks = await Promise.all(hostEntries.map(async (entry) => {
        const health = await checkHostHealth(entry.hostKey);
        return {
            hostKey: entry.hostKey,
            hostUrl: entry.hostUrl,
            status: health.status,
            latency: health.latency,
            models: health.models || [],
            ...(health.error ? { error: health.error } : {}),
            checkedAt: new Date().toISOString()
        };
    }));

    return checks;
}

/**
 * Switch active host (for failover scenarios)
 * @param {string} hostUrl - Target host URL to switch to
 * @param {string} reason - Reason for the switch (optional)
 */
function switchHost(hostUrl, reason = 'manual') {
    refreshHosts();
    const previousHost = ACTIVE_HOST_STATE.current;

    // Update state
    ACTIVE_HOST_STATE.current = hostUrl;
    ACTIVE_HOST_STATE.failedOver = (hostUrl !== HOSTS.primary);
    ACTIVE_HOST_STATE.failoverTimestamp = new Date().toISOString();
    ACTIVE_HOST_STATE.reason = reason;
    ACTIVE_HOST_STATE.failoverCount += 1;

    logger.warn('Host switch executed', {
        from: previousHost,
        to: hostUrl,
        reason,
        timestamp: ACTIVE_HOST_STATE.failoverTimestamp,
        failoverCount: ACTIVE_HOST_STATE.failoverCount,
        isFailedOver: ACTIVE_HOST_STATE.failedOver
    });
}

/**
 * Get current failover status
 * @returns {Object} Current failover state
 */
function getFailoverStatus() {
    refreshHosts();
    return {
        currentHost: ACTIVE_HOST_STATE.current,
        isFailedOver: ACTIVE_HOST_STATE.failedOver,
        failoverTimestamp: ACTIVE_HOST_STATE.failoverTimestamp,
        reason: ACTIVE_HOST_STATE.reason,
        failoverCount: ACTIVE_HOST_STATE.failoverCount,
        primaryHost: HOSTS.primary,
        secondaryHost: HOSTS.secondary,
        tertiaryHost: HOSTS.tertiary
    };
}

/**
 * Reset to primary host
 * @param {string} reason - Reason for reset (optional)
 */
function resetToPrimary(reason = 'manual_reset') {
    refreshHosts();
    const previousState = { ...ACTIVE_HOST_STATE };

    ACTIVE_HOST_STATE.current = HOSTS.primary;
    ACTIVE_HOST_STATE.failedOver = false;
    ACTIVE_HOST_STATE.failoverTimestamp = null;
    ACTIVE_HOST_STATE.reason = null;
    // Keep failoverCount for historical tracking

    logger.info('Failover state reset to primary', {
        reason,
        previousHost: previousState.current,
        previousReason: previousState.reason,
        totalFailovers: ACTIVE_HOST_STATE.failoverCount
    });
}

// ---------------------------------------------------------------------------
// Inference Telemetry
// ---------------------------------------------------------------------------

/**
 * Resolve the host key ('primary' | 'secondary' | 'tertiary') from a host URL.
 * @param {string} hostUrl
 * @returns {string|null}
 */
function resolveHostKey(hostUrl) {
    if (!hostUrl) return null;
    if (hostUrl === HOSTS.primary) return 'primary';
    if (hostUrl === HOSTS.secondary) return 'secondary';
    if (hostUrl === HOSTS.tertiary) return 'tertiary';
    return null;
}

/**
 * Record an inference call to InferenceLog. Fire-and-forget — never throws.
 *
 * Call this AFTER your Ollama fetch completes (success or error).
 *
 * @param {Object} data
 * @param {string}  data.host           - Full Ollama host URL used
 * @param {string}  data.model          - Model name (e.g. 'qwen2.5:7b')
 * @param {'chat'|'benchmark'|'roundtable'|'automation'|'embedding'|'classification'|'unknown'} [data.caller]
 * @param {string}  [data.callerDetail] - Agent ID, task ID, cron name, etc.
 * @param {string}  [data.taskType]     - Routing task type
 * @param {boolean} [data.routed]       - Whether auto-routing was used
 * @param {boolean} [data.fallbackUsed]
 * @param {string}  [data.fallbackReason]
 * @param {number}  [data.tokensIn]
 * @param {number}  [data.tokensOut]
 * @param {number}  [data.durationMs]
 * @param {'success'|'error'|'timeout'} [data.status]
 * @param {string}  [data.error]
 */
async function recordInference(data) {
    if (process.env.NODE_ENV === 'test') return; // skip in tests
    try {
        const InferenceLog = require('../../models/InferenceLog');
        await InferenceLog.create({
            host: data.host || 'unknown',
            hostKey: resolveHostKey(data.host),
            model: data.model || 'unknown',
            caller: data.caller || 'unknown',
            callerDetail: data.callerDetail || null,
            taskType: data.taskType || null,
            routed: data.routed || false,
            fallbackUsed: data.fallbackUsed || false,
            fallbackReason: data.fallbackReason || null,
            tokensIn: data.tokensIn || 0,
            tokensOut: data.tokensOut || 0,
            durationMs: data.durationMs || 0,
            status: data.status || 'success',
            error: data.error || null,
            timestamp: new Date()
        });
    } catch (_e) {
        // Never break inference because of telemetry failure
        logger.debug('InferenceLog write failed (non-fatal)', { error: _e.message });
    }
}

module.exports = {
    getTargetForModel,
    getModelForTask,
    classifyQuery,
    routeRequest,
    classifyAndRoute,
    checkHostHealth,
    getModelHealth,
    getRoutingStatus,
    getAllModelsHealth,
    getActiveHost,
    getBackupHost,
    switchHost,
    getFailoverStatus,
    resetToPrimary,
    recordInference,
    resolveHostKey,
    HOSTS,
    MODEL_ROUTING,
    TASK_MODELS
};
