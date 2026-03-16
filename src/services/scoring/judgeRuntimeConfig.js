'use strict';

const { resolveModelNumCtxDetails } = require('../../utils');

function normalizeJudgeNumCtx(value, fallback = null) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(512, Math.min(131072, Math.round(parsed)));
}

async function resolveEffectiveJudgeContext(judgeConfig = {}, opts = {}) {
    const fallbackNumCtx = normalizeJudgeNumCtx(
        opts.fallbackNumCtx,
        normalizeJudgeNumCtx(judgeConfig.num_ctx, 8192)
    );
    const explicitNumCtx = normalizeJudgeNumCtx(judgeConfig.num_ctx);
    const resolved = await resolveModelNumCtxDetails(judgeConfig.model, {
        targetHost: judgeConfig.host,
        fallback: fallbackNumCtx
    });

    const effectiveNumCtx = explicitNumCtx || resolved.num_ctx || fallbackNumCtx;

    return {
        num_ctx: effectiveNumCtx,
        source: explicitNumCtx ? 'explicit_override' : resolved.source,
        requested_num_ctx: explicitNumCtx,
        resolved_num_ctx: resolved.num_ctx,
        resolved_source: resolved.source,
        override_exceeds_resolved: !!(explicitNumCtx && resolved.num_ctx && explicitNumCtx > resolved.num_ctx)
    };
}

module.exports = {
    normalizeJudgeNumCtx,
    resolveEffectiveJudgeContext
};
