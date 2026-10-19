'use strict';

/**
 * Core's side of an embedding model change for RAG documents.
 *
 * RAG owns the collections and builds; Core owns when the build runs. A change
 * is a heavy-work request of kind `embedding-reindex` whose launch asks RAG to
 * build a new collection with the request id as build id. The queue observer
 * reads that build until RAG reports it activated, failed or cancelled.
 */

const { requestJson } = require('../helpers/crossServiceClient');
const { getRagServiceBaseUrl } = require('./ragServiceClient');
const { getTargetForModel } = require('./modelRouter');
const { embeddingHostCandidates } = require('./embeddingHostChain');

const IN_PROGRESS = ['copying', 'finalizing'];
const OUTCOMES = { activated: 'completed', failed: 'failed', cancelled: 'cancelled' };

async function rag(method, path, body) {
  const answer = await requestJson({ baseUrl: getRagServiceBaseUrl(), path, method, body, timeoutMs: 15000, serviceName: 'rag' });
  return answer?.data ?? answer;
}

/** The endpoints whose embedding window the build occupies. */
function reindexHosts(model) {
  const target = getTargetForModel(model);
  const chain = process.env.AGENTX_EMBEDDING_HOST_CHAIN;
  return chain && chain.trim() ? embeddingHostCandidates(target) : [target];
}

const readProfile = () => rag('GET', '/api/rag/embedding-profile');
const readBuild = id => rag('GET', `/api/rag/embedding-builds/${encodeURIComponent(id)}`);
const stopBuild = id => rag('POST', `/api/rag/embedding-builds/${encodeURIComponent(id)}/cancel`);
const startBuild = job => rag('POST', '/api/rag/embedding-builds', { buildId: job.id, model: job.executor.model, dimension: job.executor.dimension });

/** The queue's terminal receipt for a build, or null while it still runs. */
function buildOutcome(build) {
  if (IN_PROGRESS.includes(build?.status)) return null;
  const state = OUTCOMES[build?.status];
  if (!state) return undefined;
  return {
    state, authority: 'rag.embedding-build', operationId: build.id,
    model: build.model, dimension: build.dimension, collection: build.targetCollection,
    previousCollection: build.sourceCollection, error: build.error || null, progress: build.progress || null
  };
}

module.exports = { reindexHosts, readProfile, readBuild, startBuild, stopBuild, buildOutcome, IN_PROGRESS };
