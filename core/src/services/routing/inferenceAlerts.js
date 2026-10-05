'use strict';

/**
 * Fire-and-forget alert evaluation for one generate attempt. Extracted
 * verbatim from inferenceService.js; neither function ever blocks or fails
 * the inference response.
 */

const { resolveHostKey } = require('../modelRouter');
const alertService = require('../alertService');
const { hostResidency } = require('../../helpers/hostResidency');

/** Latency, recovery and upstream-error alerts after Ollama answered. */
function evaluateResponseAlerts({ lane, response, startedAt, routedHostKey, target, model, body, taskType, laneName }) {
    // Fire-and-forget alert evaluation. Lane policy:
    //   - 'error-only': skip latency alerts; keep error alerts
    //   - true: full alerts
    //   - false: would skip entirely (no lane uses this today)
    if (lane.alert) {
        try {
            const alertSvc = alertService;
            if (alertSvc) {
                const durationMs = Date.now() - startedAt;
                const alertComponent = routedHostKey || resolveHostKey(target) || 'inference';
                if (response.ok) {
                    alertSvc.resolveRecoveredInferenceAlerts?.({
                        host: target,
                        hostKey: alertComponent,
                        model,
                        latencyMs: durationMs
                    }).catch(() => {});
                }
                // A CPU-resident host is slow by design: its latency is not an incident.
                if (response.ok && durationMs > 10000 && lane.alert !== 'error-only' && hostResidency(target) !== 'cpu') {
                    alertSvc.evaluateEvent({
                        component: alertComponent, metric: 'latency',
                        value: durationMs, threshold: 10000, trend: 'spike',
                        source: 'inference-proxy',
                        additionalData: { model, host: target, caller: body.callerDetail, taskType: taskType || null, lane: laneName }
                    }).catch(() => {});
                }
                if (!response.ok) {
                    alertSvc.evaluateEvent({
                        component: alertComponent, metric: 'error',
                        value: 1, source: 'inference-proxy',
                        additionalData: { model, host: target, status: response.status, taskType: taskType || null, lane: laneName }
                    }).catch(() => {});
                }
            }
        } catch { /* never block inference response */ }
    }
}

/** Timeout or host-unreachable alert after the attempt failed in transport. */
function evaluateTransportFailureAlert({ lane, isTimeout, err, routedHostKey, target, model, taskType, laneName }) {
    // Fire-and-forget alert evaluation for host unreachable.
    // 'error-only' direct lane still emits these; 'false' (no lane today) would skip.
    if (lane.alert) {
        try {
            const alertSvc = alertService;
            if (alertSvc) {
                alertSvc.evaluateEvent({
                    component: routedHostKey || resolveHostKey(target) || 'inference',
                    metric: isTimeout ? 'fetch_timeout' : 'host_unreachable',
                    value: 1, source: 'inference-proxy',
                    additionalData: { model, host: target, error: err.message, taskType: taskType || null, lane: laneName }
                }).catch(() => {});
            }
        } catch { /* never block */ }
    }
}

module.exports = { evaluateResponseAlerts, evaluateTransportFailureAlert };
