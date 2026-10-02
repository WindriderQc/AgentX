// Pinned-model release route (mounted by ./hosts.js before the /:hostId param routes).
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const hostProfileService = require('../../src/services/profiler/hostProfileService');
const { acquireProfilerClaimLease } = require('../../src/services/profiler/profilerClaimLifecycle');
const { isSameOllamaModel } = require('../../src/helpers/ollamaModelIdentity');
const { getWorkloadRecoveryIdentity } = require('../../src/clients/coreApiClient');

const logger = require('../../config/logger');

/** POST /:hostId/release — unload a pinned model from a host */
router.post('/:hostId/release', async (req, res) => {
  let lease;
  let host = null;
  let operationId = null;
  try {
    host = await hostProfileService.getById(req.params.hostId);
    if (!host) return res.status(404).json({ status: 'error', error: 'Host not found' });
    if (!host.dedicated?.model) {
      return res.status(400).json({ status: 'error', error: 'Host has no pinned model' });
    }

    operationId = `profiler-release-${crypto.randomBytes(8).toString('hex')}`;
    lease = await acquireProfilerClaimLease([host.hostUrl], operationId, 5 * 60 * 1000);
    const recovery = getWorkloadRecoveryIdentity(operationId);
    if (!recovery?.recoveryId || !recovery?.admissionId) {
      const error = new Error('Release-model requires a durable Core recovery quarantine');
      error.code = 'PROFILER_RELEASE_RECOVERY_QUARANTINE_REQUIRED';
      error.statusCode = 503;
      throw error;
    }
    lease.assertActive();
    await hostProfileService.upsertAuthority({
      hostId: req.params.hostId,
      reconciliation: {
        state: 'prepared',
        operation: 'release_model',
        operationId,
        workloadId: operationId,
        admissionId: recovery.admissionId,
        admissionGeneration: recovery.generation,
        admissionPrincipal: recovery.principal,
        recoveryId: recovery.recoveryId,
        recoveryRequestId: recovery.recoveryRequestId,
        model: host.dedicated.model,
        priorDedicated: host.dedicated,
        desiredDedicated: null,
        reason: 'awaiting fenced Core runtime restore receipt',
        startedAt: new Date()
      }
    }, {
      authorityService: 'profiler-release',
      signal: lease.signal,
      assertAuthorityActive: lease.assertActive
    });
    lease.assertActive();
    await hostProfileService.upsertAuthority({
      hostId: req.params.hostId,
      reconciliation: {
        ...host.reconciliation,
        state: 'mutating',
        operation: 'release_model',
        operationId,
        workloadId: operationId,
        admissionId: recovery.admissionId,
        admissionGeneration: recovery.generation,
        admissionPrincipal: recovery.principal,
        recoveryId: recovery.recoveryId,
        recoveryRequestId: recovery.recoveryRequestId,
        model: host.dedicated.model,
        priorDedicated: host.dedicated,
        desiredDedicated: null,
        reason: 'Ollama unload request is in flight without a terminal server receipt',
        startedAt: new Date()
      }
    }, {
      authorityService: 'profiler-release',
      signal: lease.signal,
      assertAuthorityActive: lease.assertActive
    });
    lease.assertActive();
    const result = await hostProfileService.releaseModel(host.hostUrl, host.dedicated.model, {
      signal: lease.signal,
      assertClaimActive: lease.assertActive
    });
    try {
      await hostProfileService.upsertAuthority({
        hostId: req.params.hostId,
        reconciliation: {
          state: 'verified',
          operation: 'release_model',
          operationId,
          workloadId: operationId,
          admissionId: recovery.admissionId,
          admissionGeneration: recovery.generation,
          admissionPrincipal: recovery.principal,
          recoveryId: recovery.recoveryId,
          recoveryRequestId: recovery.recoveryRequestId,
          model: host.dedicated.model,
          priorDedicated: host.dedicated,
          desiredDedicated: null,
          serverTerminalObserved: result.serverTerminalObserved === true,
          serverTerminalAt: result.serverTerminalAt || new Date(),
          reason: 'awaiting fenced Core runtime restore receipt',
          startedAt: new Date()
        }
      }, {
        authorityService: 'profiler-release',
        signal: lease.signal,
        assertAuthorityActive: lease.assertActive
      });
    } catch (projectionError) {
      projectionError.code = 'PROFILER_RELEASE_RECONCILIATION_PENDING';
      projectionError.statusCode = 503;
      projectionError.retainAdmission = true;
      projectionError.serverTerminalObserved = true;
      throw projectionError;
    }

    const releasedModel = host.dedicated.model;
    const releaseReceipt = await lease.finalize({
      byHost: {
        [host.hostUrl]: { excludedModels: [releasedModel] }
      },
      beforeWorkloadRelease: async hostRelease => {
        const status = await hostProfileService.checkStatus(host.hostUrl);
        if (status.dedicated?.model && isSameOllamaModel(status.dedicated.model, releasedModel)) {
          const error = new Error('Released model became resident again before projection commit');
          error.code = 'PROFILER_RELEASE_NOT_STABLE';
          error.statusCode = 409;
          throw error;
        }
        await hostProfileService.upsertAuthority({
          hostId: req.params.hostId,
          status: status.status,
          dedicated: null,
          reconciliation: {
            state: 'resolved',
            operation: 'release_model',
            operationId,
            workloadId: operationId,
            admissionId: recovery.admissionId,
            admissionGeneration: recovery.generation,
            admissionPrincipal: recovery.principal,
            recoveryId: recovery.recoveryId,
            recoveryRequestId: recovery.recoveryRequestId,
            model: releasedModel,
            priorDedicated: host.dedicated,
            desiredDedicated: null,
            releaseReceipt: hostRelease.details?.[0]?.releaseReceipt || null,
            reason: null,
            startedAt: new Date(),
            resolvedAt: new Date()
          }
        }, {
          authorityService: 'profiler-release',
          signal: lease.signal,
          assertAuthorityActive: lease.assertActive
        });
      }
    });
    lease = null;
    const runtimeRestore = releaseReceipt.details?.[0]?.runtimeRestore;
    if (runtimeRestore?.verified !== true) {
      const error = new Error('Core did not verify the requested model remained unloaded');
      error.code = 'PROFILER_RELEASE_NOT_VERIFIED';
      error.statusCode = 503;
      throw error;
    }
    const data = {
      success: true,
      hostId: req.params.hostId,
      releasedModel,
      dedicated: null,
      runtimeRestore
    };
    res.json({ status: 'success', data });
  } catch (err) {
    // The reconciliation marker is written before unloading. If Core restore
    // or the projection commit fails, leave it pending and keep the global
    // admission fenced for recovery; never issue an unfenced compensating
    // write after finalization.
    logger.error('Release model failed', { hostId: req.params.hostId, error: err.message });
    if (lease && err.retainAdmission === true) {
      await lease.abandon(err);
      lease = null;
    }
    res.status(err.statusCode || 500).json({ status: 'error', error: err.message, code: err.code || null });
  } finally {
    if (lease) {
      try {
        await lease.finalize();
      } catch (error) {
        logger.error('Release-model lease finalization failed; reconciliation remains pending', {
          operationId,
          error: error.message
        });
      }
    }
  }
});

module.exports = router;
