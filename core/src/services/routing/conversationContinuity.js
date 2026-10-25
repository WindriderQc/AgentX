'use strict';

const { localUrl } = require('../images/config');
const { hostUrlKey } = require('../../../../shared/ollamaHostConfig');
const { resolvePrincipalAlias, PRINCIPAL_MODEL_ALIAS } = require('./principalAlias');
const { reducedRequest, decorate, statusResult } = require('./conversationContinuityContext');
const { reasonOf, primaryHosts, describe, readQueue, boundedRead } = require('./conversationContinuityStatus');

const ENV = 'AGENTX_CONVERSATION_CONTINUITY_JSON';
const SAFE_REFUSALS = new Set(['PRINCIPAL_MODEL_UNAVAILABLE', 'BENCHMARK_CLAIM_ACTIVE',
  'HOST_SESSION_HOLD_BUSY', 'RUNTIME_INFERENCE_ADMISSION_DENIED', 'RUNTIME_INFERENCE_RECOVERY_REQUIRED',
  'INFERENCE_CONTEXT_POLICY_UNAVAILABLE']);

function parse(raw) {
  if (!raw?.trim()) return null;
  const value = JSON.parse(raw);
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || Object.keys(value).some(key => !['hosts', 'models', 'maxOutputTokens', 'maxInputChars'].includes(key))) throw new Error('Invalid continuity policy');
  if (!Array.isArray(value.hosts) || !value.hosts.length || value.hosts.length > 4
    || value.hosts.some(host => !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(host))) throw new Error('Continuity needs registered host keys');
  const models = value.models || [PRINCIPAL_MODEL_ALIAS];
  if (!Array.isArray(models) || !models.length || models.length > 8 || models.some(model => typeof model !== 'string'
    || !model.trim() || model.length > 200 || /^(?:openrouter[/:]|openclaw:|https?:)/i.test(model))) throw new Error('Invalid local conversation models');
  const maxOutputTokens = value.maxOutputTokens ?? 384;
  const maxInputChars = value.maxInputChars ?? 12000;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 128 || maxOutputTokens > 1024
    || !Number.isInteger(maxInputChars) || maxInputChars < 2048 || maxInputChars > 24000) throw new Error('Invalid continuity context limits');
  return { hosts: [...new Set(value.hosts)], models, maxOutputTokens, maxInputChars };
}

function safeRefusal(error) {
  return SAFE_REFUSALS.has(error?.code) || error?.ollamaRequestNotSent === true || error?.cause?.ollamaRequestNotSent === true;
}

function requireResult(result) {
  if (!result || typeof result.ok !== 'boolean') throw Object.assign(new Error('Native inference result is unverified'),
    { code: 'INFERENCE_UPSTREAM_UNAVAILABLE', statusCode: 502 });
  return result;
}

function createConversationContinuity({ execute, readSnapshot, deps, validate, readWork = readQueue,
  readPolicy = () => process.env[ENV], log = require('../../../config/logger') }) {
  return async (request, options = {}) => {
    let policy;
    try { policy = parse(readPolicy()); } catch {
      log.warn('Conversation continuity policy is invalid; strict routing retained'); return null;
    }
    if (!policy || !policy.models.includes(request.model) || !['chat', 'generate'].includes(request.mode)
      || options.benchmarkClaims || options.codingCapacity || options.reportAuthority) return null;
    const signal = options.signal;
    signal?.throwIfAborted();
    validate?.(request);
    let snapshot;
    try { snapshot = await boundedRead(() => readSnapshot({ includeCatalog: false,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000) }), 3000, signal);
      if (!snapshot) throw new Error('routing read unavailable'); }
    catch (error) {
      if (signal?.aborted) throw error;
      return statusResult(request, 'Core ne peut pas vérifier l’état du routage pour le moment.', 'routing_unavailable');
    }
    let target = options.primaryTarget || null;
    let failure;
    try {
      target = resolvePrincipalAlias(snapshot, request.model) || target;
      if (!target) {
        const entry = Object.values(snapshot.tasks || {}).find(row => row.model === request.model && row.hostUrl && row.pinAligned);
        if (!entry) return null; // explicit models keep the existing effective-model gate
        target = { ...entry, numCtx: entry.contextSize, exclusiveHost: false };
      }
      try { localUrl(target.hostUrl); } catch {
        throw Object.assign(new Error('Conversation continuity requires local/LAN inference'), { code: 'INFERENCE_HOST_INVALID', statusCode: 409 });
      }
      const primary = await execute({ ...request, model: target.model, exclusiveHost: false,
        options: { ...request.options, ...(target.numCtx && { num_ctx: target.numCtx }) } }, {
        signal, consumerContract: options.consumerContract, hostUrl: target.hostUrl,
        ...(target.topology && { topology: target.topology }), retry: { enabled: false },
        conversationContinuity: { state: 'primary', reason: null, limited: false, contextReduced: false }
      });
      return requireResult(primary);
    } catch (error) {
      if (signal?.aborted || !safeRefusal(error)) throw error;
      failure = error;
    }
    const reason = reasonOf(failure);
    const work = await boundedRead(readWork, 1500, signal).catch(() => null);
    signal?.throwIfAborted();
    const principalEndpoints = primaryHosts(snapshot, target);
    const status = describe(failure, principalEndpoints, work);
    const visited = new Set(principalEndpoints.map(hostUrlKey));
    for (const hostKey of policy.hosts) {
      signal?.throwIfAborted();
      const url = snapshot.hosts?.[hostKey];
      let hostUrl;
      try { hostUrl = localUrl(url); if (new URL(hostUrl).pathname !== '/') continue; } catch { continue; }
      const key = hostUrlKey(hostUrl);
      if (visited.has(key)) continue;
      visited.add(key);
      // The pin, current residency, native admission and context all have to
      // agree. Never load a new model or borrow an unregistered/cloud endpoint.
      let pref, pin;
      try {
        pref = await boundedRead(() => deps.hostPreferenceService.getByHost(hostUrl), 1500, signal);
        pin = pref?.pinnedModels?.[0];
        if (!pin?.model || !(pin.contextSize > 0)) continue;
        await deps.assertHostAvailableForConsumer(hostUrl, { model: pin.model,
          callerDetail: 'conversation-continuity', path: 'conversation-continuity' });
        const probe = await deps.fetch(`${hostUrl}/api/ps`, { signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(1500)]) : AbortSignal.timeout(1500) });
        if (!probe.ok) continue;
        const resident = (await probe.json()).models?.find(row => deps.modelsMatch(row.name || row.model, pin.model));
        if (!resident || Number(resident.context_length) !== Number(pin.contextSize)) continue;
      } catch { if (signal?.aborted) signal.throwIfAborted(); continue; }
      const notice = `🪶 Nestor en mode de secours local, avec un contexte récent réduit et sans outils d’action. ${status}`;
      const reduced = reducedRequest(request, { ...policy, model: pin.model, contextSize: Number(pin.contextSize), notice, status });
      if (!reduced) return statusResult(request, status, 'backup_context_unavailable');
      const continuity = { state: 'backup', reason, limited: true, contextReduced: true };
      const routing = { degraded: true, reason, fallbackFrom: { model: target?.model || null, host: target?.hostKey || null },
        fallbackTo: { model: pin.model, host: hostKey } };
      try {
        const result = await execute(reduced, { signal, consumerContract: options.consumerContract, hostUrl,
          degraded: routing, conversationContinuity: { ...continuity,
            lane: { role: 'conversation', mode: 'continuity', group: null, laneContext: Number(pin.contextSize) } },
          retry: { enabled: false } });
        return decorate(requireResult(result), { notice, continuity });
      } catch (error) {
        if (signal?.aborted || (!safeRefusal(error) && error.code !== 'LANE_CONTEXT_EXCEEDED')) throw error;
      }
    }
    return statusResult(request, status, reason);
  };
}

module.exports = { ENV, parse, safeRefusal, createConversationContinuity };
