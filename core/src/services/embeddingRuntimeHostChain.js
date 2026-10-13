'use strict';

const { embeddingHostCandidates, isEmbedHostLive, isModelMissingResponse } = require('./embeddingHostChain');
const { refusedBeforeDispatch } = require('./routing/taskFallbackLadder');

// Native embedding clients use the same configured placement as the RAG proxy.
// Each attempt retains the native executor's admission and completion receipt.
function wrap(execute, deps) {
    return async (request, options = {}) => {
        if (request?.mode !== 'embed' || !process.env.AGENTX_EMBEDDING_HOST_CHAIN?.trim()
            || options.hostUrl || options.benchmarkClaims || options.codingCapacity
            || request.exclusiveHost) return execute(request, options);

        const candidates = embeddingHostCandidates(deps.getTargetForModel(request.model));
        let lastError;
        let lastResult;
        let reason = null;
        for (const [index, hostUrl] of candidates.entries()) {
            options.signal?.throwIfAborted();
            if (!await isEmbedHostLive(hostUrl)) {
                reason = 'embedding_host_unreachable';
                continue;
            }
            const degraded = index > 0 ? {
                degraded: true,
                fallbackFrom: { model: request.model, host: deps.resolveHostKey(candidates[0]) },
                fallbackTo: { model: request.model, host: deps.resolveHostKey(hostUrl) },
                reason
            } : undefined;
            try {
                const result = await execute(request, { ...options, hostUrl, ...(degraded && { degraded }) });
                if (!isModelMissingResponse(result)) return result;
                lastResult = result;
                reason = 'embedding_model_missing';
            } catch (error) {
                // An uncertain dispatch or failed completion stays with its native
                // owner. Only an attested refusal before dispatch may move hosts.
                if (options.signal?.aborted || !refusedBeforeDispatch(error)) throw error;
                lastError = error;
                reason = error.code || 'embedding_admission_refused';
            }
        }
        if (lastError) throw lastError;
        if (lastResult) return lastResult;
        const error = new Error('No configured embedding host is available.');
        error.code = 'EMBEDDING_HOST_CHAIN_EXHAUSTED';
        error.statusCode = 503;
        throw error;
    };
}

module.exports = { wrap };
