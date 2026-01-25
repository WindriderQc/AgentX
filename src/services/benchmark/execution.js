/**
 * Benchmark Execution Module
 * Core test execution, batch management, and progress tracking
 */

const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));
const logger = require('../../../config/logger');
const { getFetchOptions } = require('../../helpers/httpAgent');
const BenchmarkPrompt = require('../../../models/BenchmarkPrompt');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const { scoreResponse, calculateCompositeScore, JUDGE_CONFIG } = require('../qualityScorer');
const { HOSTS } = require('../modelRouter');
const hardwareProfileService = require('../hardwareProfileService');
const ConcurrencyQueue = require('./ConcurrencyQueue');
const { normalizeExecutionConfig, applyLengthHint, DEFAULT_EXECUTION_CONFIG } = require('./config');
const { seedPrompts } = require('./init');

// Track active batch for graceful shutdown
let activeBatchId = null;
let activeHeartbeatInterval = null;

/**
 * Get the current active batch ID (for shutdown handler)
 */
function getActiveBatchId() {
    return activeBatchId;
}

/**
 * Get the current heartbeat interval (for shutdown handler)
 */
function getActiveHeartbeatInterval() {
    return activeHeartbeatInterval;
}

/**
 * Clear active batch tracking (for shutdown handler)
 */
function clearActiveBatch() {
    if (activeHeartbeatInterval) {
        clearInterval(activeHeartbeatInterval);
        activeHeartbeatInterval = null;
    }
    activeBatchId = null;
}

/**
 * Run a single benchmark test
 */
async function runTest({ model, host, prompt }) {
    if (!model || !host || !prompt) {
        throw new Error('model, host, and prompt are required');
    }

    const start = Date.now();

    try {
        // Use HTTP agent for connection pooling and proper timeout handling
        const url = `${host}/api/generate`;
        const fetchOptions = getFetchOptions(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                prompt,
                stream: false,
                options: {
                    num_ctx: 8192
                }
            }),
            timeout: 120000  // 120 seconds for model loading on first request
        });
        const response = await fetch(url, fetchOptions);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        const latency = Date.now() - start;
        // Use actual token count from Ollama if available (eval_count = response tokens)
        // Fall back to character-based estimate only if Ollama doesn't provide it
        const tokens = data.eval_count || Math.ceil((data.response || '').length / 4);
        const tokenSource = data.eval_count ? 'ollama' : 'estimated';

        // Look up prompt metadata to store level/category
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

        const result = new BenchmarkResult({
            model,
            host,
            prompt,
            ...promptMeta,
            latency,
            tokens,
            tokens_per_sec: tokens > 0 ? (tokens / (latency / 1000)).toFixed(2) : 0,
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
        const result = new BenchmarkResult({
            model,
            host,
            prompt,
            error: err.message,
            success: false,
            timestamp: new Date()
        });

        await result.save();
        logger.error('Benchmark test failed', { model, host, error: err.message });

        throw err;
    }
}

/**
 * Start a batch benchmark test
 */
async function startBatch({ host, models, levels, run_name, quality_scoring = true, judge_config = {}, execution_config = {}, tags = [], description = '', execution_mode = 'latency' }) {
    if (!host || !models || !Array.isArray(models) || !levels || !Array.isArray(levels)) {
        throw new Error('host, models (array), and levels (array) are required');
    }

    await seedPrompts();

    // Get prompts for selected levels
    const selectedPrompts = await BenchmarkPrompt.getByLevels(levels);

    if (selectedPrompts.length === 0) {
        throw new Error('No prompts found for selected levels');
    }

    // Build execution plan
    const modelsByHost = {};
    for (const model of models) {
        let targetHost = host;
        // Model routing disabled for benchmark tool - respect user selection
        if (!modelsByHost[targetHost]) modelsByHost[targetHost] = [];
        modelsByHost[targetHost].push(model);
    }

    const judgeSameHost = (judge_config && judge_config.judge_same_host !== undefined)
        ? !!judge_config.judge_same_host
        : false;
    const normalizedExecutionConfig = normalizeExecutionConfig(execution_config);

    const execHosts = Object.entries(modelsByHost).map(([exec_host, hostModels]) => {
        let judge_host = exec_host;
        if (!judgeSameHost) {
            judge_host = HOSTS.primary;
            if (exec_host === HOSTS.primary) judge_host = HOSTS.secondary;
            else if (exec_host === HOSTS.secondary) judge_host = HOSTS.primary;
        }

        return {
            exec_host,
            judge_host: quality_scoring ? judge_host : null,
            models: hostModels,
            tests: hostModels.length * selectedPrompts.length
        };
    });

    const categoryCounts = {};
    for (const p of selectedPrompts) {
        const cat = p.category || 'uncategorized';
        categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    }

    const categories = Object.entries(categoryCounts)
        .map(([category, prompt_count]) => ({
            category,
            prompt_count,
            tests: prompt_count * models.length
        }))
        .sort((a, b) => b.tests - a.tests);

    const plan = {
        exec_hosts: execHosts,
        judge_model: (judge_config && judge_config.model) ? judge_config.model : JUDGE_CONFIG.model,
        judge_same_host: judgeSameHost,
        execution_config: normalizedExecutionConfig,
        total_models: models.length,
        total_prompts: selectedPrompts.length,
        categories
    };

    const batch = new BenchmarkBatch({
        host,
        models,
        levels,
        quality_scoring,
        judge_config,
        execution_config: normalizedExecutionConfig,
        run_name: run_name || `Batch ${new Date().toLocaleString()}`,
        total_tests: models.length * selectedPrompts.length,
        plan,
        judge_same_host: judgeSameHost,
        judge_total: quality_scoring ? (models.length * selectedPrompts.length) : 0,
        status: 'running',
        started_at: new Date(),
        tags: Array.isArray(tags) ? tags : [],
        description: typeof description === 'string' ? description : '',
        execution_mode: execution_mode || 'latency'
    });

    // Capture system snapshot for reproducibility
    batch.captureSystemSnapshot();

    await batch.save();
    const batchId = batch._id.toString();

    // Start batch execution in background.
    // Skip in tests to keep Jest deterministic and avoid runaway async work.
    if (process.env.NODE_ENV !== 'test') {
        executeBatch(batchId, host, models, selectedPrompts, { quality_scoring, judge_config, execution_config: normalizedExecutionConfig, execution_mode }).catch(err => {
            logger.error('Batch execution failed', { batchId, error: err.message });
        });
    }

    return {
        batch_id: batchId,
        total_tests: batch.total_tests,
        quality_scoring,
        plan
    };
}

/**
 * Execute batch tests with parallel or serial host execution
 */
async function executeBatch(batchId, defaultHost, models, prompts, options = {}) {
    const enableQualityScoring = options.quality_scoring !== false;
    const judgeConfig = options.judge_config || {};
    const judgeSameHost = judgeConfig.judge_same_host !== undefined ? !!judgeConfig.judge_same_host : false;
    const executionMode = options.execution_mode || 'latency';

    // Prevent duplicate execution with atomic lock (prevents race conditions)
    const batch = await BenchmarkBatch.findOneAndUpdate(
        { _id: batchId, execution_started_at: null },  // Only update if not already locked
        {
            $set: {
                execution_started_at: new Date(),
                execution_pid: process.pid,
                last_activity_at: new Date()
            }
        },
        { new: true }  // Return updated document
    );

    if (!batch) {
        // Either batch doesn't exist or already locked by another process
        const existingBatch = await BenchmarkBatch.findById(batchId);
        if (!existingBatch) {
            logger.error('Batch not found', { batchId });
        } else {
            logger.warn('Skipping duplicate batch execution - already locked', {
                batchId,
                pid: process.pid,
                lockedBy: existingBatch.execution_pid
            });
        }
        return;
    }

    logger.info('Batch execution lock acquired', { batchId, pid: process.pid });

    const executionConfig = normalizeExecutionConfig(options.execution_config || batch.execution_config || {});

    // Track active batch for graceful shutdown
    activeBatchId = batchId;

    const recordBatchTimelineEvent = async (event, data = {}) => {
        try {
            await BenchmarkBatch.updateOne(
                { _id: batchId },
                {
                    $push: {
                        timeline: {
                            $each: [{
                                timestamp: new Date(),
                                event,
                                ...data
                            }],
                            $slice: -2500  // Cap timeline to prevent memory growth
                        }
                    },
                    $set: { last_activity_at: new Date() }
                }
            );
        } catch (err) {
            logger.debug('Failed to record timeline event', { batchId, event, error: err.message });
        }
    };

    await recordBatchTimelineEvent('prep_start', {
        model: enableQualityScoring ? (judgeConfig.model || JUDGE_CONFIG.model) : null,
        success: true
    });

    // Model warmup - send minimal request and wait for response
    // When response comes back, model is loaded in VRAM and ready for fast tests
    // Returns warmup data for validation/debugging
    const warmupModel = async (hostUrl, model, timelinePrefix = null) => {
        const warmupStart = Date.now();
        const warmupPrompt = 'Hi';
        const warmupData = {
            prompt: warmupPrompt,
            response: null,
            latency_ms: null,
            already_loaded: null,
            success: false,
            error: null
        };

        if (timelinePrefix) {
            await recordBatchTimelineEvent(`${timelinePrefix}_start`, { model, success: null });
        }

        try {
            // Check if model is already loaded in VRAM via /api/ps
            let modelAlreadyLoaded = false;
            try {
                const psController = new AbortController();
                const psTimeoutId = setTimeout(() => psController.abort(), 5000);
                const psResponse = await fetch(`${hostUrl}/api/ps`, {
                    method: 'GET',
                    signal: psController.signal
                });
                clearTimeout(psTimeoutId);

                if (psResponse.ok) {
                    const psData = await psResponse.json();
                    const loadedModels = (psData.models || []).map(m => m.name);
                    // Normalize model name matching: Ollama may return name:tag or full hashes
                    // Compare base names (before colon) or check if loaded model starts with requested model
                    const normalizeModelName = (name) => name.split(':')[0].toLowerCase();
                    const requestedBase = normalizeModelName(model);
                    modelAlreadyLoaded = loadedModels.some(loaded => {
                        const loadedBase = normalizeModelName(loaded);
                        return loaded === model ||  // Exact match
                               loadedBase === requestedBase ||  // Base name match
                               loaded.startsWith(model);  // Prefix match (e.g., "llama3" matches "llama3:latest")
                    });
                    if (modelAlreadyLoaded) {
                        logger.debug('Model already loaded in VRAM', { host: hostUrl, model, loadedModels });
                    }
                }
            } catch (psErr) {
                // Ignore /api/ps errors, proceed with warmup
                logger.debug('Could not check /api/ps', { host: hostUrl, error: psErr.message });
            }

            warmupData.already_loaded = modelAlreadyLoaded;

            // Use shorter timeout if model already loaded (should respond instantly)
            // Use longer timeout if model needs to load from disk to VRAM
            const timeoutMs = modelAlreadyLoaded ? 30000 : 180000; // 30s vs 3min
            logger.info('Warming up model', { host: hostUrl, model, alreadyLoaded: modelAlreadyLoaded, timeoutMs });

            const url = `${hostUrl}/api/generate`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

            const response = await fetch(url, {
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

            clearTimeout(timeoutId);
            const durationMs = Date.now() - warmupStart;
            warmupData.latency_ms = durationMs;

            if (response.ok) {
                const data = await response.json();
                warmupData.response = data.response || '';
                warmupData.success = true;
                logger.info('Model ready', { host: hostUrl, model, durationMs, wasLoaded: modelAlreadyLoaded });
                if (timelinePrefix) {
                    await recordBatchTimelineEvent(`${timelinePrefix}_complete`, {
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
            warmupData.error = err.message;
            logger.warn('Model warmup failed', { host: hostUrl, model, error: err.message, durationMs });

            if (timelinePrefix) {
                await recordBatchTimelineEvent(`${timelinePrefix}_complete`, {
                    model, duration_ms: durationMs, success: false, error: err.message
                });
            }
            // Don't throw - let tests try anyway
        }

        return warmupData;
    };

    // Per-batch judge queue - set concurrency based on execution mode
    const judgeConcurrency = executionMode === 'latency' ? 1 : (judgeConfig.concurrency || 2);
    const judgeQueue = new ConcurrencyQueue(judgeConcurrency);

    // Set up periodic heartbeat to update last_activity_at (every 10 seconds)
    const heartbeatInterval = setInterval(async () => {
        try {
            const currentBatch = await BenchmarkBatch.findById(batchId);
            if (currentBatch && ['running', 'judging'].includes(currentBatch.status)) {
                await currentBatch.heartbeat();
            } else {
                clearInterval(heartbeatInterval);
                activeHeartbeatInterval = null;
            }
        } catch (err) {
            logger.warn('Heartbeat failed', { batchId, error: err.message });
        }
    }, 10000);
    // Store reference for graceful shutdown
    activeHeartbeatInterval = heartbeatInterval;

    // Sync total_tests to actual plan
    const plannedTotalTests = models.length * prompts.length;
    if (plannedTotalTests > 0) {
        batch.total_tests = plannedTotalTests;
        await batch.save();
    }

    // Group models by host
    const modelsByHost = {};
    for (const model of models) {
        let targetHost = defaultHost;
        // Model routing disabled for benchmark tool
        if (!modelsByHost[targetHost]) {
            modelsByHost[targetHost] = [];
        }
        modelsByHost[targetHost].push(model);
    }

    // Create execution task functions (thunks) for each host
    // IMPORTANT: Using functions (not promises) so we control when execution starts
    // map(async ...) would start all promises immediately, breaking latency mode
    let testsStarted = false;
    const hostTasks = Object.entries(modelsByHost).map(([hostUrl, hostModels]) => async () => {
        try {
            // Determine judge host
            let judgeHostUrl = hostUrl;
            if (!judgeSameHost) {
                judgeHostUrl = HOSTS.primary;
                if (hostUrl === HOSTS.primary) {
                    judgeHostUrl = HOSTS.secondary;
                } else if (hostUrl === HOSTS.secondary) {
                    judgeHostUrl = HOSTS.primary;
                }
            }

            // Warmup judge BEFORE starting tests (if separate host)
            // This ensures judge model is loaded and ready before any test results need scoring
            let judgeWarmupData = null;
            if (enableQualityScoring && !judgeSameHost) {
                const jModel = judgeConfig.model || JUDGE_CONFIG.model;
                try {
                    judgeWarmupData = await warmupModel(judgeHostUrl, jModel, 'judge_warmup');
                    logger.info('Judge model ready', { host: judgeHostUrl, model: jModel });
                } catch (err) {
                    logger.warn('Judge warmup failed, judge calls may be slow', { error: err.message });
                }
            }

            for (const model of hostModels) {
                // Warmup tested model (await ensures accurate latency for first prompt)
                const modelWarmupData = await warmupModel(hostUrl, model, 'model_warmup');

                // Phase 3 Week 10: Detect hardware info after model is loaded
                const hardwareSnapshot = await hardwareProfileService.detectHardware(hostUrl, model);

                // Fetch batch once per model (outside prompt loop to avoid stale object issues)
                let currentBatch;
                try {
                    currentBatch = await BenchmarkBatch.findById(batchId);
                    if (!currentBatch) {
                        logger.error('Batch not found during execution', { batchId, model });
                        continue; // Skip this model but continue with others
                    }
                } catch (batchErr) {
                    logger.error('Failed to fetch batch object', { batchId, model, error: batchErr.message });
                    continue; // Skip this model but continue with others
                }

                for (const prompt of prompts) {
                    // Check if batch was stopped (lightweight query for status only)
                    try {
                        const stopCheck = await BenchmarkBatch.findById(batchId).select('status').lean();
                        if (stopCheck && stopCheck.status === 'stopped') {
                            logger.info('Batch execution stopped by user', { batchId });
                            clearInterval(heartbeatInterval);
                            activeHeartbeatInterval = null;
                            activeBatchId = null;
                            return;
                        }
                    } catch (stopCheckErr) {
                        logger.warn('Failed to check batch status', {
                            batchId,
                            model,
                            error: stopCheckErr.message
                        });
                        // Continue anyway - assume not stopped
                    }

                    if (!testsStarted) {
                        testsStarted = true;
                        await recordBatchTimelineEvent('tests_start', { success: true });
                    }

                    // Update current test indicator with detailed info
                    const testNumber = (currentBatch.completed || 0) + 1;
                    const start = Date.now();

                    try {
                        await currentBatch.updateCurrentTest(
                            model,
                            prompt._id ? prompt._id.toString() : null,
                            prompt.name,
                            'executing',
                            {
                                testNumber,
                                promptLevel: prompt.level
                            }
                        );
                        // After warmup, model should be loaded, so use standard timeout
                        // If model wasn't warmed up properly, this may still timeout
                        const url = `${hostUrl}/api/generate`;

                        // Simple: just use a high token limit and let models finish naturally
                        // No complicated multipliers or level-based calculations
                        const numPredict = executionConfig.response_max_tokens || 32000;
                        const expectedTokens = prompt.expected_tokens || null;  // For logging only
                        const promptText = applyLengthHint(prompt.prompt, expectedTokens, numPredict, executionConfig);
                        // Detect if any hints were applied
                        const hintApplied = promptText !== prompt.prompt;
                        // Extract the hint text that was appended (if any)
                        const hintText = hintApplied ? promptText.slice(prompt.prompt.length).trim() : null;

                        // Use AbortController for proper timeout (fetch ignores timeout option)
                        const testController = new AbortController();
                        const testTimeoutId = setTimeout(() => testController.abort(), 180000); // 3 min

                        const fetchOptions = getFetchOptions(url, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                model,
                                prompt: promptText,
                                stream: false,
                                options: { num_predict: numPredict }
                            }),
                            signal: testController.signal
                        });

                        let response;
                        try {
                            response = await fetch(url, fetchOptions);
                        } finally {
                            clearTimeout(testTimeoutId);
                        }

                        const data = await response.json();
                        const latency = Date.now() - start;
                        // Use actual token count from Ollama if available (eval_count = response tokens)
                        // Fall back to character-based estimate only if Ollama doesn't provide it
                        const tokens = data.eval_count || Math.ceil((data.response || '').length / 4);
                        const tokenSource = data.eval_count ? 'ollama' : 'estimated';
                        const tokens_per_sec = tokens > 0 ? (tokens / (latency / 1000)).toFixed(2) : 0;

                        // Detect if model response was truncated (hit token limit)
                        const responseTruncated = data.done_reason === 'length';
                        if (responseTruncated) {
                            logger.warn('Model response truncated', {
                                model,
                                prompt_name: prompt.name,
                                tokens,
                                num_predict: numPredict,
                                done_reason: data.done_reason
                            });
                        }

                        // Create result with warmup data for validation
                        const result = new BenchmarkResult({
                            model,
                            host: hostUrl,
                            judge_host: enableQualityScoring ? judgeHostUrl : null,
                            prompt: promptText,  // Store actual prompt sent (includes length hint if applied)
                            prompt_level: prompt.level,
                            prompt_category: prompt.category,
                            prompt_name: prompt.name,
                            expected_answer: prompt.expected_answer,
                            latency,
                            tokens,
                            tokens_per_sec,
                            response: data.response || '',
                            success: true,
                            batch_id: batchId,
                            timestamp: new Date(),
                            quality_score: null,
                            scoring_method: enableQualityScoring ? 'pending' : 'disabled',
                            judge_model: enableQualityScoring ? (judgeConfig.model || JUDGE_CONFIG.model) : null,
                            hardware_snapshot: hardwareSnapshot,
                            truncation: {
                                response_truncated: responseTruncated,
                                response_tokens: tokens,
                                response_limit: numPredict
                            },
                            execution_settings: {
                                num_predict: numPredict,
                                hint_applied: hintApplied,
                                hint_text: hintText
                            },
                            // Warmup data for test validation
                            warmup: modelWarmupData ? {
                                prompt: modelWarmupData.prompt,
                                response: modelWarmupData.response,
                                latency_ms: modelWarmupData.latency_ms,
                                already_loaded: modelWarmupData.already_loaded
                            } : null,
                            judge_warmup: judgeWarmupData ? {
                                prompt: judgeWarmupData.prompt,
                                response: judgeWarmupData.response,
                                latency_ms: judgeWarmupData.latency_ms,
                                already_loaded: judgeWarmupData.already_loaded
                            } : null
                        });

                        await result.save();
                        const resultId = result._id;

                        // Record test completion with timeline tracking
                        await currentBatch.recordTestComplete(
                            model,
                            prompt._id ? prompt._id.toString() : null,
                            latency,
                            true,
                            null,
                            prompt.level,
                            hostUrl,
                            tokens_per_sec
                        );

                        // Update batch progress with capped results array to prevent memory growth
                        await BenchmarkBatch.updateOne(
                            { _id: batchId },
                            {
                                $inc: { completed: 1 },
                                $push: {
                                    results: {
                                        $each: [{
                                            model,
                                            host: hostUrl,
                                            judge_host: enableQualityScoring ? judgeHostUrl : null,
                                            prompt_name: prompt.name,
                                            success: true,
                                            latency,
                                            response_preview: (data.response || '').substring(0, 100) + '...'
                                        }],
                                        $slice: -1000  // Keep only last 1000 result summaries
                                    }
                                }
                            }
                        );

                        // Use lean query to get only the fields we need, avoiding full document load
                        try {
                            const refreshedBatch = await BenchmarkBatch.findById(batchId)
                                .select('completed status')
                                .lean();
                            if (refreshedBatch) {
                                currentBatch.completed = refreshedBatch.completed;
                            }
                        } catch (refreshErr) {
                            logger.warn('Failed to refresh batch object', {
                                batchId,
                                model,
                                error: refreshErr.message
                            });
                            // Continue anyway - not critical for batch execution
                        }

                        // Queue quality scoring if enabled
                        if (enableQualityScoring) {
                            // Capture response string immediately, then allow data object to be GC'd
                            const responseText = data.response || '';

                            judgeQueue.add(async () => {
                                try {
                                    // Update current test to judging stage using direct updateOne
                                    // This avoids loading the entire batch document into memory
                                    await BenchmarkBatch.updateOne(
                                        { _id: batchId },
                                        {
                                            $set: {
                                                current_test: {
                                                    model,
                                                    prompt_id: prompt._id ? prompt._id.toString() : null,
                                                    prompt_name: prompt.name,
                                                    prompt_level: prompt.level,
                                                    stage: 'judging',
                                                    started_at: new Date(),
                                                    test_number: testNumber
                                                },
                                                last_activity_at: new Date()
                                            }
                                        }
                                    );

                                    // Judge model was warmed up before tests started (see warmup section above)
                                    const judgeStart = Date.now();
                                    const scores = await scoreResponse({
                                        response: responseText,
                                        prompt: prompt,
                                        judgeConfig: {
                                            ...judgeConfig,
                                            host: judgeHostUrl
                                        }
                                    });
                                    const judgeDuration = Date.now() - judgeStart;

                                    // Use category-specific composite scoring if category is available
                                    const categoryOrProfile = prompt.category || 'interactive';
                                    const composite = calculateCompositeScore({
                                        latency,
                                        tokens_per_sec,
                                        quality_score: scores.quality_score
                                    }, categoryOrProfile);

                                    logger.debug('Updating result with score', {
                                        resultId: resultId?.toString(),
                                        quality_score: scores.quality_score,
                                        scoring_method: scores.scoring_method
                                    });

                                    // Build truncation update if present (only judge output truncation tracked)
                                    const truncationUpdate = scores.truncation ? {
                                        'truncation.judge_truncated': scores.truncation.judge_truncated,
                                        'truncation.judge_tokens': scores.truncation.judge_tokens
                                    } : {};

                                    const updateResult = await BenchmarkResult.updateOne(
                                        { _id: resultId },
                                        {
                                            $set: {
                                                quality_score: scores.quality_score,
                                                quality_breakdown: scores.breakdown,
                                                quality_explanation: scores.explanation,
                                                judge_prompt: scores.judge_prompt,
                                                judge_model: scores.judge_model,
                                                judge_raw_response: scores.judge_raw_response,
                                                judge_hardware_snapshot: scores.judge_hardware_snapshot || null,
                                                scoring_method: scores.scoring_method,
                                                scoring_type: scores.scoring_type || prompt.scoring_type || 'reasoning',
                                                scoring_time_ms: scores.scoring_time_ms,
                                                quick_pattern: scores.quick_pattern,
                                                composite_score: composite.composite_score,
                                                composite_profile_used: composite.composite_profile_used,
                                                normalized_scores: composite.normalized,
                                                ...truncationUpdate
                                            }
                                        }
                                    );

                                    logger.debug('Result update complete', {
                                        resultId: resultId?.toString(),
                                        matchedCount: updateResult.matchedCount,
                                        modifiedCount: updateResult.modifiedCount
                                    });

                                    // Record judge completion with timeline tracking using direct updateOne
                                    // This avoids loading the entire batch document into memory
                                    await BenchmarkBatch.updateOne(
                                        { _id: batchId },
                                        {
                                            $inc: { judge_completed: 1 },
                                            $set: { last_activity_at: new Date() },
                                            $push: {
                                                timeline: {
                                                    $each: [{
                                                        timestamp: new Date(),
                                                        event: 'judge_complete',
                                                        model,
                                                        prompt_id: prompt._id ? prompt._id.toString() : null,
                                                        prompt_level: prompt.level,
                                                        duration_ms: judgeDuration,
                                                        success: true
                                                    }],
                                                    $slice: -2500  // Cap timeline to prevent memory growth
                                                }
                                            }
                                        }
                                    );
                                } catch (scoreErr) {
                                    logger.warn('Quality scoring failed', {
                                        model,
                                        prompt: prompt.name,
                                        error: scoreErr.message
                                    });

                                    await BenchmarkResult.updateOne(
                                        { _id: resultId },
                                        {
                                            $set: {
                                                scoring_method: 'llm_failed',
                                                quality_explanation: scoreErr.message,
                                                judge_model: judgeConfig.model || JUDGE_CONFIG.model
                                            }
                                        }
                                    );

                                    await BenchmarkBatch.updateOne(
                                        { _id: batchId },
                                        { $inc: { judge_completed: 1, judge_failed: 1 } }
                                    );
                                }
                            }).catch((enqueueErr) => {
                                logger.error('Failed to enqueue judge task', {
                                    batchId,
                                    model,
                                    prompt: prompt.name,
                                    error: enqueueErr.message
                                });
                            });
                        }

                        logger.info('Batch test completed', { batchId, model, prompt: prompt.name, latency });

                    } catch (err) {
                        const errorDuration = Date.now() - start;

                        try {
                            const result = new BenchmarkResult({
                                model,
                                host: hostUrl,
                                prompt: prompt.prompt,
                                prompt_level: prompt.level,
                                prompt_category: prompt.category,
                                prompt_name: prompt.name,
                                error: err.message,
                                success: false,
                                batch_id: batchId,
                                timestamp: new Date(),
                                quality_score: null,
                                scoring_method: enableQualityScoring ? 'exec_failed' : 'disabled',
                                judge_model: enableQualityScoring ? (judgeConfig.model || JUDGE_CONFIG.model) : null,
                                judge_host: enableQualityScoring ? judgeHostUrl : null
                            });

                            await result.save();

                            // Record test failure with timeline tracking
                            await currentBatch.recordTestComplete(
                                model,
                                prompt._id ? prompt._id.toString() : null,
                                errorDuration,
                                false,
                                err,
                                prompt.level,
                                hostUrl,
                                null
                            );

                            // Note: Do NOT increment judge_completed/judge_failed here
                            // This is an EXECUTION failure, not a judge failure
                            // judge_total will be set to actual successful executions later
                            await BenchmarkBatch.updateOne(
                                { _id: batchId },
                                {
                                    $inc: {
                                        completed: 1,
                                        failed: 1
                                        // Removed: judge counters - exec failures are not judge failures
                                    },
                                    $push: {
                                        results: {
                                            $each: [{
                                                model,
                                                prompt_name: prompt.name,
                                                success: false,
                                                error: err.message
                                            }],
                                            $slice: -1000  // Cap results array
                                        }
                                    }
                                }
                            );

                            // Use lean query to refresh only needed fields
                            const refreshedBatch = await BenchmarkBatch.findById(batchId)
                                .select('completed status')
                                .lean();
                            if (refreshedBatch) {
                                currentBatch.completed = refreshedBatch.completed;
                            }

                            logger.error('Batch test failed', {
                                batchId,
                                model,
                                prompt: prompt.name,
                                error: err.message
                            });
                        } catch (saveErr) {
                            // Critical: Don't let error handling failures stop the batch
                            logger.error('Failed to save error result', {
                                batchId,
                                model,
                                prompt: prompt.name,
                                originalError: err.message,
                                saveError: saveErr.message
                            });
                            // Continue to next prompt even if we couldn't save this error
                        }
                    }
                }
            }
        } catch (hostErr) {
            // Critical: Catch any unhandled errors in host execution to prevent batch stoppage
            logger.error('Host execution failed - continuing with other hosts', {
                batchId,
                host: hostUrl,
                models: hostModels,
                error: hostErr.message,
                stack: hostErr.stack
            });
            // Record timeline event for host failure
            await recordBatchTimelineEvent('host_execution_failed', {
                host: hostUrl,
                models: hostModels,
                error: hostErr.message
            }).catch(err => logger.error('Failed to record host failure event', { error: err.message }));
        }
    });

    // Execute serially (latency mode) or in parallel (throughput mode)
    if (executionMode === 'latency') {
        // Serial execution: run one host at a time for clean latency measurements
        // Each task is a thunk (function returning promise), so we invoke and await sequentially
        for (const task of hostTasks) {
            await task();
        }
    } else {
        // Parallel execution: maximize throughput
        // Invoke all thunks simultaneously and wait for all to complete
        await Promise.all(hostTasks.map(task => task()));
    }

    if (enableQualityScoring) {
        const postExecBatch = await BenchmarkBatch.findById(batchId);
        const wasStopped = postExecBatch && postExecBatch.status === 'stopped';

        // judge_total = only SUCCESSFUL executions (tests that can actually be judged)
        // Failed executions have nothing to judge, so don't count them
        let judgeableCount = 0;
        if (postExecBatch && typeof postExecBatch.completed === 'number') {
            // completed includes failures, so subtract failed to get successful count
            const failedCount = postExecBatch.failed || 0;
            judgeableCount = Math.max(0, postExecBatch.completed - failedCount);
        }

        // Fallback: count successful results directly from database
        if (judgeableCount === 0) {
            // Note: BenchmarkResult is already imported at top of file
            judgeableCount = await BenchmarkResult.countDocuments({
                batch_id: batchId,
                success: true  // Only count successful executions
            });
            logger.info('Using actual successful result count for judge_total', { batchId, judgeableCount });
        }

        if (!wasStopped) {
            await BenchmarkBatch.updateOne(
                { _id: batchId },
                {
                    $set: {
                        status: 'judging',
                        generated_at: new Date(),
                        judge_total: judgeableCount
                    }
                }
            );
        } else {
            await BenchmarkBatch.updateOne(
                { _id: batchId },
                { $set: { judge_total: judgeableCount, generated_at: new Date() } }
            );
            clearInterval(heartbeatInterval);
            activeHeartbeatInterval = null;
            activeBatchId = null;
            return;
        }

        // Wait for all judge tasks to complete with timeout protection
        logger.info('Starting judge queue drain', {
            batchId,
            queueStatus: judgeQueue.getStatus()
        });

        const drainResult = await judgeQueue.drain({
            timeoutMs: 30 * 60 * 1000,  // 30 minutes max
            stallTimeoutMs: 2 * 60 * 1000,  // 2 minutes stall detection
            onProgress: (status) => {
                logger.debug('Judge queue progress', { batchId, ...status });
            }
        });

        if (drainResult.timedOut) {
            logger.error('Judge queue drain failed', {
                batchId,
                reason: drainResult.reason,
                completed: drainResult.completed,
                failed: drainResult.failed
            });
            // Record timeline event for debugging
            await recordBatchTimelineEvent('judge_drain_timeout', {
                reason: drainResult.reason,
                completed: drainResult.completed,
                failed: drainResult.failed
            });
        }

        logger.info('Judge queue drain completed', {
            batchId,
            completed: drainResult.completed,
            failed: drainResult.failed,
            timedOut: drainResult.timedOut
        });

        // Check if stopped during judging
        const postJudgeBatch = await BenchmarkBatch.findById(batchId);
        if (postJudgeBatch && postJudgeBatch.status === 'stopped') {
            clearInterval(heartbeatInterval);
            activeHeartbeatInterval = null;
            activeBatchId = null;
            return;
        }
    }

    // Clear heartbeat interval and active batch tracking
    clearInterval(heartbeatInterval);
    activeHeartbeatInterval = null;
    activeBatchId = null;

    // Mark batch as completed and calculate metrics
    const finalBatch = await BenchmarkBatch.findById(batchId);
    if (finalBatch) {
        await finalBatch.clearCurrentTest();
        await finalBatch.markAsCompleted();
        await finalBatch.calculateMetrics();
        logger.info('Batch completed with metrics', {
            batchId,
            total_duration: finalBatch.execution_metrics?.total_duration_ms,
            tests_per_minute: finalBatch.execution_metrics?.tests_per_minute
        });

        // Phase 3 Week 10: Update hardware profiles for all tested model+host combinations
        try {
            const uniqueCombos = await BenchmarkResult.distinct('model', {
                batch_id: batchId,
                success: true,
                quality_score: { $ne: null }
            });

            for (const model of uniqueCombos) {
                // Get all hosts that tested this model
                const hosts = await BenchmarkResult.distinct('host', {
                    batch_id: batchId,
                    model,
                    success: true,
                    'hardware_snapshot.backend': { $ne: null }
                });

                for (const host of hosts) {
                    // Get representative hardware snapshot from this batch
                    const sampleResult = await BenchmarkResult.findOne({
                        batch_id: batchId,
                        model,
                        host,
                        'hardware_snapshot.backend': { $ne: null }
                    });

                    if (sampleResult && sampleResult.hardware_snapshot) {
                        await hardwareProfileService.updateProfile({
                            host,
                            model,
                            hardwareSnapshot: sampleResult.hardware_snapshot,
                            workspaceId: finalBatch.workspaceId
                        });
                    }
                }
            }

            logger.info('Hardware profiles updated', {
                batchId,
                models: uniqueCombos.length
            });
        } catch (err) {
            logger.warn('Failed to update hardware profiles', {
                batchId,
                error: err.message
            });
        }
    }
}

/**
 * Stop a running batch
 */
async function stopBatch(batchId) {
    const batch = await BenchmarkBatch.findById(batchId);

    if (!batch) {
        throw new Error('Batch not found');
    }

    const stoppableStatuses = new Set(['pending', 'running', 'judging']);
    if (!stoppableStatuses.has(batch.status)) {
        return { batch, alreadyStopped: true };
    }

    await batch.markAsStopped();
    logger.info('Batch stopped by user', { batchId });

    return { batch, alreadyStopped: false };
}

module.exports = {
    runTest,
    startBatch,
    executeBatch,
    stopBatch,
    getActiveBatchId,
    getActiveHeartbeatInterval,
    clearActiveBatch
};
