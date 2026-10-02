'use strict';

/**
 * GET /api/nerve-center/config-status
 *
 * Read-only configuration status for the operator: every variable of
 * shared/envCatalog.json per service, with whether it is customized, on its
 * default, or not configured. Core reports its own environment and asks
 * Benchmark for its own; services that do not report are listed from the
 * catalog. Secret values are never returned (see shared/envStatus.js).
 */

const express = require('express');
const logger = require('../config/logger');
const { buildCatalogOnlyStatus, buildEnvStatus } = require('../../shared/envStatus');

const router = express.Router();
const BENCHMARK_TIMEOUT_MS = 3000;

async function benchmarkStatus(fetchImpl = globalThis.fetch) {
  const base = String(process.env.BENCHMARK_SERVICE_URL || 'http://localhost:3081').replace(/\/+$/, '');
  try {
    const response = await fetchImpl(`${base}/api/config/status`, { signal: AbortSignal.timeout(BENCHMARK_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const status = await response.json();
    if (status?.schema !== 'agentx.env-status/v1' || !Array.isArray(status.variables)) throw new Error('unexpected payload');
    return status;
  } catch (err) {
    logger.debug('[ConfigStatus] benchmark status unavailable', { error: err.message });
    return buildCatalogOnlyStatus({ service: 'benchmark', reason: 'Benchmark did not answer' });
  }
}

router.get('/config-status', async (_req, res) => {
  try {
    const services = [
      buildEnvStatus({ service: 'core' }),
      await benchmarkStatus(),
      buildCatalogOnlyStatus({ service: 'rag', reason: 'RAG does not report its environment yet' }),
      buildCatalogOnlyStatus({ service: 'data', reason: 'Data does not report its environment yet' }),
    ];
    res.json({ status: 'success', data: { generatedAt: new Date().toISOString(), services } });
  } catch (err) {
    logger.error('[ConfigStatus] failed', { error: err.message });
    res.status(500).json({ status: 'error', message: 'Configuration status unavailable' });
  }
});

module.exports = router;
module.exports.benchmarkStatus = benchmarkStatus;
