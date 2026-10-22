/**
 * Core cell budgets (#897): one per local native agent cell. Core enforces the
 * cell's turn, tool-call and token ceilings before every model call and
 * returns its own counts when the cell closes the budget.
 */

const { coreRequest } = require('./coreHttp');
const { CORE_OPERATIONS } = require('./coreOperations');

const BUDGET_ID = /^[a-f0-9]{32}$/;

function cellBudgetError(code, message, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

async function openCellBudget({ cellId, envelope, targetFingerprint, claims, ttlMs }) {
  const budgets = envelope?.budgets || {};
  let data;
  try {
    data = await coreRequest('/api/nerve-center/benchmark-cell-budgets', {
      method: 'POST',
      operationId: CORE_OPERATIONS.CELL_BUDGET_OPEN,
      body: JSON.stringify({
        cellId,
        envelopeFingerprint: envelope?.fingerprint,
        targetFingerprint,
        claims: claims.map(({ host, claimBatchId, claimGeneration, workloadAdmissionId, workloadGeneration }) => ({
          host, claimBatchId, claimGeneration, workloadAdmissionId, workloadGeneration
        })),
        maxTurns: budgets.maxTurns,
        maxToolCalls: budgets.maxToolCalls,
        maxTokens: budgets.maxTokens,
        ttlMs
      })
    });
  } catch (error) {
    throw cellBudgetError('CORE_CELL_BUDGET_UNAVAILABLE', 'Core did not open the native agent cell budget', error);
  }
  const record = data?.data;
  // The record Core keeps must be the envelope this cell runs under.
  if (!BUDGET_ID.test(String(record?.budgetId || ''))
    || record.envelopeFingerprint !== envelope?.fingerprint
    || record.targetFingerprint !== targetFingerprint
    || record.maxTurns !== budgets.maxTurns
    || record.maxToolCalls !== budgets.maxToolCalls
    || record.maxTokens !== budgets.maxTokens) {
    throw cellBudgetError('CORE_CELL_BUDGET_MISMATCH', 'Core cell budget does not match the WorkerEnvelope');
  }
  return record;
}

async function closeCellBudget(budgetId) {
  if (!BUDGET_ID.test(String(budgetId || ''))) throw cellBudgetError('CORE_CELL_BUDGET_INVALID', 'Cell budget id is invalid');
  let data;
  try {
    data = await coreRequest(`/api/nerve-center/benchmark-cell-budgets/${budgetId}/close`, {
      method: 'POST',
      operationId: CORE_OPERATIONS.CELL_BUDGET_CLOSE,
      body: JSON.stringify({})
    });
  } catch (error) {
    throw cellBudgetError('CORE_CELL_BUDGET_UNREADABLE', 'Core did not return the native agent cell counts', error);
  }
  const observed = data?.data;
  if (observed?.budgetId !== budgetId || !Number.isSafeInteger(observed.turns)) {
    throw cellBudgetError('CORE_CELL_BUDGET_UNREADABLE', 'Core returned no valid native agent cell counts');
  }
  return observed;
}

module.exports = { closeCellBudget, openCellBudget };
