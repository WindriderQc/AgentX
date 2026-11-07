'use strict';

const crypto = require('node:crypto');
const Alert = require('../../models/Alert');
const { fail } = require('./heavyWorkQueueContract');
const { unstartedExpiry } = require('./heavyWorkQueueExpiry');
const { stalled } = require('./heavyWorkQueueAttention');
const { defaultPlanningTimeZone } = require('./planningDateService');
const RULE = 'heavy_work_queue';
const WC = { w: 1, j: true };
const labels = { completed: 'completed', failed: 'échec', cancelled: 'cancelled', uncertain: 'uncertain result', stalled: 'reçu en retard à vérifier' };

function expiryMessage(job, expiry) {
  const zone = defaultPlanningTimeZone();
  const at = new Intl.DateTimeFormat('fr-CA', { timeZone: zone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(expiry.at));
  return `La tâche n’a pas démarré avant la fermeture de sa fenêtre (${at}, ${zone}). Vérifier la demande ${job.id} et choisir une nouvelle fenêtre si le travail reste nécessaire. Cette alerte ne relance aucun travail.`;
}

// The existing Core alert feed is the inbox. Stable Mongo IDs retain delivery
// and acknowledgment across restarts, archive moves and repeated observations.
async function publishJobs(jobs) {
  for (const job of jobs) {
    const expiry = unstartedExpiry(job);
    const stall = stalled(job);
    const outcome = expiry ? 'expired' : stall ? 'stalled' : job.state;
    const urgent = outcome === 'uncertain' || outcome === 'stalled';
    const attention = urgent || outcome === 'failed' || outcome === 'expired';
    // A recovered native receipt can resolve uncertainty before completion.
    if (job.state !== 'uncertain') {
      await Alert.updateMany({ ruleId: RULE, fingerprint: `heavy-work:${job.id}:uncertain`, status: { $in: ['active', 'acknowledged'] } },
        { $set: { status: 'resolved', resolution: { resolved: true, resolvedBy: 'core-queue-receipt',
          resolvedAt: new Date(), resolutionMethod: 'receipt-observed' } } }, { writeConcern: WC });
    }
    for (const code of ['launch_receipt_overdue', 'completion_receipt_overdue']) {
      if (stall?.code === code) continue;
      await Alert.updateMany({ ruleId: RULE, fingerprint: `heavy-work:${job.id}:stalled:${code}`, status: { $in: ['active', 'acknowledged'] } },
        { $set: { status: 'resolved', resolution: { resolved: true, resolvedBy: 'core-queue-receipt', resolvedAt: new Date(), resolutionMethod: 'receipt-observed' } } }, { writeConcern: WC });
    }
    if (!attention && ((!job.dispatchedAt && job.executor?.mode !== 'image-operation') || !labels[outcome])) continue;
    const fingerprint = `heavy-work:${job.id}:${outcome}${expiry ? `:${expiry.at}` : stall ? `:${stall.code}` : ''}`;
    const id = crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 24);
    const changes = { ruleId: RULE, ruleName: 'Heavy work queue', fingerprint,
      severity: urgent ? 'critical' : outcome === 'completed' || outcome === 'cancelled' ? 'info' : 'warning',
      status: 'active', title: `${job.title} — ${expiry ? 'fenêtre expirée sans démarrage' : labels[outcome]}`,
      message: expiry
        ? expiryMessage(job, expiry)
        : stall
        ? `Le reçu ${stall.code === 'launch_receipt_overdue' ? 'de lancement' : 'de fin/libération'} est en retard. Les ressources ${job.hosts?.join(', ') || 'de cette demande'} restent protégées. Vérifier ${job.id} avec son propriétaire ${stall.actor}, sans relancer ni effacer les verrous.`
        : job.state === 'uncertain'
        ? `${job.reason ? `${job.reason}. ` : ''}Check the same receipt before any relaunch. The reservation stays held.`
        : job.state === 'failed'
        ? `La tâche a échoué. Demande ${job.id}. Reçu disponible ; autorité : ${job.releaseReceipt?.authority || 'queue'}. Vérifier ce résultat avant toute relance.`
        : `Completion receipt available. Authority: ${job.releaseReceipt?.authority || 'queue'}.`,
      context: { component: 'heavy-work-queue', relatedEvents: [job.id], additionalData: {
        queueRequestId: job.id, state: outcome, queueState: job.state, source: job.source,
        ...(expiry && { expiry }), ...(stall && { stall }), hosts: job.hosts || [],
        path: '/cluster-schedule', operation: job.operation, receipt: job.releaseReceipt || null
      } }, channels: attention ? ['telegram'] : [],
      firstOccurrence: new Date(expiry?.at || stall?.at || job.updatedAt), lastOccurrence: urgent ? new Date() : new Date(expiry?.at || job.updatedAt) };
    try { await Alert.updateOne({ _id: id }, { $setOnInsert: changes }, { upsert: true, writeConcern: WC }); }
    catch (error) { if (error.code !== 11000) throw error; }
    // Existing active uncertainty notices previously had no external channel.
    // Upgrade only those; acknowledgment and delivered messages stay stable.
    if (urgent) await Alert.updateOne({ _id: id, status: 'active', channels: { $ne: 'telegram' }, 'delivery.telegram.sent': { $ne: true } },
      { $set: { channels: ['telegram'], severity: 'critical', lastOccurrence: new Date() } }, { writeConcern: WC });
  }
}
async function inbox({ offset = 0, limit = 20 } = {}) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw fail('Notification offset/limit invalid');
  // Private report alerts (#835) share this inbox with the queue's own.
  const filter = { ruleId: { $in: [RULE, 'pipeline_report'] }, status: 'active' };
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
  const row = await Alert.findOneAndUpdate({ _id: id, ruleId: { $in: [RULE, 'pipeline_report'] }, status: 'active' }, { $set: {
    status: 'acknowledged', acknowledgment: { acknowledged: true, acknowledgedBy: actor, acknowledgedAt: new Date() }
  } }, { new: true, writeConcern: WC }).lean();
  if (!row) {
    const prior = await Alert.findOne({ _id: id, ruleId: { $in: [RULE, 'pipeline_report'] }, status: 'acknowledged' }).lean();
    if (!prior) throw fail('Active queue notification not found', 404);
  }
  return { id, acknowledged: true, authority: 'core.alerts' };
}
module.exports = { publishJobs, inbox, acknowledge, RULE };
