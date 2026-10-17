'use strict';
/**
 * Council participant calls: readiness, pinned payloads, admitted Ollama calls
 * (plain and streamed), runtime participants and their telemetry. Extracted from
 * orchestrator.js, which keeps the deliberation flow.
 */

const logger = require('../../../config/logger');
const { buildOllamaPayload, buildOllamaStats, extractResponse } = require('../../helpers/ollamaResponseHandler');
const { getTargetForModel, recordInference } = require('../modelRouter');
const hostPreferenceService = require('../hostPreferenceService');
const { getFetchOptions } = require('../../helpers/httpAgent');
const { executeAdmittedOllamaStream } = require('../routing/inferenceStreamExecutor');
const { StringDecoder } = require('string_decoder');
const {
  createOllamaStreamTerminalValidator,
  executeAdmittedOllamaAttempt
} = require('../routing/inferenceAttemptExecutor');
const { DEFAULT_TIMEOUT_MS } = require('./defaults');
const { callRuntimeParticipant } = require('./runtimeParticipantAdapter');

function resolveHostName(target) {
  if (!target) return 'unknown';
  try {
    return new URL(target).hostname;
  } catch {
    return target;
  }
}

async function assessModelParticipantReadiness(agent) {
  const target = getTargetForModel(agent.model);
  if (!target) {
    return { ready: false, target: null, hostName: 'unknown', error: `No host found for model ${agent.model}` };
  }

  const hostName = resolveHostName(target);
  try {
    const preference = await hostPreferenceService.getByHost(target);
    const status = String(preference?.status || '').toLowerCase();
    const claimed = Boolean(preference?.benchmarkClaim?.batchId);
    if (claimed || ['benchmarking', 'restoring', 'swapping', 'offline'].includes(status)) {
      const reason = claimed ? 'reserved for benchmark/judge work' : status;
      return {
        ready: false,
        target,
        hostName,
        error: `${preference?.displayName || hostName} is ${reason}; Council did not start this participant`
      };
    }
  } catch (err) {
    logger.warn('Council host-preference readiness evidence unavailable; continuing with direct probe', {
      model: agent.model,
      target,
      error: err.message
    });
  }
  return { ready: true, target, hostName, error: null };
}

function isSystemicParticipantFailure(result) {
  const error = String(result?.error || '').toLowerCase();
  return Boolean(error) && (
    error.includes('timeout after')
    || error.includes('no host found')
    || error.includes('council did not start this participant')
    || error.includes('econnrefused')
    || error.includes('connection refused')
    || error.includes('fetch failed')
    || error.includes('socket hang up')
    || error.includes('stream ended before')
  );
}

function participantRouteKey(agent) {
  const runtime = String(agent.runtime || 'model').toLowerCase();
  if (runtime !== 'model') return `${runtime}:${agent.runtimeConfig?.sessionKey || agent.agentId}`;
  return `model:${getTargetForModel(agent.model) || 'unrouted'}`;
}

async function buildPinnedAgentPayload(agent, messages, target, streamEnabled = false) {
  let runtimeOptions = {
    options: { num_predict: -1 },
    keepAlive: undefined
  };

  try {
    const pref = await hostPreferenceService.getByHost(target);
    runtimeOptions = hostPreferenceService.resolvePinnedRuntimeOptions(
      pref,
      agent.model,
      runtimeOptions.options
    );
  } catch (err) {
    logger.warn('Roundtable pin options unavailable; using model defaults', {
      model: agent.model,
      target,
      error: err.message
    });
  }

  const options = { ...runtimeOptions.options };
  if (runtimeOptions.keepAlive !== undefined && runtimeOptions.keepAlive !== '') {
    options.keep_alive = runtimeOptions.keepAlive;
  }
  return buildOllamaPayload({ model: agent.model, messages, streamEnabled, options });
}

// ─── telemetry ────────────────────────────────────────────────────────────
/**
 * Council participant calls are AgentX-routed inference and must be visible
 * in Activity like every other lane. Attribution is generated here, never
 * taken from a request: the roundtable id is the correlation id, the
 * participant, phase and round form the caller detail, and `core-council-v1`
 * is the consumer contract. Prompts, responses and private reasoning never
 * enter telemetry. Fire-and-forget: a telemetry failure never fails a turn.
 */
const COUNCIL_CONSUMER_CONTRACT = 'core-council-v1';
const COUNCIL_TASK_TYPE = 'council_deliberation';

function councilTelemetryStatus(result) {
  if (!result.error) return 'success';
  return /timeout/i.test(String(result.error)) ? 'timeout' : 'error';
}

function recordCouncilInference(agent, context, result) {
  try {
    const round = context?.round ?? agent?._round ?? null;
    const phase = context?.phase || (agent?.agentId === 'synthesizer' ? 'synthesis' : 'turn');
    const detail = [`council`, phase, agent?.agentId || 'participant']
      .concat(round != null && phase !== 'synthesis' ? [`round${round}`] : [])
      .join(':');
    const pending = recordInference({
      host: result.target || 'unknown',
      model: agent?.model || 'unknown',
      caller: 'council',
      callerDetail: detail,
      consumerContract: COUNCIL_CONSUMER_CONTRACT,
      correlationId: context?.roundtableId || null,
      workItemId: context?.roundtableId || null,
      attempt: 1,
      taskType: COUNCIL_TASK_TYPE,
      routed: false,
      autoRouted: false,
      tokensIn: result.stats?.promptTokens || 0,
      tokensOut: result.stats?.completionTokens || 0,
      durationMs: Number.isFinite(result.stats?.latencyMs) ? result.stats.latencyMs : 0,
      status: councilTelemetryStatus(result),
      error: result.error || null
    });
    if (pending && typeof pending.catch === 'function') {
      pending.catch((err) => logger.warn('Council telemetry write failed', { error: err.message }));
    }
  } catch (err) {
    logger.warn('Council telemetry skipped', { error: err.message });
  }
}

// ─── single-shot agent call (non-streaming path) ─────────────────────────
async function callAgent(agent, messages, timeoutMs = DEFAULT_TIMEOUT_MS, context = null) {
  const startedAt = new Date();
  const readiness = await assessModelParticipantReadiness(agent);
  const { target, hostName } = readiness;

  if (!readiness.ready) {
    return {
      response: '', thinking: null,
      stats: { tokensPerSecond: null, latencyMs: null },
      error: readiness.error,
      target, hostName, startedAt, completedAt: new Date()
    };
  }

  const payload = await buildPinnedAgentPayload(agent, messages, target);

  try {
    const attempt = await executeAdmittedOllamaAttempt({
      hostUrl: target,
      model: agent.model,
      payload,
      useChat: true,
      stream: false,
      timeoutMs,
      admissionKind: 'council',
      principal: 'core-council',
      runtimeOptions: payload.options,
      // A cancelled council stops this call instead of waiting for its answer.
      ...(context?.signal ? { signal: context.signal } : {})
    });
    const { response: res, data, raw } = attempt;

    if (!res.ok) {
      throw new Error(`Ollama ${res.status}: ${String(data?.error || raw).substring(0, 200)}`);
    }

    const parsed = extractResponse(data, agent.model);
    const completedAt = new Date();
    const result = {
      response: parsed.content || '',
      thinking: parsed.thinking || null,
      stats: {
        tokensPerSecond: parsed.stats?.performance?.tokensPerSecond || null,
        latencyMs: completedAt - startedAt,
        promptTokens: parsed.stats?.usage?.promptTokens || null,
        completionTokens: parsed.stats?.usage?.completionTokens || null
      },
      error: null, target, hostName, startedAt, completedAt
    };
    recordCouncilInference(agent, context, result);
    return result;
  } catch (err) {
    const completedAt = new Date();
    const isTimeout = err.isOllamaTimeout === true || err.name === 'AbortError';
    const errorMsg = context?.signal?.aborted ? 'Cancelled' : isTimeout ? `Timeout after ${timeoutMs}ms` : err.message;
    logger.error('Roundtable callAgent failed', { agentId: agent.agentId, model: agent.model, target, error: errorMsg });
    const result = {
      response: '', thinking: null,
      stats: { tokensPerSecond: null, latencyMs: completedAt - startedAt },
      error: errorMsg, target, hostName, startedAt, completedAt
    };
    recordCouncilInference(agent, context, result);
    return result;
  }
}

// ─── streaming agent call (NDJSON, chunks emitted live) ──────────────────
async function callAgentStreaming(agent, messages, timeoutMs, emitter, eventPrefix, context = null) {
  if (!emitter) return callAgent(agent, messages, timeoutMs, context);

  const startedAt = new Date();
  const readiness = await assessModelParticipantReadiness(agent);
  const { target, hostName } = readiness;

  if (!readiness.ready) {
    return {
      response: '', thinking: null,
      stats: { tokensPerSecond: null, latencyMs: null },
      error: readiness.error,
      target, hostName, startedAt, completedAt: new Date()
    };
  }

  const url = `${target}/api/chat`;
  const payload = await buildPinnedAgentPayload(agent, messages, target, true);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // A cancelled council stops the stream too.
  const stopOnCancel = () => controller.abort();
  if (context?.signal?.aborted) controller.abort();
  else context?.signal?.addEventListener('abort', stopOnCancel, { once: true });
  let streamAttempt = null;

  try {
    streamAttempt = await executeAdmittedOllamaStream({
      hostUrl: target, model: agent.model, payload, useChat: true,
      admissionKind: 'council-stream', principal: 'core-council',
      signal: controller.signal, timeoutMs: null, skipGate: true,
      fetchOptions: getFetchOptions(url, {}),
    });
    if (!streamAttempt.ok) {
      throw new Error(`Ollama ${streamAttempt.status}: ${String(streamAttempt.raw || '').substring(0, 200)}`);
    }

    let fullContent = '';
    let thinkingContent = '';
    let inThinking = false;
    let finalData = null;
    const terminalValidator = createOllamaStreamTerminalValidator();
    const reader = streamAttempt.stream;
    const decoder = new StringDecoder('utf8');
    let buffer = '';

    const consumeLine = (line) => {
      if (!line.trim()) return;
      const observed = terminalValidator.observe(line);
      if (!observed.accepted) return;
      const obj = observed.data;
      if (observed.terminal) { finalData = obj; return; }
      const token = obj.message?.content || '';
      if (!token) return;
      if (token.includes('<think>')) { inThinking = true; return; }
      if (token.includes('</think>')) { inThinking = false; return; }
      if (inThinking) { thinkingContent += token; return; }
      fullContent += token;
      emitter.emit('chunk', { type: `${eventPrefix}-chunk`, agentId: agent.agentId, round: agent._round, content: token });
    };

    await new Promise((resolve, reject) => {
      reader.on('data', (chunk) => {
        buffer += decoder.write(chunk);
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          consumeLine(line);
        }
      });
      reader.on('end', () => {
        buffer += decoder.end();
        consumeLine(buffer);
        resolve();
      });
      reader.on('error', reject);
    });
    if (finalData?.done !== true || !terminalValidator.isComplete()) {
      throw new Error('Ollama stream ended without an exact final terminal record');
    }
    const completion = await streamAttempt.completion;
    if (!completion.completed) throw new Error(completion.admissionError || 'Stream settlement failed');
    clearTimeout(timer);
    context?.signal?.removeEventListener('abort', stopOnCancel);

    const completedAt = new Date();
    const latencyMs = completedAt - startedAt;
    const parsedStats = buildOllamaStats(finalData || {}, fullContent);

    const result = {
      response: fullContent,
      thinking: thinkingContent || null,
      stats: {
        tokensPerSecond: parsedStats?.performance?.tokensPerSecond ?? null,
        latencyMs,
        promptTokens: parsedStats?.usage?.promptTokens || null,
        completionTokens: parsedStats?.usage?.completionTokens || null
      },
      error: null, target, hostName, startedAt, completedAt
    };
    recordCouncilInference(agent, context, result);
    return result;
  } catch (err) {
    if (streamAttempt?.stream && !streamAttempt.stream.destroyed) streamAttempt.stream.destroy();
    if (streamAttempt?.completion) await streamAttempt.completion;
    clearTimeout(timer);
    context?.signal?.removeEventListener('abort', stopOnCancel);
    const completedAt = new Date();
    const isTimeout = err.name === 'AbortError';
    const errorMsg = context?.signal?.aborted ? 'Cancelled' : isTimeout ? `Timeout after ${timeoutMs}ms` : err.message;
    logger.error('Roundtable streaming callAgent failed', { agentId: agent.agentId, model: agent.model, target, error: errorMsg });
    const result = {
      response: '', thinking: null,
      stats: { tokensPerSecond: null, latencyMs: completedAt - startedAt },
      error: errorMsg, target, hostName, startedAt, completedAt
    };
    recordCouncilInference(agent, context, result);
    return result;
  }
}

async function callParticipant(agent, messages, timeoutMs, emitter, eventPrefix, context) {
  const runtime = String(agent.runtime || 'model').toLowerCase();
  if (runtime === 'model') {
    const result = await callAgentStreaming(agent, messages, timeoutMs, emitter, eventPrefix, context);
    return { ...result, runtime: 'model', runtimeRef: null };
  }
  const result = await callRuntimeParticipant(agent, messages, {
    ...context,
    timeoutMs
  });
  if (emitter && result.response) {
    emitter.emit('chunk', {
      type: `${eventPrefix}-chunk`,
      agentId: agent.agentId,
      round: context.round,
      content: result.response
    });
  }
  return result;
}

module.exports = {
  assessModelParticipantReadiness,
  buildPinnedAgentPayload,
  callAgent,
  callAgentStreaming,
  callParticipant,
  isSystemicParticipantFailure,
  participantRouteKey
};
