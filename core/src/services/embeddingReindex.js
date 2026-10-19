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

const { isEmbeddingModelName } = require('../../../shared/embeddingModels');

const IN_PROGRESS = ['copying', 'finalizing'];
const OPEN_STATES = ['requested', 'reserved', 'dispatching', 'running', 'uncertain'];
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const REQUEST_KEY_PATTERN = /^[a-f0-9-]{36}$/;
const DEFAULT_MINUTES = 60;

function fail(message, statusCode, code, details) {
  return Object.assign(new Error(message), { statusCode, code, ...(details && { details }) });
}
const OUTCOMES = { activated: 'completed', failed: 'failed', cancelled: 'cancelled' };

async function rag(method, path, body) {
  const answer = await requestJson({ baseUrl: getRagServiceBaseUrl(), path, method, body, timeoutMs: 15000, serviceName: 'rag' });
  return answer?.data ?? answer;
}

/** The endpoints whose embedding window the build occupies. */
function reindexHosts(model) {
  const target = getTargetForModel(model);
  if (!target) throw fail(`No Ollama host is configured for ${model}`, 409, 'EMBEDDING_HOST_UNAVAILABLE');
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

async function queueJobs() {
  const queue = require('./heavyWorkQueueService');
  return ((await queue.list())?.jobs || []).filter(job => job.kind === 'embedding-reindex');
}

/** What the Nerve Center shows: the serving profile, the latest build and the latest request. */
async function status() {
  const { profile, build } = await readProfile();
  const jobs = await queueJobs();
  const request = jobs.find(job => OPEN_STATES.includes(job.state))
    || jobs.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0] || null;
  return { profile, build, request };
}

/**
 * Queue a full rebuild for another model and reserve its slot with the
 * owner's automatic start. Nothing is embedded now. `requestKey` comes from
 * the page: the same key replays the same request after a lost answer.
 */
async function requestChange({ model, dimension, expectedModel, start, priority = 5, estimatedMinutes = DEFAULT_MINUTES, requestKey }, actor) {
  const queue = require('./heavyWorkQueueService');
  if (!REQUEST_KEY_PATTERN.test(String(requestKey || ''))) throw fail('requestKey must be a UUID made for this change', 400, 'EMBEDDING_CHANGE_INVALID');
  if (!MODEL_PATTERN.test(String(model || '')) || !isEmbeddingModelName(model)) throw fail('Choose an embedding model', 400, 'EMBEDDING_CHANGE_INVALID');
  if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > 8192) throw fail('dimension must be 1 to 8192', 400, 'EMBEDDING_CHANGE_INVALID');
  const { profile } = await readProfile();
  if (expectedModel !== profile.active.model) throw fail(`RAG now serves ${profile.active.model}; review the change again`, 409, 'EMBEDDING_PROFILE_CHANGED');
  if (model === profile.active.model && dimension === profile.active.dimension) throw fail(`RAG already serves ${model}`, 409, 'EMBEDDING_MODEL_UNCHANGED');
  const key = `embedding-reindex:${requestKey}`;
  const pending = (await queueJobs()).find(job => OPEN_STATES.includes(job.state) && job.key !== key);
  if (pending) throw fail('An embedding reindex is already queued', 409, 'EMBEDDING_REINDEX_PENDING', { requestId: pending.id });

  const job = await queue.submit({
    key, title: `Rebuild RAG embeddings with ${model}`, kind: 'embedding-reindex',
    hosts: reindexHosts(model), estimatedMinutes, source: { type: 'operator', ref: 'nerve-center:embeddings' },
    executor: { model, dimension }
  }, actor);
  if (job.state !== 'requested') return job;
  return queue.reserve(job.id, { expectedRevision: job.revision, start, priority, autoStart: true }, actor);
}

/** Before its launch the request is cancelled; during the copy RAG stops the build. */
async function cancelChange(id, { expectedRevision }, actor) {
  const queue = require('./heavyWorkQueueService');
  const job = await queue.get(id);
  if (job.kind !== 'embedding-reindex') throw fail('Not an embedding reindex request', 404, 'EMBEDDING_REINDEX_NOT_FOUND');
  if (['requested', 'reserved'].includes(job.state)) return queue.cancel(id, { expectedRevision }, actor);
  if (['dispatching', 'running', 'uncertain'].includes(job.state)) {
    const build = await stopBuild(id);
    return { ...job, build };
  }
  return job;
}

/** Delete the collection the last switch replaced, as the page named it. */
async function retirePrevious({ collection, expectedRevision }) {
  if (typeof collection !== 'string' || !collection || !Number.isInteger(expectedRevision)) {
    throw fail('Name the previous collection and the profile revision you saw', 400, 'EMBEDDING_RETIRE_INVALID');
  }
  return rag('POST', '/api/rag/embedding-profile/previous/retire', { collection, expectedRevision });
}

module.exports = { retirePrevious, reindexHosts, readProfile, readBuild, startBuild, stopBuild, buildOutcome, status, requestChange, cancelChange, IN_PROGRESS };
