/**
 * Nerve Center — Benchmark cell budgets (#897)
 *
 * Benchmark opens one budget per local native agent cell before the broker
 * starts the agent, and closes it when the cell ends to read Core's own
 * counts. Mounted at `/api/nerve-center` through the host-preferences router.
 */

const express = require('express');
const router = express.Router();

const cellBudgets = require('../src/services/benchmarkCellBudget');
const { isBenchmarkCaller, requestPrincipal } = require('../src/helpers/requestCaller');

function sendError(res, error, fallbackCode) {
  const known = cellBudgets.isCellBudgetError(error);
  return res.status(known ? error.statusCode : 500).json({
    status: 'error', code: known ? error.code : fallbackCode, message: error.message
  });
}

router.post('/benchmark-cell-budgets', async (req, res) => {
  if (!isBenchmarkCaller(req)) {
    return res.status(403).json({ status: 'error', code: 'BENCHMARK_CELL_BUDGET_CALLER_INVALID',
      message: 'Only the Benchmark service opens cell budgets' });
  }
  try {
    const body = req.body || {};
    const data = await cellBudgets.open({
      principal: requestPrincipal(req),
      cellId: body.cellId,
      envelopeFingerprint: body.envelopeFingerprint,
      targetFingerprint: body.targetFingerprint,
      claims: body.claims,
      maxTurns: body.maxTurns,
      maxToolCalls: body.maxToolCalls,
      maxTokens: body.maxTokens,
      ttlMs: body.ttlMs
    });
    return res.json({ status: 'success', data });
  } catch (error) {
    return sendError(res, error, 'BENCHMARK_CELL_BUDGET_OPEN_FAILED');
  }
});

router.post('/benchmark-cell-budgets/:budgetId/close', (req, res) => {
  try {
    const data = cellBudgets.close(req.params.budgetId, { principal: requestPrincipal(req) });
    return res.json({ status: 'success', data });
  } catch (error) {
    return sendError(res, error, 'BENCHMARK_CELL_BUDGET_CLOSE_FAILED');
  }
});

module.exports = router;
