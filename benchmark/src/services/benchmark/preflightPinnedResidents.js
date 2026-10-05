'use strict';

/**
 * Pre-flight notices about the pinned models a batch affects. Informational:
 * they never block a launch.
 *
 * - An execution host's pinned models that the batch does not test are
 *   unloaded during the batch and restored after it.
 * - A separate judge host keeps its pinned models loaded, but while the batch
 *   holds that host Core refuses their ordinary calls (#396). Embeddings move
 *   to a registered CPU host that holds the model; household and conversation
 *   turns ask the batch to yield and wait for it; other callers are refused.
 */

const logger = require('../../../config/logger');
const { getDedicationStatuses } = require('../../clients/coreApiClient');
const { normalizeModelName } = require('./modelMetadata');

const trimHost = (host) => String(host || '').replace(/\/+$/, '');

function pinnedModelsOf(status) {
    return (status?.pinnedModels || [])
        .map(pin => normalizeModelName(pin?.model || pin?.name || pin?.modelName || pin))
        .filter(Boolean);
}

/**
 * @param {Array<{host, model}>} targets - execution targets
 * @param {{ judgeHost?: string }} [options] - the judge's Ollama host, when it is one
 * @returns {Promise<{ ok: true, affectedHosts: object[], judgeHost: object|null, warnings: string[] }>}
 */
async function checkPinnedResidents(targets, { judgeHost = null } = {}) {
    const affectedHosts = [];
    const warnings = [];
    let judge = null;

    try {
        const statuses = await getDedicationStatuses();
        const statusFor = (hostUrl) => statuses.find(s => trimHost(s.host) === hostUrl);
        const execHosts = [...new Set(targets.map(t => trimHost(t.host)))];

        for (const hostUrl of execHosts) {
            const match = statusFor(hostUrl);
            const pinnedModels = pinnedModelsOf(match);
            if (!pinnedModels.length) continue;

            const batchModels = targets.filter(t => trimHost(t.host) === hostUrl).map(t => t.model);
            const nonPinned = batchModels.filter(m => !pinnedModels.some(p => normalizeModelName(p) === normalizeModelName(m)));

            if (nonPinned.length > 0) {
                affectedHosts.push({
                    host: hostUrl,
                    pinnedModels,
                    nonPinnedBatchModels: nonPinned,
                    state: match.state
                });
                warnings.push(
                    `Host ${hostUrl} has pinned model(s): ${pinnedModels.join(', ')}. ` +
                    `Pinned models will be temporarily unloaded during the batch and automatically restored after completion.`
                );
            }
        }

        const judgeUrl = trimHost(judgeHost);
        const judgePinned = judgeUrl && !execHosts.includes(judgeUrl) ? pinnedModelsOf(statusFor(judgeUrl)) : [];
        if (judgePinned.length) {
            judge = { host: judgeUrl, pinnedModels: judgePinned };
            warnings.push(
                `Judge host ${judgeUrl} serves pinned model(s): ${judgePinned.join(', ')}. They stay loaded, but while ` +
                'the batch holds this host Core refuses their ordinary calls: embeddings move to a registered CPU host ' +
                'that holds the model, household and conversation turns ask the batch to yield and wait, other callers are refused.'
            );
        }
    } catch (err) {
        logger.debug('Dedication check skipped — core unreachable', { error: err.message });
    }

    return { ok: true, affectedHosts, judgeHost: judge, warnings };
}

module.exports = { checkPinnedResidents };
