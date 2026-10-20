'use strict';

const logger = require('../../../config/logger');
const { resolveJudgeHost } = require('./judgeHostResolution');
const { normalizeModelName } = require('./modelMetadata');

const trimHost = host => String(host || '').trim().replace(/\/+$/, '');
const modelKey = name => normalizeModelName(String(name || '')).toLowerCase();

function judgeModelOf(judgeConfig = {}) {
    return judgeConfig.target?.model || judgeConfig.model || require('../qualityScorer').JUDGE_CONFIG.model;
}

/**
 * A separate judge host is shared (#396) only when nothing new loads there:
 * it has no pin, or its pin is the judge. A judge that is not the pin replaces
 * it for the batch under the host claim, whose release restores the pin (#901).
 * Without the host's pins (Core unreachable) the host is reserved.
 */
function judgeSharesHost(hostPins, host, judgeModel) {
    if (!(hostPins instanceof Map)) return false;
    const pins = hostPins.get(trimHost(host)) || [];
    return pins.length === 0 || pins.some(pin => modelKey(pin) === modelKey(judgeModel));
}

// A batch's admission intent is immutable. Creation, execution and resume
// include its judge from the start, even when only some targets remain pending.
function batchAdmissionScope(targets, judgeConfig = {}, { hostPins = null } = {}) {
    const hosts = (targets || []).map(target => target.host).filter(Boolean);
    const externalJudge = judgeConfig.target?.executionKind
        && judgeConfig.target.executionKind !== 'ollama';
    const judgeHosts = externalJudge ? [] : (hosts.length ? hosts : [''])
        .map(host => resolveJudgeHost(host, judgeConfig).judgeHost).filter(Boolean);
    const judgeModel = externalJudge ? null : judgeModelOf(judgeConfig);
    return {
        hosts: [...new Set([...hosts, ...judgeHosts])],
        sharedHosts: [...new Set(judgeHosts.filter(host => !hosts.includes(host)
            && judgeSharesHost(hostPins, host, judgeModel)))],
        kind: externalJudge || (targets || []).some(target => target.executionKind !== 'ollama')
            ? 'benchmark-cloud' : 'benchmark'
    };
}

/** Pinned model names by host, from Core's host preferences; null when unknown. */
async function loadHostPins({ getDedicationStatuses = require('../../clients/coreApiClient').getDedicationStatuses } = {}) {
    try {
        const statuses = await getDedicationStatuses();
        return new Map((statuses || []).map(status => [trimHost(status.host || status.hostUrl),
            (status.pinnedModels || []).map(pin => pin?.model || pin?.name || pin).filter(Boolean)]));
    } catch (error) {
        logger.warn('Host pins unavailable; a separate judge host is reserved', { error: error.message });
        return null;
    }
}

/** The admission scope, reading the pins only when the batch has a separate judge host. */
async function resolveBatchAdmissionScope(targets, judgeConfig = {}, deps = {}) {
    const scope = batchAdmissionScope(targets, judgeConfig);
    const separate = scope.hosts.filter(host => !(targets || []).some(target => target.host === host));
    if (separate.length === 0) return scope;
    return batchAdmissionScope(targets, judgeConfig, { hostPins: await loadHostPins(deps) });
}

module.exports = { batchAdmissionScope, resolveBatchAdmissionScope, judgeSharesHost, loadHostPins, judgeModelOf };
