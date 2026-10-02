'use strict';

/**
 * Initial routing trace for one generate request: what the caller asked for
 * and which lane policy applies. Later stages fill configured, recommendation,
 * selected, artifactResolution, ollama and difference. Extracted verbatim from
 * inferenceService.js.
 */

function createGenerateRoutingTrace({
    requestedModel, taskType, safeRequestedHost, body, laneName, lane, crossModelFallbackOptIn, routeManaged,
}) {
    return {
        version: 1,
        request: {
            requestedModel: requestedModel || null,
            taskType: taskType || null,
            hostOverride: safeRequestedHost,
            callerDetail: body.callerDetail || null,
            lane: laneName,
            laneRoutesTasks: lane.route === true,
            crossModelFallbackOptIn,
            routeManaged,
            summary: null
        },
        lane: {
            name: laneName,
            route: lane.route === true,
            admit: lane.admit !== false,
            recordInferenceSync: lane.recordInferenceSync === true,
            alert: lane.alert
        },
        configured: null,
        recommendation: null,
        selected: null,
        artifactResolution: null,
        ollama: null,
        difference: null
    };
}

module.exports = { createGenerateRoutingTrace };
