'use strict';

const crypto = require('crypto');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const { getFetchOptions } = require('../../helpers/httpAgent');
const { withBenchmarkServiceAuth } = require('../../helpers/coreServiceAuth');
const { benchmarkFetch } = require('./http');
const { getModelDigest } = require('./modelDigestService');
const { normalizeModelTag } = require('../../../../shared/modelNames');
const { RESPONSE_BUDGET_RULE } = require('./config');

const CORE_URL = process.env.CORE_URL || 'http://localhost:3080';
const CAMPAIGN_SCHEMA_VERSION = 1;
const CONTRACT_VERSION = 'agentx.inference-contract.v1';
const MIN_FROZEN_INPUT_TOKENS = 2048;
const MODES = Object.freeze({
    FINAL_ONLY: 'final_only',
    NATIVE: 'native',
    EXPLICIT_THINKING: 'explicit_thinking',
    PROFILE_AUTO: 'profile_auto',
    BEST_QUALIFIED: 'best_qualified'
});

function stableSerialize(value) {
    if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
    }
    return value === undefined ? 'null' : JSON.stringify(value);
}

function fingerprint(value) {
    return crypto.createHash('sha256').update(stableSerialize(value)).digest('hex');
}

function candidateKey(host, model) {
    return fingerprint({ host: String(host || '').replace(/\/+$/, ''), model: String(model || '') });
}

function normalizeResponseMode(config = {}) {
    const raw = String(config.response_mode || '').trim().toLowerCase();
    if (['final_only', 'final-only', 'off'].includes(raw)) return MODES.FINAL_ONLY;
    if (['native', 'default', 'native_default'].includes(raw)) return MODES.NATIVE;
    if (['explicit_thinking', 'explicit-thinking', 'thinking', 'on'].includes(raw)) return MODES.EXPLICIT_THINKING;
    if (['profile_auto', 'profile-auto', 'auto'].includes(raw)) return MODES.PROFILE_AUTO;
    if (['best_qualified', 'best-qualified', 'thinking_mode'].includes(raw) || config.think === 'best_qualified') return MODES.BEST_QUALIFIED;
    if (config.think === true) return MODES.EXPLICIT_THINKING;
    if (config.think === false) return MODES.FINAL_ONLY;
    return MODES.PROFILE_AUTO;
}

function resolveFrozenMode(contract, config = {}) {
    const name = normalizeResponseMode(config);
    const thinking = contract?.capabilities?.thinking || {};
    const thinkingQualified = contract?.qualification?.qualified === true
        && thinking.supported === true
        && Array.isArray(thinking.modes)
        && thinking.modes.includes('on')
        && thinking.visibleFinalAnswer?.qualified === true;

    if (name === MODES.FINAL_ONLY) {
        return { name, think: false, sendThink: true, rankable: true, source: 'explicit' };
    }
    if (name === MODES.NATIVE) {
        return { name, think: null, sendThink: false, rankable: true, source: 'explicit' };
    }
    if (name === MODES.EXPLICIT_THINKING) {
        return {
            name,
            think: true,
            sendThink: true,
            rankable: thinkingQualified,
            source: 'explicit',
            reason: thinkingQualified
                ? 'deployed artifact/host profile qualifies thinking with a visible final answer'
                : 'explicit thinking is diagnostic because the artifact/host thinking contract is unqualified'
        };
    }

    if (name === MODES.BEST_QUALIFIED) {
        // Thinking mode: rankable either way. Thinking is on from the level
        // only where it is qualified (as explicit_thinking requires to rank);
        // otherwise every answer is final-only.
        const thinkMinLevel = Number.isInteger(config.thinking_min_level) ? config.thinking_min_level : 4;
        return {
            name,
            think: thinkingQualified,
            thinkMinLevel,
            sendThink: true,
            rankable: true,
            source: 'explicit',
            reason: thinkingQualified
                ? `thinking mode: thinking from L${thinkMinLevel}, qualified by the deployed artifact/host profile`
                : 'thinking mode: thinking unqualified for this artifact/host, final answers only'
        };
    }

    const policy = thinking.recommendedPolicy || 'unknown';
    const enabled = thinkingQualified && ['on', 'metered'].includes(policy);
    return {
        name,
        think: enabled,
        sendThink: true,
        rankable: false,
        source: 'contract_profile',
        reason: `profiling-only auto mode froze recommendedPolicy=${policy} to think=${enabled}`
    };
}

function buildResolutionRequest(model, host, executionConfig = {}) {
    const options = {};
    if (Number.isFinite(executionConfig.force_num_ctx) && executionConfig.force_num_ctx > 0) {
        options.num_ctx = Math.round(executionConfig.force_num_ctx);
    }
    if (executionConfig.response_max_tokens_source === 'caller'
        && Number.isFinite(executionConfig.response_max_tokens)
        && executionConfig.response_max_tokens > 0) {
        options.num_predict = Math.round(executionConfig.response_max_tokens);
    }
    return { model, host, options };
}

function validateSnapshot(snapshot, requested) {
    if (!snapshot || snapshot.version !== CONTRACT_VERSION) {
        throw new Error(`Core returned an unsupported inference contract for ${requested.model} on ${requested.host}`);
    }
    if (!/^[a-f0-9]{64}$/.test(String(snapshot.snapshot?.fingerprint || ''))) {
        throw new Error(`Core returned an invalid inference contract fingerprint for ${requested.model} on ${requested.host}`);
    }
    if (!snapshot.artifact?.digest
        || !snapshot.artifact?.runtimeFingerprint
        || snapshot.artifact?.identityQualified !== true
        || snapshot.artifact?.registryQualified !== true
        || snapshot.qualification?.qualified !== true
        || snapshot.qualification?.exactArtifact !== true) {
        throw new Error(`Cannot freeze ${requested.model} on ${requested.host}: deployed artifact digest is unresolved`);
    }
    const requestedHost = String(requested.host || '').replace(/\/+$/, '').toLowerCase();
    const returnedHost = String(snapshot.artifact?.host || '').replace(/\/+$/, '').toLowerCase();
    if (normalizeModelTag(snapshot.artifact?.model).toLowerCase() !== normalizeModelTag(requested.model).toLowerCase()
        || returnedHost !== requestedHost) {
        throw new Error(`Core returned a contract for a different artifact or host than ${requested.model} on ${requested.host}`);
    }
    const windowTokens = Number(snapshot.contextBudget?.windowTokens);
    const outputTokens = Number(snapshot.contextBudget?.output?.reservedTokens);
    const validatedWindowTokens = Number(snapshot.contextBudget?.validatedWindowTokens);
    if (!Number.isInteger(windowTokens) || windowTokens <= 0
        || !Number.isInteger(outputTokens) || outputTokens <= 0
        || (windowTokens - outputTokens) < MIN_FROZEN_INPUT_TOKENS) {
        throw new Error(`Inference contract for ${requested.model} leaves no safe input budget (${windowTokens} ctx, ${outputTokens} output)`);
    }
    if (!Number.isInteger(validatedWindowTokens) || validatedWindowTokens <= 0
        || windowTokens > validatedWindowTokens) {
        throw new Error(
            `Context ${windowTokens} is not verified for ${requested.model} on ${requested.host}. Profile this model and choose a context within its verified range. Run a Full profile for automatic context recommendations.`
        );
    }
}

/**
 * A judge is not the artifact being measured: it only needs the context Core
 * serves it at, so its profile may be stale. The artifact identity and the
 * window still have to be the ones asked for.
 */
function validateJudgeContext(snapshot, requested) {
    if (!snapshot || snapshot.version !== CONTRACT_VERSION) {
        throw new Error(`Core returned an unsupported inference contract for ${requested.model} on ${requested.host}`);
    }
    const requestedHost = String(requested.host || '').replace(/\/+$/, '').toLowerCase();
    const returnedHost = String(snapshot.artifact?.host || '').replace(/\/+$/, '').toLowerCase();
    if (normalizeModelTag(snapshot.artifact?.model).toLowerCase() !== normalizeModelTag(requested.model).toLowerCase()
        || returnedHost !== requestedHost) {
        throw new Error(`Core returned a contract for a different artifact or host than ${requested.model} on ${requested.host}`);
    }
    const windowTokens = Number(snapshot.contextBudget?.windowTokens);
    if (!Number.isInteger(windowTokens) || windowTokens <= 0) {
        throw new Error(`Inference contract for ${requested.model} on ${requested.host} carries no context window`);
    }
}

async function fetchSnapshot(request, deps = {}) {
    const coreUrl = deps.coreUrl || CORE_URL;
    const fetchImpl = deps.fetchImpl || benchmarkFetch;
    const url = `${coreUrl}/api/inference/contract/resolve`;
    const response = await fetchImpl(url, getFetchOptions(url, {
        method: 'POST',
        headers: withBenchmarkServiceAuth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(request)
    }));
    const payload = await response.json();
    if (!response.ok) {
        throw new Error(payload?.message || payload?.error || `Core contract resolution failed with HTTP ${response.status}`);
    }
    (deps.validate || validateSnapshot)(payload, request);
    return payload;
}

/**
 * The context window Core freezes for a model on a host, from the same
 * contract candidates use. A judge that omits num_ctx makes Ollama reload a
 * resident model at its default context, so judges read this value instead,
 * whether or not the judge's own profile is benchmark-qualified.
 */
async function resolveContractNumCtx(model, host, deps = {}) {
    const snapshot = await fetchSnapshot({ model, host, options: {} }, { ...deps, validate: validateJudgeContext });
    return {
        num_ctx: snapshot.contextBudget.windowTokens,
        source: `inference_contract:${snapshot.contextBudget.source}`
    };
}

/**
 * The response budget of a launch that set none: the documented default
 * (`execution_config.response_max_tokens`), limited to half of the frozen
 * window so the other half stays for the prompt, and never below the reserve
 * Core chose. Null when Core's reserve already covers it.
 */
function documentedDefaultBudget(snapshot, executionConfig) {
    if (executionConfig.response_budget_rule !== RESPONSE_BUDGET_RULE) return null;
    const windowTokens = snapshot.contextBudget.windowTokens;
    const reserved = snapshot.contextBudget.output.reservedTokens;
    const inputFloor = Math.max(MIN_FROZEN_INPUT_TOKENS, Math.ceil(windowTokens / 2));
    const budget = Math.min(Number(executionConfig.response_max_tokens) || 0, windowTokens - inputFloor);
    return budget > reserved ? budget : null;
}

function buildCandidate(snapshot, request, executionConfig) {
    const mode = resolveFrozenMode(snapshot, executionConfig);
    return {
        key: candidateKey(request.host, request.model),
        model: request.model,
        host: request.host,
        artifactDigest: snapshot.artifact.digest,
        contractFingerprint: snapshot.snapshot.fingerprint,
        mode,
        execution: {
            num_ctx: snapshot.contextBudget.windowTokens,
            num_ctx_source: `inference_contract:${snapshot.contextBudget.source}`,
            num_predict: snapshot.contextBudget.output.reservedTokens,
            num_predict_source: request.options?.num_predict
                ? (executionConfig.response_max_tokens_source === 'caller' ? 'caller' : RESPONSE_BUDGET_RULE)
                : 'core_default_reserve',
            sampling: {
                profile: executionConfig.sampling_profile || 'controlled',
                source: executionConfig.sampling_source || 'controlled_override',
                temperature: executionConfig.temperature ?? null,
                top_p: executionConfig.top_p ?? null,
                top_k: executionConfig.top_k ?? null,
                repeat_penalty: executionConfig.repeat_penalty ?? null,
                seed: executionConfig.seed ?? null
            }
        },
        contract: snapshot
    };
}

function campaignRequest(hostGroups, executionConfig) {
    const candidates = [];
    for (const [host, models] of hostGroups) {
        for (const model of models) {
            candidates.push(buildResolutionRequest(model, host, executionConfig));
        }
    }
    return {
        schemaVersion: CAMPAIGN_SCHEMA_VERSION,
        responseMode: normalizeResponseMode(executionConfig),
        fixedSettings: {
            sampling_profile: executionConfig.sampling_profile || 'controlled',
            sampling_source: executionConfig.sampling_source || 'controlled_override',
            temperature: executionConfig.temperature ?? null,
            top_p: executionConfig.top_p ?? null,
            top_k: executionConfig.top_k ?? null,
            repeat_penalty: executionConfig.repeat_penalty ?? null,
            seed: executionConfig.seed ?? null,
            api_mode: executionConfig.api_mode || 'chat',
            repeats: Number(executionConfig.repeats) || 1,
            answer_contract_mode: executionConfig.answer_contract_mode || 'auto',
            include_length_hint: executionConfig.include_length_hint === true,
            thinking_final_answer_policy: executionConfig.thinking_final_answer_policy || 'visible_required'
        },
        candidates
    };
}

function validatePersistedCampaign(campaign, requestFingerprint) {
    if (!campaign || campaign.schemaVersion !== CAMPAIGN_SCHEMA_VERSION) return false;
    if (campaign.requestFingerprint !== requestFingerprint) {
        throw new Error('Persisted inference contract campaign does not match the requested model/host matrix or execution mode');
    }
    for (const candidate of campaign.candidates || []) {
        validateSnapshot(candidate.contract, candidate);
        if (candidate.contractFingerprint !== candidate.contract.snapshot.fingerprint) {
            throw new Error(`Persisted inference contract fingerprint mismatch for ${candidate.model} on ${candidate.host}`);
        }
    }
    return true;
}

/**
 * Lightweight validation of a persisted campaign for resume. Only checks
 * campaign-level metadata; individual candidate contracts are validated
 * lazily during model execution (assertFrozenArtifactDigest and
 * getFrozenModelExecutionConfig already verify per-model).
 *
 * Throws a closed, actionable error if the snapshot is missing or
 * incompatible so that resume fails fast rather than silently reloading
 * the full roster.
 */
function validateCampaignMetadata(campaign, requestFingerprint) {
    if (!campaign || campaign.schemaVersion !== CAMPAIGN_SCHEMA_VERSION) {
        const reason = !campaign
            ? 'missing frozen campaign snapshot'
            : `incompatible campaign schema version (expected ${CAMPAIGN_SCHEMA_VERSION}, got ${campaign.schemaVersion})`;
        const err = new Error(`Resume blocked: ${reason}. A full restart is required.`);
        err.resumeBlocked = true;
        err.code = 'MISSING_OR_INCOMPATIBLE_CAMPAIGN';
        throw err;
    }
    if (campaign.requestFingerprint !== requestFingerprint) {
        const err = new Error(
            'Resume blocked: frozen campaign snapshot does not match the current ' +
            'model/host matrix or execution mode (fingerprint mismatch). A full restart is required.'
        );
        err.resumeBlocked = true;
        err.code = 'CAMPAIGN_FINGERPRINT_MISMATCH';
        throw err;
    }
    if (!Array.isArray(campaign.candidates) || campaign.candidates.length === 0) {
        const err = new Error('Resume blocked: frozen campaign has no candidate contracts. A full restart is required.');
        err.resumeBlocked = true;
        err.code = 'EMPTY_CAMPAIGN';
        throw err;
    }
    return true;
}

async function readPersistedCampaign(batchId, BatchModel = BenchmarkBatch) {
    const query = BatchModel.findById(batchId);
    if (!query || typeof query.select !== 'function') return null;
    return query.select('inference_contract_campaign').lean();
}

async function loadOrResolveCampaignInferenceContracts({
    batchId,
    hostGroups,
    executionConfig,
    recordBatchTimelineEvent
}, deps = {}) {
    const BatchModel = deps.BatchModel || BenchmarkBatch;
    const request = campaignRequest(hostGroups, executionConfig);
    const requestFingerprint = fingerprint(request);
    const existingDoc = await readPersistedCampaign(batchId, BatchModel);
    if (validatePersistedCampaign(existingDoc?.inference_contract_campaign, requestFingerprint)) {
        return existingDoc.inference_contract_campaign;
    }

    const campaign = await resolveStandaloneCampaignInferenceContracts({
        hostGroups,
        executionConfig
    }, deps);

    const update = await BatchModel.updateOne(
        {
            _id: batchId,
            $or: [
                { inference_contract_campaign: { $exists: false } },
                { inference_contract_campaign: null }
            ]
        },
        { $set: { inference_contract_campaign: campaign, last_activity_at: new Date() } }
    );
    if (update?.matchedCount === 0) {
        const racedDoc = await readPersistedCampaign(batchId, BatchModel);
        if (!validatePersistedCampaign(racedDoc?.inference_contract_campaign, requestFingerprint)) {
            throw new Error('A concurrent runner persisted an incompatible inference contract campaign');
        }
        return racedDoc.inference_contract_campaign;
    }

    if (typeof recordBatchTimelineEvent === 'function') {
        await recordBatchTimelineEvent('inference_contract_frozen', {
            success: true,
            response_mode: campaign.responseMode,
            rankable: campaign.rankable,
            request_fingerprint: requestFingerprint,
            contracts: campaign.candidates.map(candidate => ({
                model: candidate.model,
                host: candidate.host,
                artifact_digest: candidate.artifactDigest,
                contract_fingerprint: candidate.contractFingerprint,
                rankable: candidate.mode.rankable
            }))
        });
    }
    return campaign;
}

/**
 * Resume a frozen campaign snapshot for checkpoint resume.
 *
 * On resume the campaign MUST already exist and be compatible. We never
 * re-resolve the full roster here — that would be an unnecessary reload.
 * Per-model artifact-drift and contract validity are checked lazily in
 * runModelPromptLoop via assertFrozenArtifactDigest and
 * getFrozenModelExecutionConfig.
 *
 * @returns {Promise<Object>} The frozen campaign
 * @throws {Error} With `err.resumeBlocked = true` if the snapshot is missing
 *                 or incompatible, so the caller can persist the reason and
 *                 fail closed.
 */
async function loadOrResumeCampaignInferenceContracts({
    batchId,
    hostGroups,
    executionConfig
}, deps = {}) {
    const BatchModel = deps.BatchModel || BenchmarkBatch;
    const request = campaignRequest(hostGroups, executionConfig);
    const requestFingerprint = fingerprint(request);
    const existingDoc = await readPersistedCampaign(batchId, BatchModel);
    const campaign = existingDoc?.inference_contract_campaign;

    validateCampaignMetadata(campaign, requestFingerprint);

    return campaign;
}

/**
 * Resolve a complete campaign contract without Mongo persistence. This is for
 * benchmark-owned executable qualification runners that persist their own
 * immutable report directory instead of a BenchmarkBatch document. Resolution
 * still happens exactly once before attempt one; callers must reuse the returned
 * object for the whole matrix.
 */
async function resolveStandaloneCampaignInferenceContracts({
    hostGroups,
    executionConfig
}, deps = {}) {
    const request = campaignRequest(hostGroups, executionConfig);
    const requestFingerprint = fingerprint(request);
    const candidates = [];
    for (const candidateRequest of request.candidates) {
        let resolved = candidateRequest;
        let snapshot = await fetchSnapshot(candidateRequest, deps);
        const budget = candidateRequest.options.num_predict ? null : documentedDefaultBudget(snapshot, executionConfig);
        if (budget) {
            // Same window, documented budget instead of Core's reserve.
            resolved = { ...candidateRequest, options: { ...candidateRequest.options, num_predict: budget } };
            snapshot = await fetchSnapshot(resolved, deps);
        }
        candidates.push(buildCandidate(snapshot, resolved, executionConfig));
    }
    return {
        schemaVersion: CAMPAIGN_SCHEMA_VERSION,
        requestFingerprint,
        responseMode: request.responseMode,
        fixedSettings: request.fixedSettings,
        rankable: candidates.every(candidate => candidate.mode.rankable === true),
        resolvedAt: new Date().toISOString(),
        candidates
    };
}

function getFrozenModelExecutionConfig(campaign, model, host, baseConfig = {}) {
    const key = candidateKey(host, model);
    const candidate = campaign?.candidates?.find(entry => entry.key === key);
    if (!candidate) throw new Error(`No frozen inference contract for ${model} on ${host}`);
    const fixed = campaign.fixedSettings || {};
    return {
        ...baseConfig,
        response_max_tokens: candidate.execution.num_predict,
        num_ctx: candidate.execution.num_ctx,
        num_ctx_source: candidate.execution.num_ctx_source,
        think: candidate.mode.think,
        send_think: candidate.mode.sendThink,
        think_mode: candidate.mode.name,
        think_resolved_by: candidate.mode.source,
        thinking_policy_reason: candidate.mode.reason || null,
        think_min_level: candidate.mode.thinkMinLevel ?? null,
        rankable_mode: candidate.mode.rankable,
        inference_contract_fingerprint: candidate.contractFingerprint,
        inference_contract_request_fingerprint: campaign.requestFingerprint,
        artifact_digest: candidate.artifactDigest,
        sampling_profile: candidate.execution.sampling.profile || fixed.sampling_profile || 'controlled',
        sampling_source: candidate.execution.sampling.source || fixed.sampling_source || 'controlled_override',
        temperature: candidate.execution.sampling.temperature,
        top_p: candidate.execution.sampling.top_p,
        top_k: candidate.execution.sampling.top_k,
        repeat_penalty: candidate.execution.sampling.repeat_penalty,
        seed: candidate.execution.sampling.seed,
        api_mode: fixed.api_mode || baseConfig.api_mode,
        repeats: fixed.repeats || baseConfig.repeats,
        answer_contract_mode: fixed.answer_contract_mode || baseConfig.answer_contract_mode,
        include_length_hint: fixed.include_length_hint === true,
        thinking_final_answer_policy: fixed.thinking_final_answer_policy || baseConfig.thinking_final_answer_policy
    };
}

/**
 * The execution config of one prompt. In thinking mode a qualified model
 * thinks from its frozen minimum level only; below it, the answer is
 * final-only. Every other mode keeps the model's config unchanged.
 */
function promptExecConfig(modelExecConfig, prompt) {
    const minLevel = modelExecConfig?.think_min_level;
    if (modelExecConfig?.think_mode !== MODES.BEST_QUALIFIED || !Number.isInteger(minLevel)) return modelExecConfig;
    const level = Number(prompt?.level);
    const think = modelExecConfig.think === true && level >= minLevel;
    const reason = modelExecConfig.think === true
        ? `thinking mode: L${level} ${think ? '>=' : '<'} L${minLevel}, thinking ${think ? 'on' : 'off'}`
        : modelExecConfig.thinking_policy_reason;
    return { ...modelExecConfig, think, thinking_policy_reason: reason };
}

async function assertFrozenArtifactDigest(campaign, model, host, deps = {}) {
    const key = candidateKey(host, model);
    const candidate = campaign?.candidates?.find(entry => entry.key === key);
    if (!candidate) throw new Error(`No frozen inference contract for ${model} on ${host}`);
    const digestResolver = deps.getModelDigest || getModelDigest;
    const currentDigest = await digestResolver(host, model);
    if (!currentDigest) {
        throw new Error(`Cannot verify deployed artifact digest for ${model} on ${host} before execution`);
    }
    if (currentDigest !== candidate.artifactDigest) {
        throw new Error(
            `Deployed artifact changed after campaign freeze for ${model} on ${host}: `
            + `${candidate.artifactDigest} -> ${currentDigest}`
        );
    }
    return candidate.artifactDigest;
}

module.exports = {
    CAMPAIGN_SCHEMA_VERSION,
    MIN_FROZEN_INPUT_TOKENS,
    MODES,
    assertFrozenArtifactDigest,
    buildResolutionRequest,
    candidateKey,
    documentedDefaultBudget,
    getFrozenModelExecutionConfig,
    loadOrResolveCampaignInferenceContracts,
    loadOrResumeCampaignInferenceContracts,
    normalizeResponseMode,
    promptExecConfig,
    resolveContractNumCtx,
    resolveStandaloneCampaignInferenceContracts,
    resolveFrozenMode,
    validateSnapshot,
    validateCampaignMetadata
};
