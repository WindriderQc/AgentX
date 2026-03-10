/**
 * Self-Healing Helpers
 *
 * Pure utility functions and metric-fetching logic extracted from
 * selfHealingEngine.js. No class dependency — all functions are standalone.
 *
 * Used by: selfHealingEngine.js
 */

'use strict';

const MetricsSnapshot = require('../../models/MetricsSnapshot');
const logger = require('../../config/logger');

// ── Time parsing ──────────────────────────────────────────────

const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000; // 15 min

function parseTimeWindow(window, defaultCooldownMs = DEFAULT_COOLDOWN_MS) {
  if (!window) return defaultCooldownMs;
  const match = window.match(/^(\d+)([smhd])$/);
  if (!match) return defaultCooldownMs;
  const value = parseInt(match[1], 10);
  const multipliers = { s: 1000, m: 60 * 1000, h: 3600 * 1000, d: 86400 * 1000 };
  return value * (multipliers[match[2]] || 1000);
}

function checkTimeWindow(timeWindow) {
  const now = new Date();
  const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
  if (timeWindow.start > timeWindow.end) {
    return currentTime >= timeWindow.start || currentTime <= timeWindow.end;
  }
  return currentTime >= timeWindow.start && currentTime <= timeWindow.end;
}

// ── Threshold evaluation ──────────────────────────────────────

function checkThreshold(value, threshold, comparison) {
  if (value === null || value === undefined) return false;
  const numericValue     = typeof value     === 'number' ? value     : null;
  const numericThreshold = typeof threshold === 'number' ? threshold : null;
  const maybeSecondsToMs =
    numericValue !== null && numericThreshold !== null &&
    numericValue > 0 && numericValue < 10 && numericThreshold >= 100;

  switch (comparison) {
    case 'greater_than':
      return (numericValue !== null && numericThreshold !== null && numericValue > numericThreshold) ||
             (maybeSecondsToMs && (numericValue * 1000) > numericThreshold);
    case 'less_than':
      return (numericValue !== null && numericThreshold !== null && numericValue < numericThreshold) ||
             (maybeSecondsToMs && (numericValue * 1000) < numericThreshold);
    case 'equals':
    case 'equal':
      return value === threshold;
    case 'not_equals':
      return value !== threshold;
    case 'greater_or_equal':
      return value >= threshold;
    case 'less_or_equal':
      return value <= threshold;
    default:
      return false;
  }
}

// ── Metric type / priority mapping ───────────────────────────

function mapMetricToType(metricName) {
  const typeMap = {
    health_status: 'health', avg_response_time: 'performance',
    tokens_per_second: 'performance', error_rate: 'quality',
    positive_rate: 'quality', quality_score: 'quality',
    daily_cost: 'cost', memory_percentage: 'resource',
    disk_usage_percentage: 'resource', connection_pool_usage: 'resource'
  };
  return typeMap[metricName] || 'usage';
}

function mapPriorityToSeverity(priority) {
  if (priority === 1) return 'critical';
  if (priority === 2) return 'error';
  if (priority === 3) return 'warning';
  return 'info';
}

// ── Notification message formatting ──────────────────────────

function formatNotificationMessage(rule, eventType, context) {
  const { remediation } = rule;
  switch (eventType) {
    case 'onTrigger':
      return `🚨 Self-healing rule triggered: ${rule.description}\nAction: ${remediation.action}\nStrategy: ${remediation.strategy}`;
    case 'onSuccess':
      return `✅ Remediation successful: ${rule.description}\nAction completed: ${remediation.action}\nDuration: ${context.duration}ms`;
    case 'onFailure':
      return `❌ Remediation failed: ${rule.description}\nAction: ${remediation.action}\nError: ${context.error}`;
    default:
      return rule.description;
  }
}

// ── Metrics fetching ──────────────────────────────────────────

async function fetchMetrics(detectionQuery, { defaultCooldownMs = DEFAULT_COOLDOWN_MS } = {}) {
  const { metric, componentPattern, window, aggregation } = detectionQuery;
  const windowMs   = parseTimeWindow(window, defaultCooldownMs);
  const startTime  = new Date(Date.now() - windowMs);

  const query = {
    timestamp: { $gte: startTime },
    type: mapMetricToType(metric)
  };

  if (componentPattern && componentPattern !== '*' && typeof componentPattern === 'string' && componentPattern.length < 200) {
    const escapedPattern = componentPattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    query.componentId = new RegExp('^' + escapedPattern + '$');
  }

  let metrics = await MetricsSnapshot.find(query).sort({ timestamp: -1 }).limit(200);

  if (metric && metrics.length > 0) {
    const metricMatched = metrics.filter(m => {
      const configured     = String(metric).toLowerCase();
      const metadataMetric = String(m?.metadata?.metric || m?.metadata?.metricName || m?.metadata?.metricKey || '').toLowerCase();
      return metadataMetric && metadataMetric === configured;
    });
    if (metricMatched.length > 0) metrics = metricMatched;
  }

  if (metrics.length === 0) return { value: null, count: 0 };

  const values = metrics.map(m => m.value);
  let value;
  switch (aggregation) {
    case 'avg':   value = values.reduce((s, v) => s + v, 0) / values.length; break;
    case 'sum':   value = values.reduce((s, v) => s + v, 0); break;
    case 'max':   value = Math.max(...values); break;
    case 'min':   value = Math.min(...values); break;
    case 'count': value = values.length; break;
    default:      value = values[0];
  }

  return {
    value, count: metrics.length,
    componentId: metrics[0]?.componentId,
    component:   metrics[0]?.componentId,
    timestamp:   metrics[0]?.timestamp
  };
}

async function countRecentOccurrences(rule, window, { defaultCooldownMs = DEFAULT_COOLDOWN_MS } = {}) {
  const { detectionQuery } = rule;
  const windowMs   = parseTimeWindow(window || detectionQuery?.window || '15m', defaultCooldownMs);
  const startTime  = new Date(Date.now() - windowMs);

  const query = {
    timestamp: { $gte: startTime },
    type: mapMetricToType(detectionQuery?.metric)
  };

  if (detectionQuery?.componentPattern && detectionQuery.componentPattern !== '*') {
    const escapedPattern = detectionQuery.componentPattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    query.componentId = new RegExp('^' + escapedPattern + '$');
  }

  const docs = await MetricsSnapshot.find(query).sort({ timestamp: -1 }).limit(500);
  if (!docs || docs.length === 0) return 0;

  let sourceDocs = docs;
  if (detectionQuery?.metric) {
    const metricMatched = docs.filter(doc => {
      const configured     = String(detectionQuery.metric).toLowerCase();
      const metadataMetric = String(doc?.metadata?.metric || doc?.metadata?.metricName || doc?.metadata?.metricKey || '').toLowerCase();
      return metadataMetric && metadataMetric === configured;
    });
    if (metricMatched.length > 0) sourceDocs = metricMatched;
  }

  return sourceDocs.filter(doc =>
    checkThreshold(doc.value, detectionQuery?.threshold, detectionQuery?.comparison)
  ).length;
}

module.exports = {
  DEFAULT_COOLDOWN_MS,
  parseTimeWindow,
  checkTimeWindow,
  checkThreshold,
  mapMetricToType,
  mapPriorityToSeverity,
  formatNotificationMessage,
  fetchMetrics,
  countRecentOccurrences
};
