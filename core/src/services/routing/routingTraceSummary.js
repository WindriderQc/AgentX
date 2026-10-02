'use strict';

// Payload-free summaries for the inference proxy's routing trace.
const { normalizeHostUrl } = require('../../helpers/ollamaHostConfig');
const { fingerprintRuntimeOptions } = require('./routeDecision');
const { publicDegradedMarker } = require('./taskFallbackLadder');

function buildMessageShape(messages) {
    if (!Array.isArray(messages)) return [];
    return messages.slice(-6).map((message, index) => {
        const content = typeof message?.content === 'string' ? message.content : '';
        const role = ['system', 'user', 'assistant', 'tool'].includes(message?.role)
            ? message.role
            : 'other';
        return {
            index: Math.max(0, messages.length - 6) + index,
            role,
            chars: content.length,
        };
    });
}

function buildRequestSummary({ prompt, messages, system, options, stream, think, keepAlive }) {
    return {
        mode: Array.isArray(messages) ? 'chat' : 'generate',
        promptChars: typeof prompt === 'string' ? prompt.length : 0,
        systemChars: typeof system === 'string' ? system.length : 0,
        messageCount: Array.isArray(messages) ? messages.length : 0,
        messageShape: buildMessageShape(messages),
        optionsFingerprint: fingerprintRuntimeOptions(options),
        stream: stream === true,
        thinkConfigured: think !== undefined,
        keepAliveConfigured: keepAlive !== undefined,
    };
}

function summarizeRecommendation(recommendation) {
    if (!recommendation) return null;
    const scheduler = recommendation.recommendation || null;
    return {
        model: recommendation.model || null,
        host: recommendation.host || null,
        hostUrl: recommendation.url || null,
        source: recommendation.source || null,
        reason: recommendation.reason || null,
        claimId: recommendation.claimId || null,
        claimExpiresAt: recommendation.claimExpiresAt || null,
        readiness: recommendation.readiness || null,
        degraded: publicDegradedMarker(recommendation.degraded),
        scheduler: scheduler ? {
            host: scheduler.host || null,
            hostUrl: scheduler.hostUrl || null,
            reason: scheduler.reason || null,
            confidence: scheduler.confidence || null,
            warnings: Array.isArray(scheduler.warnings) ? scheduler.warnings : [],
            scored: Array.isArray(scheduler._scored) ? scheduler._scored : []
        } : null
    };
}

function buildRoutingDifference(trace) {
    const reasons = [];
    const recommendation = trace.recommendation;
    const selected = trace.selected || {};
    const requested = trace.request || {};

    if (requested.hostOverride) {
        reasons.push(`Caller supplied host override "${requested.hostOverride}".`);
    }

    if (recommendation?.host && selected.hostKey && recommendation.host !== selected.hostKey) {
        reasons.push(`Selected host ${selected.hostKey} differs from recommended host ${recommendation.host}.`);
    }

    if (recommendation?.hostUrl && selected.hostUrl && normalizeHostUrl(recommendation.hostUrl) !== normalizeHostUrl(selected.hostUrl)) {
        reasons.push(`Selected host URL differs from recommendation.`);
    }

    if (recommendation?.scheduler?.reason) {
        reasons.push(`Scheduler reason: ${recommendation.scheduler.reason}.`);
    } else if (recommendation?.reason) {
        reasons.push(`Router reason: ${recommendation.reason}.`);
    }

    if (reasons.length === 0) {
        reasons.push(recommendation ? 'Actual path matched the router recommendation.' : 'Direct path; no task recommendation was requested.');
    }

    return {
        differsFromRecommendation: !!(
            requested.hostOverride
            || (recommendation?.host && selected.hostKey && recommendation.host !== selected.hostKey)
            || (recommendation?.hostUrl && selected.hostUrl && normalizeHostUrl(recommendation.hostUrl) !== normalizeHostUrl(selected.hostUrl))
        ),
        reasons
    };
}

module.exports = { buildMessageShape, buildRequestSummary, summarizeRecommendation, buildRoutingDifference };
