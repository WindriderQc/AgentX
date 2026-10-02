'use strict';

/**
 * Alert delivery channels Core knows. AlertRule and Alert share this list so a
 * rule can never carry a channel that the Alert model later rejects: an
 * unknown channel (for example the aiOPs-era `dataapi_log`) made every alert
 * of its rule fail validation, silently, from 2026-09-20 to 2026-09-27.
 */
const logger = require('../config/logger');

const ALERT_CHANNELS = Object.freeze(['email', 'slack', 'telegram', 'webhook', 'local_log']);

/**
 * Keep the known channels of a rule, in order and without duplicates. Unknown
 * ones are dropped with a warning so the alert is still stored; an empty
 * result falls back to the local log.
 */
function sanitizeAlertChannels(channels, ruleId = null) {
  const list = Array.isArray(channels) ? channels : [];
  const kept = [...new Set(list.filter(channel => ALERT_CHANNELS.includes(channel)))];
  const dropped = list.filter(channel => !ALERT_CHANNELS.includes(channel));
  if (dropped.length > 0) {
    logger.warn('[AlertService] Dropping unknown alert channels', { ruleId, dropped });
  }
  return kept.length > 0 ? kept : ['local_log'];
}

module.exports = { ALERT_CHANNELS, sanitizeAlertChannels };
