'use strict';

const { createHash } = require('node:crypto');
const count = value => Number.isSafeInteger(value) && value >= 0;
const instanceIdFor = origin => createHash('sha256').update(new URL(origin).origin).digest('hex').slice(0, 32);

// Translation only: Core validates, deduplicates and prices these receipts.
function hermesUsageReceipt(state, origin) {
  const native = state?.receipt, usage = native?.usage, provider = native?.runtime?.provider;
  if (native?.status !== 'completed' || native.partial === true || native.completed === false
    || !count(usage?.input_tokens) || !count(usage?.output_tokens)
    || !provider || ['custom', 'ollama', 'agentx'].includes(provider)) return null;
  return { runtime: 'hermes', instanceId: instanceIdFor(origin), runId: state.runId, callIndex: 0,
    transport: 'direct-provider', provider, model: native.runtime.model,
    inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
    cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
    billing: provider === 'openai-codex' ? 'subscription' : 'metered', completedAt: state.settledAt };
}

// An OpenClaw native transcript row identifies one assistant model call,
// including tool-use calls. Model mode does not write this agent transcript.
function openclawUsageReceipt(row, { instanceId, sessionId, directProviders }) {
  const message = row?.message, usage = message?.usage;
  if (row?.type !== 'message' || typeof row.id !== 'string' || !row.id || typeof sessionId !== 'string' || !sessionId
    || message?.role !== 'assistant' || !directProviders.includes(message.provider)
    || !['stop', 'toolUse', 'length'].includes(message.stopReason)
    || !['input', 'output', 'cacheRead', 'cacheWrite'].every(key => count(usage?.[key]))) return null;
  const nativeCost = usage.cost?.total;
  const billing = message.provider === 'openai-codex' ? 'subscription' : 'metered';
  return { runtime: 'openclaw', instanceId, runId: `${sessionId}/${row.id}`, callIndex: 0,
    transport: 'direct-provider', provider: message.provider, model: message.model,
    inputTokens: usage.input + usage.cacheRead + usage.cacheWrite, outputTokens: usage.output,
    cachedInputTokens: usage.cacheRead, billing, completedAt: row.timestamp,
    ...(billing === 'metered' && Number.isFinite(nativeCost) && nativeCost >= 0
      ? { nativeCost: { amount: nativeCost, currency: 'USD' } } : {}) };
}

module.exports = { instanceIdFor, hermesUsageReceipt, openclawUsageReceipt };
