'use strict';

const crypto = require('node:crypto');
const { localUrl } = require('./images/config');
const { hostUrlKey } = require('../../../shared/ollamaHostConfig');
const { planId, batchRequest } = require('../../../shared/benchmarkBatchPlan.cjs');
const { islandExecutor, islandEstimatedMinutes } = require('../../../shared/islandRun.cjs');

function fail(message, statusCode = 400, code = 'HEAVY_QUEUE_INVALID', details) {
  return Object.assign(new Error(message), { statusCode, code, details });
}
function text(value, label, max = 240, optional = false) {
  if (optional && value === undefined) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw fail(`${label} needs a nonempty line of at most ${max} characters`);
  }
  return value.trim();
}
function hosts(values) {
  if (!Array.isArray(values) || !values.length || values.length > 16) throw fail('hosts needs 1 to 16 explicit local endpoint URLs');
  try {
    return [...new Set(values.map(value => {
      const url = new URL(localUrl(value));
      if (url.pathname !== '/') throw new Error();
      return hostUrlKey(url.href);
    }))].sort();
  } catch { throw fail('hosts must be local/LAN HTTP(S) origins without credentials, paths or query strings'); }
}
function instant(value, label) {
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw fail(`${label} needs an ISO timestamp with an explicit offset`);
  }
  return new Date(value).toISOString();
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
const digest = value => crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
function only(object, keys, label) {
  if (!object || typeof object !== 'object' || Array.isArray(object) || Object.keys(object).some(key => !keys.includes(key))) {
    throw fail(`${label} contains unsupported fields`);
  }
}
function validateRequest(body) {
  only(body, ['key', 'title', 'kind', 'hosts', 'estimatedMinutes', 'notBefore', 'startBefore', 'source', 'executor', 'withinWindow'], 'request');
  const kind = body.kind;
  if (!['benchmark', 'profiler', 'image', 'embedding-reindex', 'topology', 'diagnostic', 'other', 'transcription'].includes(kind)) throw fail('Unsupported heavy-work kind');
  // A request that needs a topology mode names the window that provides it (#360).
  if (body.withinWindow !== undefined) {
    if (kind === 'topology') throw fail('A topology request cannot sit inside another window');
    if (!/^[a-f0-9-]{36}$/.test(body.withinWindow || '')) throw fail('withinWindow needs a queue request id');
  }
  const minutes = body.estimatedMinutes;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) throw fail('estimatedMinutes needs 1 to 10080 minutes');
  const source = body.source || { type: 'operator' };
  only(source, ['type', 'ref', 'taskId', 'issueUrl'], 'source');
  if (!['operator', 'coding', 'nestor'].includes(source.type)) throw fail('Unsupported request source');
  const normalizedSource = { type: source.type };
  for (const field of ['ref', 'taskId', 'issueUrl']) if (source[field] !== undefined) normalizedSource[field] = text(source[field], `source.${field}`, 500);
  if (normalizedSource.issueUrl && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/.test(normalizedSource.issueUrl)) throw fail('issueUrl needs a GitHub issue URL');
  let executor = body.executor || null;
  if (executor) {
    if (Buffer.byteLength(JSON.stringify(executor)) > 16000) throw fail('Executor request exceeds 16000 bytes; use existing artifact references');
    if (kind === 'benchmark') {
      only(executor, ['plan', 'prepare', 'request'], 'benchmark executor');
      try {
        if (executor.prepare !== true) planId(executor.plan);
        else if (executor.plan !== undefined) throw new Error('Preparation cannot name an existing plan');
        batchRequest(executor.request, { judgeRequired: true });
      } catch (error) { throw fail(error.message); }
    } else if (kind === 'transcription') {
      only(executor, ['transcriptionId'], 'transcription executor');
      if (!require('./transcriptionContract').UUID.test(executor.transcriptionId || '')) throw fail('Exact transcription identity required');
    } else if (kind === 'profiler') {
      only(executor, ['hostId', 'depth', 'skipRecentDays', 'modelNames'], 'profiler executor');
      if (!/^[a-zA-Z0-9_.:-]{1,100}$/.test(executor.hostId || '')) throw fail('profiler hostId required');
    } else if (kind === 'image') {
      if (executor.mode === 'image-operation') {
        only(executor, ['mode', 'actionKey', 'operationId', 'requestHash'], 'native image executor');
        if (!/^[a-f0-9-]{36}$/.test(executor.operationId || '') || !/^[a-f0-9]{64}$/.test(executor.requestHash || '')) throw fail('Exact native image identity required');
      } else {
        only(executor, ['actionKey', 'prompt', 'profile', 'width', 'height', 'seed', 'parent', 'recipe'], 'image executor');
        if (typeof executor.prompt !== 'string' || !executor.prompt.trim()) throw fail('image prompt required');
      }
      if (!/^[a-zA-Z0-9:_.-]{8,160}$/.test(executor.actionKey || '')) throw fail('image actionKey required');
    } else if (kind === 'embedding-reindex') {
      only(executor, ['model', 'dimension'], 'embedding reindex executor');
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(executor.model || '')) throw fail('embedding reindex model name required');
      if (!Number.isSafeInteger(executor.dimension) || executor.dimension < 1 || executor.dimension > 8192) throw fail('embedding reindex dimension needs 1 to 8192');
    } else if (kind === 'topology') {
      require('./runtimeTopologyWindow').validateExecutor(executor);
    } else if (kind === 'other' && executor.mode === 'pipeline-report') {
      // A report campaign Core starts and settles itself (#878).
      only(executor, ['mode', 'pipelineId'], 'report campaign executor');
      text(executor.pipelineId, 'executor.pipelineId', 160);
    } else if (kind === 'other' && executor.mode === 'island') {
      // A Clawblox island run the operator CLI starts on its configured runner
      // and finishes with an attested receipt (docs/ISLAND.md).
      try { executor = islandExecutor(executor); } catch (error) { throw fail(error.message); }
      if (minutes < islandEstimatedMinutes(executor.minutes)) {
        throw fail(`estimatedMinutes needs at least ${islandEstimatedMinutes(executor.minutes)} for this island run`);
      }
    } else if (['diagnostic', 'other'].includes(kind)) {
      only(executor, ['mode', 'receiptRef'], 'operator executor');
      if (executor.mode !== 'operator') throw fail('Custom work needs the explicit operator receipt protocol');
      text(executor.receiptRef, 'executor.receiptRef', 500);
    } else throw fail('This kind has no supported executor; submit a planning request without executor');
  }
  const request = {
    title: text(body.title, 'title'), kind, hosts: hosts(body.hosts), estimatedMinutes: minutes,
    notBefore: body.notBefore ? instant(body.notBefore, 'notBefore') : null,
    startBefore: body.startBefore ? instant(body.startBefore, 'startBefore') : null,
    source: normalizedSource, executor,
    ...(body.withinWindow ? { withinWindow: body.withinWindow } : {})
  };
  if (request.notBefore && request.startBefore && request.notBefore >= request.startBefore) throw fail('startBefore must follow notBefore');
  return { key: text(body.key, 'key', 160), request, intentHash: digest(request) };
}

module.exports = { fail, text, hosts, instant, digest, validateRequest };
