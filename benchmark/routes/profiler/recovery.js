'use strict';
const router = require('express').Router();
const HostProfile = require('../../models/HostProfile');
const { projectRecovery } = require('../../src/services/profiler/profilerRecoveryReadProjection');
const fields = 'hostId displayName reconciliation.state reconciliation.operationId reconciliation.operation reconciliation.startedAt reconciliation.ownerClaimedAt reconciliation.lastObservedAt reconciliation.serverTerminalObserved reconciliation.serverTerminalAt reconciliation.pendingRequests reconciliation.resolvedAt reconciliation.releaseReceipt.released reconciliation.reason reconciliation.failedAttempts reconciliation.nextAttemptAt reconciliation.operatorRequiredAt';

router.get('/', async (_req, res) => {
  try {
    const now = new Date();
    const [pending, recent] = await Promise.all([
      HostProfile.find({ 'reconciliation.state': { $exists: true, $ne: 'resolved' } }).select(fields).sort({ 'reconciliation.startedAt': 1 }).limit(101).maxTimeMS(2000).lean(),
      HostProfile.find({ 'reconciliation.state': 'resolved', 'reconciliation.resolvedAt': { $gte: new Date(now - 86400000) } }).select(fields).sort({ 'reconciliation.resolvedAt': -1 }).limit(20).maxTimeMS(2000).lean()
    ]);
    res.set('Cache-Control', 'no-store').json({ status: 'success', data: {
      schema: 'agentx.profiler-recovery-view/v1', observedAt: now.toISOString(), truncated: pending.length > 100,
      operations: [...pending.slice(0, 100), ...recent].map(profile => projectRecovery(profile, now)), authorization: 'not_granted'
    } });
  } catch {
    res.status(503).json({ status: 'error', code: 'PROFILER_RECOVERY_VIEW_UNAVAILABLE', message: 'Runtime recovery evidence is unavailable.' });
  }
});
module.exports = router;
