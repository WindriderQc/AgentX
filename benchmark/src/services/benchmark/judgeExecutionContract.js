'use strict';

const { coreRequest } = require('../../clients/coreApiClient');
const { normalizeJudgeNumCtx } = require('../scoring/judgeRuntimeConfig');
const { resolveJudgeConfig } = require('../scoring/resolveJudgeConfig');
const { exactModelNamesMatch, normalizeHostUrl } = require('../../../../shared/artifactIdentity');

// Judge identity is independent of the candidate's profile qualification.
// A stale performance profile must not discard a pinned context or substitute
// Ollama's default. Identity and context still have to be resolved explicitly.
async function freezeJudgeConfig(config, { signal = null, resolveContract = coreRequest } = {}) {
    const resolved = resolveJudgeConfig(config);
    if (resolved.target?.executionKind === 'harness') return resolved;
    const explicit = normalizeJudgeNumCtx(resolved.num_ctx);
    const snapshot = await resolveContract('/api/inference/contract/resolve', {
        method: 'POST', signal,
        body: JSON.stringify({ model: resolved.model, host: resolved.host,
            options: { ...(explicit ? { num_ctx: explicit } : {}), num_predict: resolved.num_predict } })
    });
    const artifact = snapshot?.artifact;
    const numCtx = snapshot?.contextBudget?.windowTokens;
    if (snapshot?.version !== 'agentx.inference-contract.v1'
        || !Number.isSafeInteger(numCtx) || numCtx < 512 || (explicit && numCtx !== explicit)
        || !artifact?.digest || !artifact?.runtimeFingerprint
        || artifact.identityQualified !== true || artifact.registryQualified !== true
        || !exactModelNamesMatch(artifact.model, resolved.model)
        || normalizeHostUrl(artifact.host) !== normalizeHostUrl(resolved.host)) {
        throw Object.assign(new Error('Cannot freeze judge: exact artifact, runtime and context are required'), {
            code: 'JUDGE_EXECUTION_CONTRACT_UNRESOLVED', statusCode: 422
        });
    }
    const frozen = {
        ...resolved, num_ctx: numCtx,
        execution_contract: {
            schema: 'agentx.benchmark-judge-execution/v1', num_ctx: numCtx,
            artifact: { model: artifact.model, host: normalizeHostUrl(artifact.host),
                hostId: artifact.hostId || null, digest: artifact.digest, runtimeFingerprint: artifact.runtimeFingerprint }
        }
    };
    if (resolved.multi_judge?.enabled) {
        const multi = resolved.multi_judge;
        const options = { signal, resolveContract };
        frozen.multi_judge = { ...multi,
            judges: await Promise.all((multi.judges || []).map(judge => freezeJudgeConfig(judge, options))),
            tiebreaker: multi.tiebreaker ? await freezeJudgeConfig(multi.tiebreaker, options) : null
        };
    }
    return frozen;
}

module.exports = { freezeJudgeConfig };
