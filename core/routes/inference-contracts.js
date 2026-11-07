'use strict';

const router = require('express').Router();
const logger = require('../config/logger');
const { validateHostUrl } = require('../src/helpers/ollamaHostConfig');
const { resolveInferenceContractSnapshot } = require('../src/services/inferenceContractService');
const { requestPrincipal } = require('../src/helpers/requestCaller');
const { resolvePreparedDriverContract } = require('../src/services/gpuDriverQualificationContract');

/**
 * Resolve a serializable host/artifact contract once, before a benchmark or
 * other reproducible matrix begins. Callers are expected to persist the
 * returned snapshot and reuse it rather than resolving capabilities between
 * attempts.
 */
router.post('/inference/contract/resolve', async (req, res) => {
    const body = req.body || {};
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    const host = typeof body.host === 'string' ? body.host.trim() : '';
    if (!model || !host) {
        return res.status(400).json({
            status: 'error',
            message: 'model and host are required to freeze a deployed-artifact contract'
        });
    }

    const hostCheck = validateHostUrl(host);
    if (!hostCheck.valid) {
        return res.status(400).json({ status: 'error', message: hostCheck.message });
    }

    try {
        const options = body.options || {};
        const rawNumCtx = options.num_ctx ?? body.num_ctx;
        const rawNumPredict = options.num_predict ?? body.num_predict;
        const requestedNumCtx = rawNumCtx == null ? null : Number(rawNumCtx);
        const requestedMaxOutputTokens = rawNumPredict == null ? null : Number(rawNumPredict);
        if ((rawNumCtx != null && (!Number.isInteger(requestedNumCtx) || requestedNumCtx <= 0))
            || (rawNumPredict != null
                && (!Number.isInteger(requestedMaxOutputTokens) || requestedMaxOutputTokens <= 0))) {
            return res.status(400).json({
                status: 'error',
                message: 'num_ctx and num_predict must be positive integers when supplied'
            });
        }
        const snapshot = await resolveInferenceContractSnapshot({
            model,
            host: hostCheck.host,
            requestedNumCtx,
            numCtxSource: requestedNumCtx != null ? 'caller' : 'profile',
            requestedMaxOutputTokens
        });
        return res.json(snapshot);
    } catch (err) {
        logger.error('[inference] contract snapshot resolution failed', {
            model,
            host: hostCheck.host,
            error: err.message
        });
        return res.status(500).json({
            status: 'error',
            message: 'Failed to resolve inference contract snapshot'
        });
    }
});

router.post('/inference/contract/resolve-prepared-driver', async (req, res) => {
  const body = req.body || {};
  const hostCheck = validateHostUrl(body.host);
  if (!hostCheck.valid || typeof body.model !== 'string' || !body.model.trim()) {
    return res.status(400).json({ status: 'error', message: 'An exact model and valid registered host are required' });
  }
  try {
    const options = body.options || {};
    const data = await resolvePreparedDriverContract({
      model: body.model.trim(), host: hostCheck.host, principal: requestPrincipal(req),
      driverPreparationId: body.driverPreparationId, workloadId: body.workloadId,
      workloadAdmissionId: body.workloadAdmissionId, workloadGeneration: body.workloadGeneration,
      claimBatchId: body.claimBatchId, claimGeneration: body.claimGeneration,
      requestedNumCtx: options.num_ctx ?? null, requestedMaxOutputTokens: options.num_predict ?? null
    });
    return res.json(data);
  } catch (error) {
    return res.status(error.statusCode || error.status || 503).json({ status: 'error', code: error.code, message: error.message });
  }
});

module.exports = router;
