const Alert = require('../../models/Alert');
const logger = require('../../config/logger');
const EventEmitter = require('events');

class AlertService extends EventEmitter {
  constructor() {
    super();
    this.rules = [];
    this.config = {
      email: { enabled: false },
      slack: { enabled: false },
      webhook: { enabled: false },
      dataapi: { enabled: true, url: process.env.DATAAPI_URL },
      cooldownMs: 300000, // 5 minutes
      maxOccurrences: 10
    };
    this.testMode = process.env.NODE_ENV === 'test';
  }

  loadRules(rules) {
    this.rules = rules || [];
    return this.rules.length;
  }

  async evaluateEvent(event) {
    // Basic implementation: check against loaded rules
    // For now, just return empty array as we don't have rules logic fully defined here
    // In a real implementation, this would match event against this.rules
    return [];
  }

  async _sendNotifications(alert, channels) {
    const results = {};
    
    for (const channel of channels) {
      try {
        if (channel === 'dataapi_log') {
           logger.info(`[AlertService] Sending to DataAPI Log: ${alert.title}`);
           // In real impl, might call external API
           results[channel] = { sent: true };
        } else {
           logger.warn(`[AlertService] Channel ${channel} not implemented`);
           results[channel] = { sent: false, error: 'Not implemented' };
        }
      } catch (err) {
        logger.error(`[AlertService] Failed to send to ${channel}`, err);
        results[channel] = { sent: false, error: err.message };
      }
    }
    
    // Update alert delivery status
    // We need to update the alert document with the results
    try {
        const updates = {};
        for (const [channel, result] of Object.entries(results)) {
            updates[`delivery.${channel}.sent`] = result.sent;
            updates[`delivery.${channel}.sentAt`] = new Date();
            if (result.error) {
                updates[`delivery.${channel}.error`] = result.error;
            }
        }
        await Alert.findByIdAndUpdate(alert._id, { $set: updates });
    } catch (err) {
        logger.error('[AlertService] Failed to update alert delivery status', err);
    }

    return results;
  }

  async acknowledgeAlert(id, userId, comment) {
    const alert = await Alert.findById(id);
    if (!alert) throw new Error('Alert not found');
    return alert.acknowledge(userId, comment);
  }

  async resolveAlert(id, userId, method, resolution) {
    const alert = await Alert.findById(id);
    if (!alert) throw new Error('Alert not found');
    return alert.resolve(userId, method, resolution);
  }

  async getStatistics(filters) {
    return Alert.getStatistics(filters);
  }

  // Legacy support
  triggerAlert(type, severity, payload) {
      logger.warn('Alert triggered (legacy)', { type, severity, payload });
      return { type, severity, payload };
  }
}

// Singleton instance
const alertService = new AlertService();

// Backward compatibility for { getAlertService } destructuring
alertService.getAlertService = () => alertService;

module.exports = alertService;
