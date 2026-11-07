'use strict';

const { createHash } = require('node:crypto');
const { isCloudModel } = require('./budgetAccountingService');

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });
const KEYS = new Set(['runtime', 'instanceId', 'runId', 'callIndex', 'provider', 'model', 'inputTokens',
  'outputTokens', 'cachedInputTokens', 'nativeCost', 'billing', 'completedAt', 'durationMs', 'transport', 'coreLogId']);

function identifier(value, max = 160) {
  if (typeof value !== 'string' || value.length > max || !/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]*$/.test(value)) {
    throw fail('RUNTIME_USAGE_INVALID_IDENTIFIER');
  }
  return value;
}
function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw fail('RUNTIME_USAGE_INVALID_COUNT');
  return value;
}

function normalizeRuntimeUsage(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !KEYS.has(key))) {
    throw fail('RUNTIME_USAGE_INVALID_FIELDS');
  }
  if (!['hermes', 'openclaw'].includes(value.runtime)) throw fail('RUNTIME_USAGE_INVALID_RUNTIME');
  if (!['direct-provider', 'core'].includes(value.transport)) throw fail('RUNTIME_USAGE_TRANSPORT_REQUIRED');
  const runtime = value.runtime, instanceId = identifier(value.instanceId, 64), runId = identifier(value.runId, 256);
  const callIndex = count(value.callIndex);
  const receiptId = hash(JSON.stringify([runtime, instanceId, runId, callIndex]));
  if (value.transport === 'core') {
    if (!/^[a-f0-9]{24}$/.test(value.coreLogId || '')) throw fail('RUNTIME_USAGE_CORE_LOG_REQUIRED');
    return { receiptId, coreLogId: value.coreLogId };
  }
  if (value.coreLogId !== undefined) throw fail('RUNTIME_USAGE_TRANSPORT_CONFLICT');
  const provider = identifier(value.provider, 40).toLowerCase(), model = identifier(value.model, 150);
  if (!isCloudModel(`${provider}/model`)) throw fail('RUNTIME_USAGE_CLOUD_PROVIDER_REQUIRED');
  const qualifiedModel = model.startsWith(provider + '/') ? model : `${provider}/${model}`;
  const inputTokens = count(value.inputTokens), outputTokens = count(value.outputTokens);
  const cachedInputTokens = value.cachedInputTokens === undefined ? 0 : count(value.cachedInputTokens);
  if (cachedInputTokens > inputTokens || !Number.isSafeInteger(inputTokens + outputTokens)) throw fail('RUNTIME_USAGE_INVALID_COUNT');
  if (!['metered', 'subscription'].includes(value.billing)) throw fail('RUNTIME_USAGE_BILLING_REQUIRED');
  const timestamp = new Date(value.completedAt);
  const retentionDays = Number(process.env.INFERENCE_LOG_TTL_DAYS || 30);
  if (typeof value.completedAt !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value.completedAt)
    || !Number.isFinite(+timestamp) || +timestamp > now + 300000) throw fail('RUNTIME_USAGE_INVALID_TIMESTAMP');
  if (+timestamp < now - retentionDays * 86400000) throw fail('RUNTIME_USAGE_OUTSIDE_RETENTION', 410);
  const durationMs = value.durationMs === undefined ? 0 : count(value.durationMs);
  let nativeCost = null;
  if (value.nativeCost !== undefined && value.nativeCost !== null) {
    const cost = value.nativeCost;
    if (!cost || Array.isArray(cost) || Object.keys(cost).some(key => !['amount', 'currency'].includes(key))
      || cost.currency !== 'USD' || typeof cost.amount !== 'number' || !Number.isFinite(cost.amount) || cost.amount < 0
      || value.billing !== 'metered') throw fail('RUNTIME_USAGE_INVALID_COST');
    nativeCost = cost.amount;
  }
  const payload = { runtime, instanceId, runIdHash: hash(runId), callIndex, provider, model: qualifiedModel,
    inputTokens, outputTokens, cachedInputTokens, billing: value.billing, nativeCost, timestamp: timestamp.toISOString(), durationMs };
  return { ...payload, receiptId, fingerprint: hash(JSON.stringify(payload)) };
}

async function configuredCost(receipt) {
  // The ordinary calculator has no cache-read tariff. Do not invent one.
  if (receipt.cachedInputTokens) return null;
  const { calculateMessageCost } = require('./costCalculator');
  const model = receipt.model.slice(receipt.provider.length + 1);
  const cost = await calculateMessageCost(`${receipt.provider}:${model}`, { usage: {
    promptTokens: receipt.inputTokens, completionTokens: receipt.outputTokens, totalTokens: receipt.inputTokens + receipt.outputTokens } });
  return ['environment', 'database'].includes(cost?.pricingSource?.source) && Number.isFinite(cost.totalCost) ? cost.totalCost : null;
}

async function ingestRuntimeUsage(value, { Log, price = configuredCost, now } = {}) {
  const receipt = normalizeRuntimeUsage(value, now);
  Log ||= require('../../models/InferenceLog');
  if (receipt.coreLogId) {
    let observed;
    try {
      observed = await Log.findOneAndUpdate({ _id: receipt.coreLogId, source: { $ne: 'declared-receipt' },
        $or: [{ receiptId: { $exists: false } }, { receiptId: receipt.receiptId }] },
      { $set: { receiptId: receipt.receiptId } }, { new: true }).lean();
    } catch (error) {
      if (error.code === 11000) throw fail('RUNTIME_USAGE_IDENTITY_CONFLICT', 409);
      throw error;
    }
    if (!observed) throw fail('RUNTIME_USAGE_CORE_LOG_UNCONFIRMED', 409);
    return { receiptId: receipt.receiptId, source: 'core-observed', recorded: false };
  }
  let costUsd = receipt.nativeCost, costSource = costUsd === null ? 'unknown' : 'native';
  if (receipt.billing === 'subscription') { costUsd = null; costSource = 'subscription'; }
  else if (costUsd === null) {
    try { costUsd = await price(receipt); } catch { /* preserve usage if pricing fails */ }
    if (costUsd !== null && Number.isFinite(costUsd) && costUsd >= 0) costSource = 'configured';
    else costUsd = null;
  }
  const declaredUsage = Object.fromEntries(['runtime', 'instanceId', 'runIdHash', 'callIndex', 'fingerprint', 'provider', 'billing', 'cachedInputTokens']
    .map(key => [key, receipt[key]]));
  const row = { receiptId: receipt.receiptId, source: 'declared-receipt', runtime: 'external',
    host: 'declared', model: receipt.model, caller: 'proxy', consumerContract: null,
    tokensIn: receipt.inputTokens, tokensOut: receipt.outputTokens, durationMs: receipt.durationMs,
    status: 'success', timestamp: new Date(receipt.timestamp), declaredUsage: { ...declaredUsage, costUsd, costSource } };
  let stored;
  try {
    stored = await Log.findOneAndUpdate({ receiptId: receipt.receiptId }, { $setOnInsert: row }, { upsert: true, new: true, runValidators: true }).lean();
  } catch (error) {
    if (error.code !== 11000) throw error;
    stored = await Log.findOne({ receiptId: receipt.receiptId }).lean();
  }
  if (stored?.declaredUsage?.fingerprint !== receipt.fingerprint) throw fail('RUNTIME_USAGE_IDENTITY_CONFLICT', 409);
  return { receiptId: receipt.receiptId, source: 'declared-receipt', costSource: stored.declaredUsage.costSource };
}

async function readRuntimeUsage(receiptId) {
  if (!/^[a-f0-9]{64}$/.test(receiptId)) throw fail('RUNTIME_USAGE_INVALID_IDENTIFIER');
  const row = await require('../../models/InferenceLog').findOne({ receiptId }).lean();
  if (!row) throw fail('RUNTIME_USAGE_NOT_FOUND', 404);
  return require('./routing/inferenceLogReadProjection').projectInferenceLog(row);
}

module.exports = { normalizeRuntimeUsage, ingestRuntimeUsage, readRuntimeUsage };
