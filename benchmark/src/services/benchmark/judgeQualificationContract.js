'use strict';

const { fingerprint } = require('../../../../shared/workerContract');
const { normalizeHostUrl, exactModelNamesMatch } = require('../../../../shared/artifactIdentity');
const { normalizeModelTag } = require('../../../../shared/modelNames');
const { judgeCohortSettings, multiJudgeCohortSettings } = require('../../../../shared/benchmarkTargetContract');

const CONTRACT_SCHEMA = 'agentx.benchmark-judge-qualification-contract/v1';
const SETTING_KEYS = ['numCtx', 'numPredict', 'timeoutMs', 'temperature', 'seed',
    'maxRetries', 'votingCount', 'think', 'responseCharBudget'];

// Only resolved, frozen writer configurations enter here. Readers never use
// current defaults or a batch's mutable configuration to reconstruct a verdict.
function buildJudgeQualificationContract(config = {}, { escalation = null } = {}) {
    if (!config || typeof config !== 'object') return null;
    const execution = config.execution_contract;
    const artifact = execution?.artifact;
    if (execution?.schema !== 'agentx.benchmark-judge-execution/v1' || !artifact || !exactModelNamesMatch(config.model, artifact.model)
        || normalizeHostUrl(config.host) !== normalizeHostUrl(artifact.host)
        || !Object.hasOwn(config, 'seed')) return null;
    const contract = {
        schema: CONTRACT_SCHEMA,
        artifact: {
            model: normalizeModelTag(artifact.model).toLowerCase(),
            host: normalizeHostUrl(artifact.host),
            hostId: artifact.hostId || null,
            digest: artifact.digest,
            runtimeFingerprint: artifact.runtimeFingerprint
        },
        settings: judgeCohortSettings(config),
        escalation: multiJudgeCohortSettings(escalation)
    };
    if (execution.num_ctx !== config.num_ctx) return null;
    if (escalation?.enabled && [...(escalation.judges || []), ...(escalation.tiebreaker ? [escalation.tiebreaker] : [])]
        .some(judge => !buildJudgeQualificationContract(judge))) return null;
    return qualificationContractFingerprint(contract) ? contract : null;
}

function qualificationContractFingerprint(contract) {
    const artifact = contract?.artifact;
    const settings = contract?.settings;
    if (contract?.schema !== CONTRACT_SCHEMA || !artifact?.model || !artifact?.host
        || !Object.hasOwn(artifact, 'hostId')
        || !artifact.digest || !artifact.runtimeFingerprint || !settings
        || SETTING_KEYS.some(key => !Object.hasOwn(settings, key))
        || !Object.hasOwn(contract, 'escalation')
        || !Number.isSafeInteger(settings.numCtx) || settings.numCtx < 512
        || !Number.isSafeInteger(settings.numPredict) || settings.numPredict < 1
        || !Number.isSafeInteger(settings.timeoutMs) || settings.timeoutMs < 1
        || !Number.isFinite(settings.temperature)
        || !(settings.seed === null || Number.isSafeInteger(settings.seed))
        || !Number.isSafeInteger(settings.maxRetries) || settings.maxRetries < 0
        || !Number.isSafeInteger(settings.votingCount) || settings.votingCount < 1
        || typeof settings.think !== 'boolean'
        || !completeEscalation(contract.escalation)) return null;
    return fingerprint(contract);
}

function completeEscalation(policy) {
    if (policy === null) return true;
    if (!policy || !Array.isArray(policy.judges) || policy.judges.length < 2
        || !Object.hasOwn(policy, 'tiebreaker')
        || !Number.isFinite(policy.escalationBudgetPercent) || !Number.isFinite(policy.confidenceThreshold)
        || !Number.isFinite(policy.autoMinLevel)
        || ['escalateOnJudgeFailure', 'escalateOnReview', 'escalateOnLowConfidence', 'escalateOnHighLevel']
            .some(key => typeof policy[key] !== 'boolean')) return false;
    return [...policy.judges, ...(policy.tiebreaker ? [policy.tiebreaker] : [])].every(judge => {
        const artifact = judge?.contract?.artifact;
        return artifact && exactModelNamesMatch(judge.model, artifact.model)
            && normalizeHostUrl(judge.host) === normalizeHostUrl(artifact.host)
            && judge.contract.num_ctx === judge.settings?.numCtx
            && qualificationContractFingerprint({ schema: CONTRACT_SCHEMA,
                artifact: { model: normalizeModelTag(artifact.model).toLowerCase(), host: normalizeHostUrl(artifact.host),
                    hostId: artifact.hostId || null, digest: artifact.digest, runtimeFingerprint: artifact.runtimeFingerprint },
                settings: judge.settings, escalation: null });
    });
}

function resultJudgeTargets(result = {}) {
    const primary = { host: result.judge_host, model: result.judge_model,
        qualification_contract: result.judge_qualification_contract || null };
    const participants = (result.judge_scores || []).map(score => ({
        host: score.judge_host, model: score.judge_model,
        qualification_contract: score.qualification_contract || null
    }));
    // Legacy consensus without participant evidence cannot imply qualification.
    if ((result.judge_escalated || result.judge_tiebreaker_used || result.judge_consensus)
        && !participants.length) participants.push({ host: null, model: null, qualification_contract: null });
    return [primary, ...participants];
}

module.exports = { CONTRACT_SCHEMA, buildJudgeQualificationContract,
    qualificationContractFingerprint, resultJudgeTargets };
