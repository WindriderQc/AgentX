'use strict';

/**
 * Host chain helpers for Core's embedding proxy (`POST /api/inference/embed`).
 *
 * The proxy tries the routed host, then every other configured host, CPU
 * hosts of the registry included. A host is skipped when its liveness probe
 * fails, when Core refuses admission there, when it does not answer, or when it
 * answers that the model is not installed: a missing model says nothing about
 * the next host, so it must not end the chain.
 */

const fetch = require('node-fetch');
const alertService = require('./alertService');
const { resolveHostKey } = require('./modelRouter');

// Split liveness from the long embed budget: cold loads can be slow, while a
// black-holed host should be skipped after a short probe.
const EMBED_TIMEOUT_MS = Number(process.env.EMBED_TIMEOUT_MS) > 0
    ? Number(process.env.EMBED_TIMEOUT_MS)
    : 60000;
const EMBED_PROBE_TIMEOUT_MS = Number(process.env.EMBED_PROBE_TIMEOUT_MS) > 0
    ? Number(process.env.EMBED_PROBE_TIMEOUT_MS)
    : 3000;
// Liveness is cached so a batch ingest doesn't pay a probe per chunk.
const EMBED_LIVENESS_TTL_MS = 15000;
const embedLiveness = new Map();

async function isEmbedHostLive(hostUrl) {
    const cached = embedLiveness.get(hostUrl);
    if (cached && Date.now() - cached.at < EMBED_LIVENESS_TTL_MS) return cached.ok;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EMBED_PROBE_TIMEOUT_MS);
    let ok = false;
    try {
        const probe = await fetch(`${hostUrl}/api/tags`, { signal: controller.signal });
        ok = probe.ok;
    } catch {
        ok = false;
    } finally {
        clearTimeout(timer);
    }

    embedLiveness.set(hostUrl, { ok, at: Date.now() });
    return ok;
}

function emitEmbedHostFailure(candidate, model, error, code = '') {
    // An admission refusal is Core's own decision: the host answered nothing.
    if (!alertService?.evaluateEvent || String(code).startsWith('RUNTIME_INFERENCE_')) return;
    alertService.evaluateEvent({
        component: resolveHostKey(candidate) || candidate,
        metric: 'host_unreachable',
        value: 1,
        source: 'embedding-proxy',
        additionalData: { model, host: candidate, error }
    }).catch(() => {});
}

/** Ollama answers 404 when the model is not installed on that host. */
function isModelMissingResponse(response) {
    return response?.status === 404;
}

module.exports = {
    EMBED_TIMEOUT_MS,
    isEmbedHostLive,
    emitEmbedHostFailure,
    isModelMissingResponse,
    _resetEmbedLiveness: () => embedLiveness.clear()
};
