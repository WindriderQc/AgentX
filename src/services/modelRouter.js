/**
 * Model Router Service
 * Routes chat requests to appropriate Ollama host based on model/task complexity
 * 
 * Primary: UGFrank (192.168.2.99) - Fast 7B models, front-door
 * Secondary: UGBrutal (192.168.2.12) - Heavy 70B+ models, specialists
 */

const logger = require('../../config/logger');
const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));

class ModelHealthTracker {
    constructor() {
        this.healthCache = new Map(); // modelKey -> { avgResponseTime, lastChecked, status }
        this.cacheTTL = 60000; // 1 minute
    }

    async checkModelHealth(host, model) {
        const key = `${host}:${model}`;
        const cached = this.healthCache.get(key);

        if (cached && Date.now() - cached.lastChecked < this.cacheTTL) {
            return cached;
        }

        try {
            const start = Date.now();
            const response = await fetch(`${host}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model,
                    prompt: 'Test',
                    stream: false
                }),
                signal: AbortSignal.timeout(5000) // 5 second timeout
            });

            const responseTime = Date.now() - start;

            const health = {
                status: response.ok ? 'healthy' : 'unhealthy',
                avgResponseTime: responseTime,
                lastChecked: Date.now()
            };

            this.healthCache.set(key, health);
            return health;

        } catch (err) {
            const health = {
                status: 'unhealthy',
                avgResponseTime: null,
                lastChecked: Date.now(),
                error: err.message
            };

            this.healthCache.set(key, health);
            return health;
        }
    }

    clearCache() {
        this.healthCache.clear();
    }
}

const healthTracker = new ModelHealthTracker();

// Host configuration
const HOSTS = {
    primary: process.env.OLLAMA_HOST || 'http://192.168.2.99:11434',
    secondary: process.env.OLLAMA_HOST_SECONDARY || process.env.OLLAMA_HOST_2 || 'http://192.168.2.12:11434'
};

// Model → Host mapping
const MODEL_ROUTING = {
    // UGFrank (99) - Fast models for quick responses
    'qwen2.5:7b-instruct-q4_0': 'primary',
    'qwen2.5:7b': 'primary',  // Alias
    'qwen2.5:3b': 'primary',
    'qwen3:4b': 'primary',
    'qwen3:8b': 'primary',
    'llama3.2:1b': 'primary',
    'llama2:latest': 'primary',
    'whisper': 'primary',
    
    // UGBrutal (12) - Heavy specialists
    'deepseek-r1:8b': 'secondary',
    'deepseek-r1:32b': 'secondary',
    'deepseek-r1:14b': 'secondary',
    'gemma3:12b-it-qat': 'secondary',
    'gemma3:12b': 'secondary',  // Alias
    'gemma3:4b-it-qat': 'secondary',
    'qwen2.5-coder:14b': 'secondary',
    'qwen2.5-coder:7b': 'secondary',
    'qwen3:14b': 'secondary',
    'llama3.1:8b': 'secondary',
    'olmo2:13b': 'secondary',
    
    // Embeddings 
    'nomic-embed-text': 'primary',
    'nomic-embed-text:latest': 'primary'
};

// Task type → Model recommendation (use ACTUAL installed models)
const TASK_MODELS = {
    quick_chat: { model: 'qwen2.5:7b-instruct-q4_0', host: 'primary' },
    general_chat: { model: 'qwen2.5:7b-instruct-q4_0', host: 'primary' },
    code_generation: { model: 'qwen2.5-coder:14b', host: 'secondary' },
    code_review: { model: 'qwen2.5-coder:14b', host: 'secondary' },
    deep_reasoning: { model: 'deepseek-r1:8b', host: 'secondary' },
    analysis: { model: 'gemma3:12b-it-qat', host: 'secondary' },
    summarization: { model: 'gemma3:12b-it-qat', host: 'secondary' },
    translation: { model: 'qwen2.5:7b-instruct-q4_0', host: 'primary' },
    embeddings: { model: 'nomic-embed-text:latest', host: 'primary' }
};

// Classification prompt for front-door routing
const CLASSIFICATION_PROMPT = `You are a query classifier. Classify the user's query into exactly one category.

Categories:
- quick_chat: Simple greetings, small talk, basic questions with short answers
- general_chat: General knowledge questions, explanations, advice
- code_generation: Write code, implement features, create functions/classes
- code_review: Review code, find bugs, suggest improvements
- deep_reasoning: Complex multi-step problems, math, logic puzzles
- analysis: Analyze data, documents, compare things, detailed breakdowns
- summarization: Summarize text, condense information
- translation: Translate between languages

Respond with ONLY the category name, nothing else.

User query: `;

/**
 * Get the target Ollama host for a specific model
 * @param {string} model - Model name (e.g., "qwen2.5:7b")
 * @returns {string} Full URL of the Ollama host
 */
function getTargetForModel(model) {
    if (!model) return HOSTS.primary;
    
    const normalizedModel = model.toLowerCase().trim();
    const hostKey = MODEL_ROUTING[normalizedModel];
    
    if (hostKey && HOSTS[hostKey]) {
        return HOSTS[hostKey];
    }
    
    // Smart fallback based on model name patterns
    if (normalizedModel.includes('70b') || 
        normalizedModel.includes('32b') || 
        normalizedModel.includes('27b') ||
        normalizedModel.includes('deepseek') ||
        normalizedModel.includes('embed')) {
        return HOSTS.secondary;
    }
    
    return HOSTS.primary;
}

/**
 * Get the recommended model and host for a task type
 * @param {string} taskType - Task classification
 * @returns {{ model: string, host: string, url: string }}
 */
function getModelForTask(taskType) {
    const task = TASK_MODELS[taskType] || TASK_MODELS.general_chat;
    return {
        model: task.model,
        host: task.host,
        url: HOSTS[task.host]
    };
}

function getPrimaryHostForTask(taskType) {
    const task = getModelForTask(taskType);
    return task.url;
}

function getBackupHost(primaryHost) {
    const hosts = {
        [process.env.OLLAMA_HOST]: process.env.OLLAMA_HOST_SECONDARY,
        [process.env.OLLAMA_HOST_SECONDARY]: process.env.OLLAMA_HOST
    };
    return hosts[primaryHost] || process.env.OLLAMA_HOST;
}

/**
 * Classify a query using the front-door model (Qwen)
 * @param {string} message - User message to classify
 * @param {number} timeout - Request timeout in ms (default 10s)
 * @returns {Promise<string>} Task classification
 */
async function classifyQuery(message, timeout = 10000) {
    const frontDoor = HOSTS.primary;
    const classificationModel = 'qwen2.5:7b';
    
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        
        const response = await fetch(`${frontDoor}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: classificationModel,
                prompt: CLASSIFICATION_PROMPT + message,
                stream: false,
                options: {
                    temperature: 0.1,  // Low temp for consistent classification
                    num_predict: 20    // Short response expected
                }
            }),
            signal: controller.signal
        });
        
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

async function classifyAndRoute(message, options = {}) {
    const { preferredModel, preferredHost, taskType } = options;

    const classification = taskType || (message ? await classifyQuery(message) : 'general_chat');

    let targetHost = preferredHost || getPrimaryHostForTask(classification);
    let targetModel = preferredModel || getModelForTask(classification).model;

    const primaryHealth = await healthTracker.checkModelHealth(targetHost, targetModel);

    const needsFailover = (
        primaryHealth.status === 'unhealthy' ||
        (primaryHealth.avgResponseTime && primaryHealth.avgResponseTime > 5000)
    );

    if (needsFailover) {
        logger.warn('Primary model unhealthy, failing over', {
            primary: { host: targetHost, model: targetModel },
            health: primaryHealth
        });

        const backupHost = getBackupHost(targetHost);
        const backupHealth = await healthTracker.checkModelHealth(backupHost, targetModel);

        if (backupHealth.status === 'healthy') {
            const { RemediationAction } = require('../../models/RemediationAction');
            await RemediationAction.create({
                issueType: 'model_degradation',
                severity: 'medium',
                context: {
                    component: `${targetHost}:${targetModel}`,
                    metric: 'response_time',
                    threshold: 5000,
                    currentValue: primaryHealth.avgResponseTime
                },
                strategy: 'model_failover',
                action: `Switched from ${targetHost} to ${backupHost}`,
                automatedExecution: true,
                status: 'succeeded'
            });

            targetHost = backupHost;

            const alertService = require('./alertService').getAlertService();
            await alertService.triggerAlert('model_failover', 'warning', {
                title: 'Model Failover Triggered',
                message: `Primary model at ${targetHost} is slow (${primaryHealth.avgResponseTime}ms). Switched to ${backupHost}.`,
                primary: targetHost,
                backup: backupHost,
                responseTime: primaryHealth.avgResponseTime
            });
        } else {
            logger.error('Backup host also unhealthy', { backupHost, backupHealth });
        }
    }

    return {
        host: targetHost,
        model: targetModel,
        failedOver: needsFailover,
        health: primaryHealth,
        taskType: classification
    };
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
    if ((autoRoute && message) || taskType) {
        const routing = await classifyAndRoute(message, {
            preferredModel,
            preferredHost: taskType ? getPrimaryHostForTask(taskType) : undefined,
            taskType
        });

        return {
            model: routing.model,
            target: routing.host,
            taskType: routing.taskType,
            routed: true,
            failedOver: routing.failedOver,
            health: routing.health
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
    const host = HOSTS[hostKey];
    if (!host) {
        return { status: 'unknown', models: [], latency: -1 };
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
    const [primaryHealth, secondaryHealth] = await Promise.all([
        checkHostHealth('primary'),
        checkHostHealth('secondary')
    ]);
    
    return {
        hosts: {
            primary: { url: HOSTS.primary, ...primaryHealth },
            secondary: { url: HOSTS.secondary, ...secondaryHealth }
        },
        modelRouting: MODEL_ROUTING,
        taskModels: TASK_MODELS
    };
}

async function getModelHealth(host, model) {
    return await healthTracker.checkModelHealth(host, model);
}

async function getAllModelsHealth() {
    const hosts = [process.env.OLLAMA_HOST, process.env.OLLAMA_HOST_SECONDARY].filter(Boolean);
    const models = ['qwen2.5:7b', 'qwen2.5:14b', 'deepseek-r1:7b']; // Common models

    const healthChecks = [];
    for (const host of hosts) {
        for (const model of models) {
            healthChecks.push(
                getModelHealth(host, model).then(health => ({
                    host,
                    model,
                    ...health
                }))
            );
        }
    }

    return await Promise.all(healthChecks);
}

module.exports = {
    getTargetForModel,
    getModelForTask,
    classifyQuery,
    classifyAndRoute,
    routeRequest,
    checkHostHealth,
    getRoutingStatus,
    HOSTS,
    MODEL_ROUTING,
    TASK_MODELS,
    getModelHealth,
    getAllModelsHealth
};
