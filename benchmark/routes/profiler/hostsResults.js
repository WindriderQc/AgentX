// Runtime-restart recovery attestation and performance-result routes (mounted by ./hosts.js).
const express = require('express');
const router = express.Router();
const HostPerformanceSnapshot = require('../../models/HostPerformanceSnapshot');
const HostProfile = require('../../models/HostProfile');

// ═══ PERFORMANCE RESULTS ════════════════════════════════════════════════════

/**
 * Explicit recovery for an Ollama request whose client connection ended
 * without a terminal server response. Silence is never accepted as proof.
 * An operator may attest a controlled runtime restart, which terminates every
 * request from the prior runtime instance; the durable worker then performs
 * exact host restoration before releasing Core quarantine.
 */
router.post('/test/recovery/:hostId/confirm-runtime-restart', async (req, res) => {
  try {
    const operationId = String(req.body?.operationId || '');
    const runtimeInstanceId = String(req.body?.runtimeInstanceId || '');
    const restartedAt = new Date(req.body?.restartedAt);
    if (req.body?.confirmation !== 'RUNTIME_RESTARTED_AND_OLLAMA_REQUESTS_TERMINATED'
      || !operationId
      || !runtimeInstanceId
      || !Number.isFinite(restartedAt.getTime())) {
      return res.status(400).json({
        status: 'error',
        code: 'PROFILER_RUNTIME_RESTART_RECEIPT_INVALID',
        error: 'Exact operationId, runtimeInstanceId, restartedAt and typed confirmation are required'
      });
    }
    const current = await HostProfile.findOne({
      hostId: req.params.hostId,
      'reconciliation.operationId': operationId,
      'reconciliation.state': { $in: ['prepared', 'mutating', 'unknown', 'pending_reconciliation'] },
      'reconciliation.serverTerminalObserved': { $ne: true }
    }).lean();
    if (!current) {
      return res.status(409).json({ status: 'error', code: 'PROFILER_RECOVERY_INTENT_NOT_FOUND', error: 'No matching unresolved recovery intent' });
    }
    const receipt = {
      contract: 'agentx.ollama-runtime-restart/v1',
      operationId,
      runtimeInstanceId,
      restartedAt,
      confirmedAt: new Date()
    };
    const updated = await HostProfile.findOneAndUpdate(
      {
        _id: current._id,
        'reconciliation.operationId': operationId,
        'reconciliation.serverTerminalObserved': { $ne: true }
      },
      { $set: {
        'reconciliation.state': 'unknown',
        'reconciliation.serverTerminalObserved': true,
        'reconciliation.serverTerminalAt': restartedAt,
        'reconciliation.operatorTerminalReceipt': receipt,
        'reconciliation.reason': 'Runtime restart attested; awaiting exact fenced restoration', 'reconciliation.failedAttempts': 0
      }, $unset: { 'reconciliation.operatorRequiredAt': '', 'reconciliation.nextAttemptAt': '' } }, // an attestation resumes automatic recovery
      { new: true }
    ).lean();
    if (!updated) {
      return res.status(409).json({ status: 'error', code: 'PROFILER_RECOVERY_INTENT_CHANGED', error: 'Recovery intent changed concurrently' });
    }
    return res.json({ status: 'success', data: { accepted: true, hostId: updated.hostId, operationId, receipt } });
  } catch (error) {
    return res.status(500).json({ status: 'error', code: 'PROFILER_RUNTIME_RESTART_RECOVERY_FAILED', error: error.message });
  }
});

/** GET /test/results — query host performance snapshots */
router.get('/test/results', async (req, res) => {
  try {
    const { hostUrl, hostId, limit: rawLimit } = req.query;
    const limit = Math.min(parseInt(rawLimit, 10) || 100, 500);
    const filter = {
      authorityState: { $nin: ['authority_invalidated', 'pending_reconciliation'] }
    };
    if (hostUrl) filter.hostUrl = hostUrl;
    if (hostId) filter.hostId = hostId;
    const results = await HostPerformanceSnapshot.find(filter).sort({ testedAt: -1 }).limit(limit).lean();
    const passing = results.filter(r => r.status === 'pass');
    const summary = {
      modelsTested: new Set(results.map(r => r.modelName)).size,
      totalSnapshots: results.length,
      avgTps: passing.length ? Number((passing.reduce((s, r) => s + (r.tokensPerSec || 0), 0) / passing.length).toFixed(2)) : 0,
      avgLatency: passing.length ? Math.round(passing.reduce((s, r) => s + (r.latencyMs || 0), 0) / passing.length) : 0
    };
    res.json({ status: 'success', data: { results, summary } });
  } catch (err) { res.status(500).json({ status: 'error', message: err.message }); }
});

/** GET /test/results/:modelName — performance history for a model */
router.get('/test/results/:modelName', async (req, res) => {
  try {
    const snapshots = await HostPerformanceSnapshot.find({
      modelName: req.params.modelName,
      authorityState: { $nin: ['authority_invalidated', 'pending_reconciliation'] }
    }).sort({ testedAt: -1 }).lean();
    res.json({ status: 'success', data: { modelName: req.params.modelName, snapshots, total: snapshots.length } });
  } catch (err) { res.status(500).json({ status: 'error', message: err.message }); }
});

module.exports = router;
