'use strict';

const { getBenchmarkClaimIdentity, getWorkloadAdmissionIdentity } = require('../../clients/coreApiClient');
const { enterInference } = require('../benchmark/workloadYield');

function judgeWorkloadId(config = {}) {
    return config.cancelSignal?.workloadId || config.signal?.workloadId || config.batch_id;
}

// All judge implementations use the same managed-workload identity. A batch
// also owns a host claim; standalone calibration only owns its workload.
function judgeRequestIdentity(config = {}) {
    const workloadId = judgeWorkloadId(config);
    return {
        ...(getWorkloadAdmissionIdentity(workloadId) || {}),
        ...(getBenchmarkClaimIdentity(config.host, workloadId) || {})
    };
}

/**
 * Pass the workload's yield point (#62) before a judge call; release the
 * returned handle once the call settles. Call it before the call's timeout
 * starts, so time given to a household turn is not counted against it.
 */
function enterJudgeInference(config = {}) {
    return enterInference(judgeWorkloadId(config), { signal: config.cancelSignal || config.signal || null });
}

module.exports = { judgeRequestIdentity, enterJudgeInference };
