'use strict';

/**
 * Structured refusal when a benchmark claim or session hold owns the routed
 * host before dispatch. Extracted verbatim from inferenceService.js; the
 * caller passes the result to its rejectRoute.
 */

const { resolveHostKey } = require('../modelRouter');
const { REJECTION_REASONS, ROUTE_OUTCOME_CODES, ROUTE_OUTCOME_STAGES } = require('./routeDecision');

/** Sets Retry-After on `headers` and returns the rejectRoute evidence. */
function buildClaimAdmissionRejection(err, { headers, target, routedHostKey, model, laneName }) {
    const benchmarkClaim = err?.code === 'BENCHMARK_CLAIM_ACTIVE';
    if (Number.isFinite(err.retryAfterMs)) headers['Retry-After'] = String(Math.max(1, Math.ceil(err.retryAfterMs / 1000)));
    return {
        status: err.statusCode || 503,
        outcomeStage: ROUTE_OUTCOME_STAGES.ADMISSION,
        outcomeCode: benchmarkClaim
            ? ROUTE_OUTCOME_CODES.BENCHMARK_CLAIMED
            : ROUTE_OUTCOME_CODES.PRE_DISPATCH_ERROR,
        outcomeReasonCode: err.code || 'BENCHMARK_CLAIM_ACTIVE',
        rejections: benchmarkClaim ? [{
            model,
            host: routedHostKey || resolveHostKey(target),
            hostUrl: target,
            reason: REJECTION_REASONS.BENCHMARK_CLAIMED,
        }] : [],
        payload: {
            status: 'error',
            code: err.code || 'BENCHMARK_CLAIM_ACTIVE',
            message: err.message,
            data: {
                host: err.hostUrl || target,
                batchId: err.batchId || null,
                lane: laneName,
                ...(Number.isFinite(err.retryAfterMs) && {
                    retryAfterMs: Math.max(0, err.retryAfterMs),
                    holdExpiresAt: err.holdExpiresAt || null,
                    holdModel: err.holdModel || null
                })
            }
        },
    };
}

module.exports = { buildClaimAdmissionRejection };
