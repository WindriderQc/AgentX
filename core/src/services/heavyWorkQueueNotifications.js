'use strict';

const crypto = require('node:crypto');
const Alert = require('../../models/Alert');
const { fail } = require('./heavyWorkQueueContract');
const RULE = 'heavy_work_queue';
const WC = { w: 1, j: true };
const labels = { completed: 'terminé', failed: 'échoué', cancelled: 'annulé', uncertain: 'résultat incertain' };

// The existing Core alert feed is the inbox. Stable Mongo IDs retain delivery
// and acknowledgment across restarts, archive moves and repeated observations.
async function publishJobs(jobs) {
  for (const job of jobs) {
    if ((!job.dispatchedAt && job.executor?.mode !== 'image-operation') || !labels[job.state]) continue;
    const fingerprint = `heavy-work:${job.id}:${job.state}`;
    const id = crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 24);
    const changes = { ruleId: RULE, ruleName: 'Heavy work queue', fingerprint,
      severity: job.state === 'completed' || job.state === 'cancelled' ? 'info' : 'warning',
      status: 'active', title: `${job.title} — ${labels[job.state]}`,
      message: job.state === 'uncertain'
        ? 'Consulte le même reçu avant toute relance. La réservation reste retenue.'
        : `Reçu de fin disponible. Autorité : ${job.releaseReceipt?.authority || 'queue'}.`,
      context: { component: 'heavy-work-queue', relatedEvents: [job.id], additionalData: {
        queueRequestId: job.id, state: job.state, source: job.source,
        path: '/cluster-schedule', operation: job.operation, receipt: job.releaseReceipt || null
      } }, channels: [], firstOccurrence: new Date(job.updatedAt), lastOccurrence: new Date(job.updatedAt) };
    try { await Alert.updateOne({ _id: id }, { $setOnInsert: changes }, { upsert: true, writeConcern: WC }); }
    catch (error) { if (error.code !== 11000) throw error; }
    if (job.state !== 'uncertain') {
      await Alert.updateMany({ ruleId: RULE, fingerprint: `heavy-work:${job.id}:uncertain`, status: { $in: ['active', 'acknowledged'] } },
        { $set: { status: 'resolved', resolution: { resolved: true, resolvedBy: 'core-queue-receipt',
          resolvedAt: new Date(), resolutionMethod: 'terminal-receipt' } } }, { writeConcern: WC });
    }
  }
}
async function inbox({ offset = 0, limit = 20 } = {}) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw fail('Notification offset/limit invalid');
  const filter = { ruleId: RULE, status: 'active' };
  const [rows, count] = await Promise.all([
    Alert.find(filter).sort({ lastOccurrence: -1, _id: 1 }).skip(offset).limit(limit).lean(), Alert.countDocuments(filter)
  ]);
  return { authority: 'core.alerts', count, offset, limit, notifications: rows.map(row => ({
    id: String(row._id), title: row.title, message: row.message, severity: row.severity,
    at: row.lastOccurrence, ...row.context.additionalData
  })) };
}
async function acknowledge(id, actor) {
  if (!/^[a-f0-9]{24}$/.test(id || '')) throw fail('Exact notification id required');
  const row = await Alert.findOneAndUpdate({ _id: id, ruleId: RULE, status: 'active' }, { $set: {
    status: 'acknowledged', acknowledgment: { acknowledged: true, acknowledgedBy: actor, acknowledgedAt: new Date() }
  } }, { new: true, writeConcern: WC }).lean();
  if (!row) {
    const prior = await Alert.findOne({ _id: id, ruleId: RULE, status: 'acknowledged' }).lean();
    if (!prior) throw fail('Active queue notification not found', 404);
  }
  return { id, acknowledged: true, authority: 'core.alerts' };
}
module.exports = { publishJobs, inbox, acknowledge, RULE };
