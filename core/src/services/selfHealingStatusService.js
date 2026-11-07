'use strict';

// Read existing configuration and evidence only. Never call health probes,
// rule synchronization, reconciliation, notification delivery or runtime APIs.
const HostPreference = require('../../models/HostPreference');
const AlertRule = require('../../models/AlertRule');
const Alert = require('../../models/Alert');
const InferenceLog = require('../../models/InferenceLog');
const { projectSelfHealing } = require('./selfHealingProjection');

const MAX_CONFIG_ROWS = 200;
const MAX_TIME_MS = 5000;

async function boundedRead(Model, fields, sort) {
  const rows = await Model.find().select(fields).sort(sort).limit(MAX_CONFIG_ROWS + 1)
    .maxTimeMS(MAX_TIME_MS).lean();
  return { rows: rows.slice(0, MAX_CONFIG_ROWS), truncated: rows.length > MAX_CONFIG_ROWS };
}

async function latestAlerts() {
  // Group before limiting: a noisy rule cannot hide every other detector.
  // Mixed context/delivery payloads and channel credentials never cross this boundary.
  return Alert.aggregate([
    { $project: { ruleId: 1, status: 1, source: 1, 'context.metric': 1,
      timestamp: { $ifNull: ['$lastOccurrence', '$createdAt'] },
      localDelivery: { sent: '$delivery.local_log.sent', sentAt: '$delivery.local_log.sentAt' } } },
    { $sort: { timestamp: -1, _id: -1 } },
    { $group: { _id: '$ruleId', alert: { $first: '$$ROOT' } } },
    { $sort: { _id: 1 } },
    { $limit: MAX_CONFIG_ROWS + 1 }
  ]).option({ maxTimeMS: MAX_TIME_MS });
}

async function latestLocalDelivery() {
  return Alert.findOne({ 'delivery.local_log.sentAt': { $type: 'date' } })
    .select('_id ruleId delivery.local_log.sent delivery.local_log.sentAt')
    .sort({ 'delivery.local_log.sentAt': -1, _id: -1 }).maxTimeMS(MAX_TIME_MS).lean();
}

async function latestFallback() {
  const row = await InferenceLog.findOne({ fallbackUsed: true })
    .select('_id timestamp status host hostKey fallbackUsed fallbackReason taskType routedHostUrl')
    .sort({ timestamp: -1, _id: -1 }).maxTimeMS(MAX_TIME_MS).lean();
  return require('./routing/inferenceLogReadProjection').projectInferenceLog(row);
}

function defaultReaders() {
  return {
    pins: () => boundedRead(HostPreference, 'hostUrl hostKey displayName pinnedModels pinnedModel defaultModels autoRestore keepAlive contextSize', { hostKey: 1, _id: 1 }),
    rules: () => boundedRead(AlertRule, 'ruleId name enabled builtIn channels', { ruleId: 1 }),
    alerts: latestAlerts,
    delivery: latestLocalDelivery,
    fallback: latestFallback,
    ladders: () => require('./routing/taskFallbackLadder').getTaskFallbackStats(),
    watchdog: () => require('./ollamaWatchdogService').getStats(),
    pinDaemon: () => require('./hostHealthDaemon').getHealthCheckState(),
    watchSettings: () => require('./opsWatchSettings').effective(),
    watch: () => {
      const watch = require('./opsWatchService').getOpsWatch();
      return { state: watch.state(), latest: watch.latest() };
    },
    engine: () => (require('./alertService').rules || []).map(rule => ({ id: rule.id })),
    notifications: () => require('./notificationService').getNotificationService().getStatus()
  };
}

async function getSelfHealingStatus({ readers = defaultReaders(), now = new Date() } = {}) {
  const entries = Object.entries(readers);
  const settled = await Promise.allSettled(entries.map(([, read]) => Promise.resolve().then(read)));
  const sources = Object.fromEntries(entries.map(([key], index) => [key,
    settled[index].status === 'fulfilled'
      ? { value: settled[index].value }
      : { unavailable: true }]));
  return projectSelfHealing(sources, now);
}

module.exports = { getSelfHealingStatus, MAX_CONFIG_ROWS };
