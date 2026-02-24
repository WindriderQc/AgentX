/**
 * Roundtable Notifier
 * Sends completion/failure notifications via Slack webhooks and generic webhooks.
 * Integrates with existing NotificationService for retry logic.
 */

const fetch = require('node-fetch');
const logger = require('../../../config/logger');

let notificationService = null;
try {
  const { getNotificationService } = require('../notificationService');
  notificationService = getNotificationService();
} catch {
  logger.warn('NotificationService not available — roundtable notifications disabled');
}

/**
 * Send roundtable completion notification
 * @param {Object} doc - Roundtable Mongoose document
 * @param {Object} notifyConfig - { slack?: string, webhook?: string }
 */
async function notifyCompletion(doc, notifyConfig) {
  if (!notifyConfig) return;

  const durationSec = doc.totalDurationMs ? (doc.totalDurationMs / 1000).toFixed(1) : '?';
  const turnsCount = (doc.turns || []).length;
  const question = doc.question.substring(0, 200);
  const status = doc.status;

  const results = [];

  // Slack webhook
  if (notifyConfig.slack) {
    results.push(sendSlackNotification(notifyConfig.slack, { question, status, durationSec, turnsCount, doc }));
  }

  // Generic webhook
  if (notifyConfig.webhook) {
    results.push(sendWebhookNotification(notifyConfig.webhook, { question, status, durationSec, turnsCount, doc }));
  }

  const settled = await Promise.allSettled(results);
  const failures = settled.filter(r => r.status === 'rejected');
  if (failures.length > 0) {
    logger.warn('Some roundtable notifications failed', {
      roundtableId: doc._id,
      failures: failures.map(f => f.reason?.message || 'unknown')
    });
  }
}

async function sendSlackNotification(webhookUrl, { question, status, durationSec, turnsCount, doc }) {
  const emoji = status === 'completed' ? ':white_check_mark:' : ':x:';
  const color = status === 'completed' ? '#4ade80' : '#f87171';

  // Get first sentence of synthesis
  let verdict = '';
  if (doc.synthesis?.response) {
    verdict = doc.synthesis.response.split(/[.!?]\s/)[0].substring(0, 200);
  }

  const payload = {
    text: `${emoji} Roundtable ${status}`,
    attachments: [{
      color,
      fields: [
        { title: 'Question', value: question, short: false },
        { title: 'Status', value: status, short: true },
        { title: 'Duration', value: `${durationSec}s`, short: true },
        { title: 'Turns', value: `${turnsCount}`, short: true },
        ...(verdict ? [{ title: 'Verdict', value: verdict, short: false }] : [])
      ]
    }]
  };

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    throw new Error(`Slack webhook failed: ${res.status}`);
  }

  logger.info('Roundtable Slack notification sent', { roundtableId: doc._id });
}

async function sendWebhookNotification(webhookUrl, { question, status, durationSec, turnsCount, doc }) {
  const payload = {
    event: 'roundtable.completed',
    roundtableId: doc._id,
    question,
    status,
    durationSec: parseFloat(durationSec),
    turnsCount,
    rounds: doc.rounds,
    synthesis: doc.synthesis?.response || null,
    completedAt: doc.completedAt || new Date().toISOString()
  };

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    throw new Error(`Webhook failed: ${res.status}`);
  }

  logger.info('Roundtable webhook notification sent', { roundtableId: doc._id });
}

module.exports = { notifyCompletion };
