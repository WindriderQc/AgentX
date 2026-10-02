/**
 * Benchmark Routes - Core shared helpers
 * Judge-target resolution, batch conflict payloads and claim release used by
 * the core batch and judge sub-routers.
 */

const logger = require('../../config/logger');
const { JUDGE_CONFIG } = require('../../src/services/qualityScorer');
const { judgeUnavailablePayload } = require('../../src/services/benchmark/judgeReadiness');
const { resolveJudgeHost } = require('../../src/services/benchmark/judgeHostResolution');
const { releaseBenchmarkClaim } = require('../../src/clients/coreApiClient');
const { normalizeHostUrl } = require('../../src/helpers/ollamaHostConfig');
const path = require('path');
const fs = require('fs');
// An operator may explicitly configure a secondary judge artifact. There is no
// product-wide fallback model because installed inventory is deployment state.
const JUDGE_FALLBACK_MODEL = String(process.env.JUDGE_FALLBACK_MODEL || '').trim() || null;
const judgeWorkloadOptions = req => ({
    hosts: [req.body?.host, req.body?.judge_host, req.body?.reference_host].filter(Boolean)
});

function readJudgeDefaults() {
    try {
        const p = process.env.JUDGE_DEFAULTS_PATH
            || path.join(process.cwd(), 'config', 'judge-host-defaults.json');
        if (!fs.existsSync(p)) return {};
        return JSON.parse(fs.readFileSync(p, 'utf8')) || {};
    } catch { return {}; }
}

function isDuplicateKeyError(err) {
    return !!(err && (err.code === 11000 || String(err.message || '').includes('E11000')));
}

function judgeValidationAdmissionFailure(check) {
    const policy = {
        invalid_judge_target: { statusCode: 400, code: 'JUDGE_TARGET_REJECTED' },
        incomplete_judge_target: { statusCode: 400, code: 'JUDGE_TARGET_INCOMPLETE' },
        judge_host_not_configured: { statusCode: 400, code: 'JUDGE_HOST_NOT_CONFIGURED' },
        judge_model_unavailable: { statusCode: 409, code: 'JUDGE_MODEL_UNAVAILABLE' },
        selected_models_unavailable: { statusCode: 409, code: 'JUDGE_MODEL_UNAVAILABLE' },
        judge_host_unreachable: { statusCode: 503, code: 'JUDGE_HOST_UNREACHABLE' },
        hosts_unreachable: { statusCode: 503, code: 'JUDGE_HOST_UNREACHABLE' }
    }[check?.code] || { statusCode: 503, code: 'JUDGE_NOT_READY' };
    const payload = judgeUnavailablePayload(check, 'Judge validation');
    return {
        statusCode: policy.statusCode,
        payload: {
            ...payload,
            code: policy.code,
            admission_code: check?.code || 'unknown'
        }
    };
}

// Look up the per-host stored default judge model for a given judge host,
// matching the same way the judge-defaults store/endpoint does (by normalized
// host URL). Returns undefined when no default is recorded for that host.
function lookupHostJudgeDefault(judgeDefaults, judgeHost) {
    if (!judgeHost) return undefined;
    const normalizedTarget = normalizeHostUrl(judgeHost);
    for (const [host, model] of Object.entries(judgeDefaults || {})) {
        if (!host || !model) continue;
        if (normalizeHostUrl(host) === normalizedTarget) return model;
    }
    return undefined;
}

async function resolveBatchJudgeTarget(executionHost, judgeConfig = {}, { judgeDefaults } = {}) {
    // When the caller did not pin judge.host, prefer the env-driven JUDGE_CONFIG.host
    // (set via JUDGE_HOST in .env) over collapsing onto the execution host. This
    // keeps generation and judging on different GPUs by default.
    const effectiveHost = judgeConfig.host || JUDGE_CONFIG.host || undefined;
    const { judgeHost: resolvedJudgeHost } = resolveJudgeHost(executionHost, {
        ...judgeConfig,
        host: effectiveHost
    });

    // Judge model precedence:
    //   1. explicit judgeConfig.model (caller pinned it)
    //   2. per-host stored default for the resolved judge host (judge-defaults store)
    //   3. env-driven JUDGE_CONFIG.model fallback
    // Without step 2, a batch submitted with no judge_config.model would silently
    // be judged by the env default model even when the host-defaults UI/store says
    // otherwise — breaking drift comparability against the ratified judge baseline.
    const storedDefaults = judgeDefaults || readJudgeDefaults();
    const hostDefaultModel = judgeConfig.model
        ? undefined
        : lookupHostJudgeDefault(storedDefaults, resolvedJudgeHost);
    const effectiveModel = judgeConfig.model || hostDefaultModel || JUDGE_CONFIG.model || undefined;

    const effectiveJudgeConfig = {
        ...judgeConfig,
        host: effectiveHost,
        model: effectiveModel
    };

    return {
        normalizedJudgeConfig: effectiveJudgeConfig,
        validationHost: effectiveJudgeConfig.host || resolvedJudgeHost || null,
        validationModel: effectiveJudgeConfig.model || null
    };
}

function buildActiveBatchConflict(active) {
    const STUCK_THRESHOLD_SECONDS = 300;
    const inactiveSeconds = active.last_activity_at
        ? Math.floor((Date.now() - new Date(active.last_activity_at).getTime()) / 1000)
        : 0;

    return {
        status: 'error',
        error: 'Another batch is already running',
        active_batch: {
            id: active._id,
            run_name: active.run_name,
            status: active.status,
            progress: active.progress,
            inactive_seconds: inactiveSeconds,
            is_stuck: inactiveSeconds > STUCK_THRESHOLD_SECONDS,
            started_at: active.started_at
        },
        message: inactiveSeconds > STUCK_THRESHOLD_SECONDS
                ? 'The active batch appears stuck. Use the "Recover" button to stop it before starting a new batch.'
                : `Batch "${active.run_name}" is currently running (${active.progress}% complete). Please wait for it to finish or stop it first.`
    };
}

function buildActiveProfilingConflict(host, activeProfiling) {
    const first = activeProfiling[0] || {};
    const label = first.type === 'profile-host'
        ? `profile queue ${first.queueId || ''}`.trim()
        : `profile job ${first.profileId || ''}`.trim();
    return {
        status: 'error',
        code: 'EXECUTION_HOST_PROFILING',
        error: 'Execution host is currently profiling',
        host,
        active_profiling: activeProfiling,
        message: `Host ${host} has an active ${label}. Wait for profiling to finish or cancel it before starting a benchmark batch.`
    };
}

function batchClaimHosts(batch) {
    const hosts = new Set();
    const add = (host) => {
        const normalized = String(host || '').trim().replace(/\/+$/, '');
        if (normalized) hosts.add(normalized);
    };

    add(batch?.host);
    for (const entry of batch?.plan?.exec_hosts || []) {
        add(entry?.exec_host);
        add(entry?.judge_host);
    }
    return [...hosts];
}

function releaseStoppedBatchClaims(batch) {
    const batchId = String(batch?._id || '');
    const hosts = batchClaimHosts(batch);
    if (!batchId || hosts.length === 0) return hosts;

    setImmediate(async () => {
        for (const hostUrl of hosts) {
            try {
                await releaseBenchmarkClaim(hostUrl, batchId);
                logger.info('Released benchmark claim after stop', { batchId, hostUrl });
            } catch (err) {
                logger.warn('Failed to release benchmark claim after stop', {
                    batchId,
                    hostUrl,
                    error: err.message
                });
            }
        }
    });

    return hosts;
}

module.exports = {
    JUDGE_FALLBACK_MODEL,
    judgeWorkloadOptions,
    readJudgeDefaults,
    isDuplicateKeyError,
    judgeValidationAdmissionFailure,
    lookupHostJudgeDefault,
    resolveBatchJudgeTarget,
    buildActiveBatchConflict,
    buildActiveProfilingConflict,
    batchClaimHosts,
    releaseStoppedBatchClaims
};
