'use strict';

/**
 * Per-cell model-turn, tool-call and token budget for local native agent
 * Benchmark cells (#897).
 *
 * Every model call of a local OpenClaw cell reaches Core's OpenClaw bridge.
 * Benchmark opens one budget per cell before the broker starts the agent; the
 * cell carries only the opaque budgetId in its claim header, and Core reads
 * every ceiling from its own record. A call is reserved before dispatch and
 * settled from Ollama's own counts. A refused call opens no Ollama request.
 *
 * The record lives in this process only: after a Core restart every budgetId
 * is unknown, so the cell's next call is refused and the cell fails closed.
 */

const crypto = require('crypto');

const BUDGET_ID = /^[a-f0-9]{32}$/;
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CLOSED_RETENTION_MS = 60 * 60 * 1000;
const CLAIM_FIELDS = ['host', 'claimBatchId', 'claimGeneration', 'workloadAdmissionId', 'workloadGeneration'];
// Input tokens are estimated from the request bytes before dispatch, like the
// Benchmark envelope's own estimate. Ollama's prompt_eval_count settles it.
const BYTES_PER_TOKEN = 3;

const budgets = new Map();

class CellBudgetError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.statusCode = 409;
    Object.assign(this, details);
  }
}

function integer(value, name, min, max) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    const error = new CellBudgetError('BENCHMARK_CELL_BUDGET_REQUEST_INVALID', `${name} must be an integer from ${min} to ${max}`);
    error.statusCode = 400;
    throw error;
  }
  return number;
}

function text(value, name) {
  const result = String(value || '').trim();
  if (!result || result.length > 512) {
    const error = new CellBudgetError('BENCHMARK_CELL_BUDGET_REQUEST_INVALID', `${name} is required`);
    error.statusCode = 400;
    throw error;
  }
  return result;
}

function normalizeHost(host) {
  return String(host || '').trim().replace(/\/+$/, '');
}

function normalizeClaims(claims) {
  if (!Array.isArray(claims) || claims.length === 0 || claims.length > 8) {
    const error = new CellBudgetError('BENCHMARK_CELL_BUDGET_REQUEST_INVALID', 'claims must list the cell host claims');
    error.statusCode = 400;
    throw error;
  }
  return claims.map(claim => Object.fromEntries(CLAIM_FIELDS.map(field => [field,
    field === 'host' ? normalizeHost(text(claim?.host, 'claims.host')) : text(claim?.[field], `claims.${field}`)])))
    .sort((a, b) => a.host.localeCompare(b.host));
}

function claimsKey(claims) {
  return JSON.stringify(claims.map(claim => CLAIM_FIELDS.map(field => claim[field])));
}

function sweep(now) {
  for (const [id, budget] of budgets) {
    const until = budget.closedAt ? budget.closedAt + CLOSED_RETENTION_MS : budget.expiresAt + CLOSED_RETENTION_MS;
    if (until <= now) budgets.delete(id);
  }
}

// The default check: each claim names the host's active benchmark claim and
// its workload admission. Benchmark is the only caller and owns those claims.
async function verifyActiveClaims(claims) {
  const { getActiveBenchmarkClaim } = require('./benchmarkClaimGuard');
  for (const claim of claims) {
    const active = await getActiveBenchmarkClaim(claim.host);
    if (!active || active.batchId !== claim.claimBatchId || active.claimGeneration !== claim.claimGeneration
      || active.admissionId !== claim.workloadAdmissionId || active.admissionGeneration !== claim.workloadGeneration) {
      throw new CellBudgetError('BENCHMARK_CELL_BUDGET_CLAIM_INACTIVE', `No exact active benchmark claim on ${claim.host}`);
    }
  }
}

async function open(request = {}, { now = Date.now(), verifyClaims = verifyActiveClaims } = {}) {
  sweep(now);
  const claims = normalizeClaims(request.claims);
  const record = {
    budgetId: crypto.randomBytes(16).toString('hex'),
    principal: text(request.principal, 'principal'),
    cellId: text(request.cellId, 'cellId'),
    envelopeFingerprint: text(request.envelopeFingerprint, 'envelopeFingerprint'),
    targetFingerprint: text(request.targetFingerprint, 'targetFingerprint'),
    claims,
    claimsKey: claimsKey(claims),
    maxTurns: integer(request.maxTurns, 'maxTurns', 1, 100000),
    maxToolCalls: integer(request.maxToolCalls, 'maxToolCalls', 0, 1000000),
    maxTokens: integer(request.maxTokens, 'maxTokens', 1, 1_000_000_000),
    openedAt: now,
    expiresAt: now + integer(request.ttlMs, 'ttlMs', 1000, MAX_TTL_MS),
    closedAt: null,
    turns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, embedCalls: 0,
    unsettledTurns: 0, refusedCalls: 0, numPredictLowered: false, exhaustedBy: null,
    lastInputTokens: 0, lastRequestBytes: 0, inFlight: null
  };
  await verifyClaims(claims);
  budgets.set(record.budgetId, record);
  return publicRecord(record);
}

function publicRecord(budget) {
  return {
    budgetId: budget.budgetId,
    cellId: budget.cellId,
    envelopeFingerprint: budget.envelopeFingerprint,
    targetFingerprint: budget.targetFingerprint,
    maxTurns: budget.maxTurns,
    maxToolCalls: budget.maxToolCalls,
    maxTokens: budget.maxTokens,
    expiresAt: new Date(budget.expiresAt).toISOString()
  };
}

function observed(budget) {
  return {
    budgetId: budget.budgetId,
    cellId: budget.cellId,
    envelopeFingerprint: budget.envelopeFingerprint,
    limits: { maxTurns: budget.maxTurns, maxToolCalls: budget.maxToolCalls, maxTokens: budget.maxTokens },
    turns: budget.turns,
    toolCalls: budget.toolCalls,
    inputTokens: budget.inputTokens,
    outputTokens: budget.outputTokens,
    embedCalls: budget.embedCalls,
    unsettledTurns: budget.unsettledTurns,
    refusedCalls: budget.refusedCalls,
    exhaustedBy: budget.exhaustedBy,
    numPredictLowered: budget.numPredictLowered,
    inFlight: Boolean(budget.inFlight)
  };
}

// The header's claim entries must all name one open budget and exactly the
// claims it was opened with.
function budgetIdFromClaims(claims) {
  if (!Array.isArray(claims) || claims.length === 0) return null;
  const ids = new Set(claims.map(claim => claim?.budgetId));
  if (ids.size !== 1) return undefined;
  const [id] = ids;
  return typeof id === 'string' && BUDGET_ID.test(id) ? id : undefined;
}

function admittedBudget(claims, now) {
  const budgetId = budgetIdFromClaims(claims);
  if (budgetId === null || budgetId === undefined) {
    throw new CellBudgetError('BENCHMARK_CELL_BUDGET_REQUIRED',
      'A benchmark claim on the OpenClaw bridge requires its cell budget');
  }
  const budget = budgets.get(budgetId);
  let matches = false;
  try { matches = Boolean(budget) && claimsKey(normalizeClaims(claims)) === budget.claimsKey; } catch { matches = false; }
  if (!budget || budget.closedAt || budget.expiresAt <= now || !matches) {
    if (budget && matches) budget.refusedCalls += 1;
    throw new CellBudgetError('BENCHMARK_CELL_BUDGET_INVALID', 'The cell budget is unknown, closed, expired or names other claims');
  }
  return budget;
}

function refuse(budget, reason, code = 'BENCHMARK_CELL_BUDGET_EXHAUSTED') {
  budget.refusedCalls += 1;
  if (reason && !budget.exhaustedBy) budget.exhaustedBy = reason;
  throw new CellBudgetError(code, reason
    ? `The cell ${reason} budget is exhausted`
    : 'Another call of this cell is still in flight', { exhaustedBy: budget.exhaustedBy });
}

function requestBytes(request) {
  return Buffer.byteLength(JSON.stringify([request.system || null, request.prompt || null,
    request.messages || null, request.tools || null]), 'utf8');
}

/**
 * Reserve one model turn before dispatch. Returns the num_predict to send
 * (never above the requested one) and a settle(counts) function.
 */
function reserve(claims, request = {}, { now = Date.now() } = {}) {
  const budget = admittedBudget(claims, now);
  if (budget.exhaustedBy) refuse(budget, budget.exhaustedBy);
  if (budget.inFlight) refuse(budget, null, 'BENCHMARK_CELL_BUDGET_CONCURRENT');
  if (budget.turns >= budget.maxTurns) refuse(budget, 'turns');
  // A tool batch can pass the ceiling only in the response that crossed it;
  // the call that would act on those results is refused.
  if (budget.toolCalls > budget.maxToolCalls) refuse(budget, 'toolCalls');
  const bytes = requestBytes(request);
  const appended = budget.lastRequestBytes ? Math.max(0, bytes - budget.lastRequestBytes) : bytes;
  const estimatedInput = budget.lastInputTokens + Math.ceil(appended / BYTES_PER_TOKEN);
  const remaining = budget.maxTokens - budget.inputTokens - budget.outputTokens;
  const room = remaining - estimatedInput;
  if (room < 1) refuse(budget, 'tokens');
  const requested = Number(request.numPredict);
  const bounded = Number.isSafeInteger(requested) && requested > 0;
  const numPredict = bounded ? Math.min(requested, room) : room;
  const lowered = !bounded || numPredict < requested;
  if (lowered) budget.numPredictLowered = true;
  const reservation = { estimatedInput, numPredict, bytes };
  budget.inFlight = reservation;
  budget.turns += 1;
  let settled = false;
  const settle = ({ complete = false, inputTokens, outputTokens, toolCalls = 0 } = {}) => {
    if (settled) return observed(budget);
    settled = true;
    if (budget.inFlight === reservation) budget.inFlight = null;
    const exact = complete && Number.isSafeInteger(inputTokens) && inputTokens >= 0
      && Number.isSafeInteger(outputTokens) && outputTokens >= 0;
    // An unconfirmed call keeps its whole reservation as spent.
    budget.inputTokens += exact ? inputTokens : estimatedInput;
    budget.outputTokens += exact ? outputTokens : numPredict;
    budget.toolCalls += Math.max(0, Number(toolCalls) || 0);
    if (!exact) budget.unsettledTurns += 1;
    budget.lastInputTokens = exact ? inputTokens : estimatedInput;
    budget.lastRequestBytes = bytes;
    return observed(budget);
  };
  return { budgetId: budget.budgetId, numPredict, numPredictLowered: lowered, settle };
}

// An embedding call is not a model turn, but it still needs an open budget.
function admitEmbed(claims, { now = Date.now() } = {}) {
  const budget = admittedBudget(claims, now);
  if (budget.exhaustedBy) refuse(budget, budget.exhaustedBy);
  budget.embedCalls += 1;
  return budget.budgetId;
}

function close(budgetId, { principal, now = Date.now() } = {}) {
  const budget = BUDGET_ID.test(String(budgetId || '')) ? budgets.get(budgetId) : null;
  if (!budget || budget.principal !== principal) {
    const error = new CellBudgetError('BENCHMARK_CELL_BUDGET_NOT_FOUND', 'No such cell budget for this caller');
    error.statusCode = 404;
    throw error;
  }
  if (!budget.closedAt) budget.closedAt = now;
  return observed(budget);
}

function isCellBudgetError(error) {
  return error instanceof CellBudgetError;
}

function resetForTests() {
  budgets.clear();
}

module.exports = {
  BUDGET_ID,
  CellBudgetError,
  admitEmbed,
  budgetIdFromClaims,
  close,
  isCellBudgetError,
  open,
  reserve,
  resetForTests
};
