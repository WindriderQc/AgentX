'use strict';

// A surface turn's measured usage, served model and RAG flags, written in the
// same message fields the Playground writes, so chat analytics reads one shape.
const { PRINCIPAL_MODEL_ALIAS } = require('../routing/principalAlias');
const { isCloudCall } = require('../budgetAccountingService');

const count = value => Number.isSafeInteger(value) && value >= 0;
const PRICED_SOURCES = new Set(['environment', 'database']);
// Retrieval ran (or the agent owns a knowledge tool) on these statuses.
const KNOWLEDGE_REQUESTED = new Set(['ready', 'empty', 'agent-managed']);

// Ollama counts, OpenAI chat usage, Responses/Hermes usage or an OpenClaw
// receipt. Anything incomplete stays unknown (null), never 0.
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const nativeInput = count(usage.input)
    ? usage.input + (count(usage.cacheRead) ? usage.cacheRead : 0) + (count(usage.cacheWrite) ? usage.cacheWrite : 0) : undefined;
  const prompt = usage.promptTokens ?? usage.prompt_eval_count ?? usage.prompt_tokens ?? usage.input_tokens ?? nativeInput;
  const completion = usage.completionTokens ?? usage.eval_count ?? usage.completion_tokens ?? usage.output_tokens ?? usage.output;
  if (!count(prompt) || !count(completion)) return null;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion };
}

// A tool loop makes several calls for one reply: the turn is their sum, or
// unknown when one call has no counts.
function sumUsage(rows) {
  let promptTokens = 0, completionTokens = 0;
  for (const row of rows) {
    const usage = normalizeUsage(row);
    if (!usage) return null;
    promptTokens += usage.promptTokens; completionTokens += usage.completionTokens;
  }
  return rows.length ? { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens } : null;
}

async function principalPin() {
  return (await require('../principalModelService').getPrincipalModel()).model || null;
}

// Clients name the stable alias; analytics needs the model Core's host pin
// served. The pin current when the turn is recorded is that model. If the pin
// cannot be read, the alias is kept rather than guessed.
async function servedModel(model, resolvePrincipal = principalPin) {
  const name = typeof model === 'string' ? model.trim() : '';
  if (name !== PRINCIPAL_MODEL_ALIAS) return name;
  try { return (await resolvePrincipal()) || name; } catch { return name; }
}

// Message-level `stats` and `cost`. Local inference is priced like the
// Playground. A cloud provider without a configured price keeps its tokens and
// an unknown (null) cost, never an invented $0.
async function messageAccounting({ model, provider, usage } = {}, { resolvePrincipal, calculateMessageCost } = {}) {
  const served = await servedModel(model, resolvePrincipal);
  const measured = normalizeUsage(usage);
  if (!served && !measured) return {};
  const vendor = typeof provider === 'string' && provider.trim() ? provider.trim().toLowerCase() : '';
  const stats = { ...(measured ? { usage: measured } : {}), meta: { model: served,
    ...(served !== model && model ? { requestedModel: model } : {}), ...(vendor ? { provider: vendor } : {}) } };
  if (!measured) return { stats };
  const price = calculateMessageCost || require('../costCalculator').calculateMessageCost;
  const unpriced = { totalCost: null, currency: 'USD', pricingSource: { source: 'unconfigured', provider: vendor || null, modelName: served },
    calculatedAt: new Date() };
  // Pricing is accounting: its failure never costs the household its turn.
  try {
    const cloud = isCloudCall({ model: vendor ? `${vendor}/${served}` : served });
    if (!cloud) return { stats, cost: await price(served, { usage: measured }) };
    const priced = await price(`${vendor}:${served}`, { usage: measured });
    return { stats, cost: PRICED_SOURCES.has(priced?.pricingSource?.source) ? priced : unpriced };
  } catch {
    return { stats, cost: unpriced };
  }
}

// The same evidence as update paths: a later update that only names the model
// keeps the tokens and cost already recorded on the message.
function accountingPaths({ stats, cost } = {}) {
  return { ...(stats?.meta ? { 'stats.meta': stats.meta } : {}), ...(stats?.usage ? { 'stats.usage': stats.usage } : {}),
    ...(cost ? { cost } : {}) };
}

// The tokens and provider an engine reported in its result metadata, as
// recordTurn input. An engine that reports none leaves them unknown.
const turnUsage = metadata => ({ ...(metadata?.usage ? { usage: metadata.usage } : {}),
  ...(metadata?.provider ? { modelProvider: metadata.provider } : {}) });

// Conversation-level flags read by the RAG analytics. They only turn on: one
// turn that used knowledge makes the conversation a RAG conversation.
function conversationRagFlags(turn = {}) {
  const used = turn.knowledgeUsed === true || Number(turn.knowledgeSourceCount) > 0;
  const requested = used || KNOWLEDGE_REQUESTED.has(turn.knowledgeStatus);
  return { ...(requested ? { ragRequested: true } : {}), ...(used ? { ragUsed: true } : {}) };
}

module.exports = { normalizeUsage, sumUsage, servedModel, messageAccounting, accountingPaths, turnUsage, conversationRagFlags };
