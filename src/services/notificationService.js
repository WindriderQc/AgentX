/**
 * Notification Service
 *
 * Handles external notifications via multiple channels:
 * - Email (SMTP via nodemailer)
 * - Slack (webhook)
 * - Generic webhooks
 */

const logger = require('../../config/logger');

class NotificationService {
  constructor() {
    this.config = {
      email: {
        enabled: process.env.EMAIL_ENABLED === 'true',
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        },
        from: process.env.SMTP_FROM || 'alerts@agentx.local'
      },
      slack: {
        enabled: process.env.SLACK_ENABLED === 'true',
        webhookUrl: process.env.SLACK_WEBHOOK_URL
      },
      webhook: {
        enabled: process.env.WEBHOOK_ENABLED === 'true',
        url: process.env.WEBHOOK_URL,
        method: process.env.WEBHOOK_METHOD || 'POST',
        headers: this._parseHeaders(process.env.WEBHOOK_HEADERS),
        timeoutMs: parseInt(process.env.WEBHOOK_TIMEOUT_MS || '5000'),
        retry: {
          maxAttempts: parseInt(process.env.WEBHOOK_RETRY_MAX_ATTEMPTS || '3'),
          baseDelayMs: parseInt(process.env.WEBHOOK_RETRY_BASE_DELAY_MS || '500'),
          jitterMs: parseInt(process.env.WEBHOOK_RETRY_JITTER_MS || '250')
        }
      }
    };

    // Lazy load nodemailer only if email is enabled
    this.nodemailer = null;
    if (this.config.email.enabled) {
      try {
        this.nodemailer = require('nodemailer');
        this.transporter = this.nodemailer.createTransport({
          host: this.config.email.host,
          port: this.config.email.port,
          secure: this.config.email.secure,
          auth: this.config.email.auth
        });
        logger.info('[NotificationService] Email notifications enabled');
      } catch (err) {
        logger.error('[NotificationService] Failed to initialize nodemailer', { error: err.message });
        this.config.email.enabled = false;
      }
    }
  }

  _parseHeaders(headersStr) {
    if (!headersStr) return {};
    try {
      return JSON.parse(headersStr);
    } catch {
      // Format: "Key1:Value1,Key2:Value2"
      const headers = {};
      headersStr.split(',').forEach(pair => {
        const [key, value] = pair.split(':').map(s => s.trim());
        if (key && value) headers[key] = value;
      });
      return headers;
    }
  }

  /**
   * Send alert notification to specified channel
   */
  async send(channel, alert) {
    try {
      switch (channel) {
        case 'email':
          return await this.sendEmail(alert);
        case 'slack':
          return await this.sendSlack(alert);
        case 'webhook':
          return await this.sendWebhook(alert);
        default:
          return { sent: false, error: `Unknown channel: ${channel}` };
      }
    } catch (err) {
      logger.error(`[NotificationService] Failed to send to ${channel}`, {
        alertId: alert._id,
        error: err.message
      });
      return { sent: false, error: err.message };
    }
  }

  /**
   * Send email notification
   */
  async sendEmail(alert) {
    if (!this.config.email.enabled) {
      return { sent: false, error: 'Email notifications not enabled' };
    }

    if (!this.transporter) {
      return { sent: false, error: 'Email transporter not initialized' };
    }

    const recipients = alert.emailRecipients || process.env.ALERT_EMAIL_RECIPIENTS;
    if (!recipients) {
      return { sent: false, error: 'No email recipients configured' };
    }

    const mailOptions = {
      from: this.config.email.from,
      to: recipients,
      subject: `[${alert.severity.toUpperCase()}] ${alert.title}`,
      text: this._formatAlertText(alert),
      html: this._formatAlertHtml(alert)
    };

    try {
      const info = await this.transporter.sendMail(mailOptions);
      logger.info('[NotificationService] Email sent', {
        alertId: alert._id,
        messageId: info.messageId
      });
      return { sent: true, messageId: info.messageId };
    } catch (err) {
      logger.error('[NotificationService] Failed to send email', {
        alertId: alert._id,
        error: err.message
      });
      return { sent: false, error: err.message };
    }
  }

  /**
   * Send Slack notification
   */
  async sendSlack(alert) {
    if (!this.config.slack.enabled) {
      return { sent: false, error: 'Slack notifications not enabled' };
    }

    if (!this.config.slack.webhookUrl) {
      return { sent: false, error: 'Slack webhook URL not configured' };
    }

    const payload = {
      text: `*${alert.title}*`,
      attachments: [
        {
          color: this._getSeverityColor(alert.severity),
          fields: [
            {
              title: 'Severity',
              value: alert.severity.toUpperCase(),
              short: true
            },
            {
              title: 'Rule',
              value: alert.ruleName,
              short: true
            },
            {
              title: 'Component',
              value: alert.context?.component || 'N/A',
              short: true
            },
            {
              title: 'Source',
              value: alert.source || 'agentx',
              short: true
            },
            {
              title: 'Message',
              value: alert.message,
              short: false
            }
          ],
          footer: 'AgentX Alert System',
          ts: Math.floor(new Date(alert.createdAt).getTime() / 1000)
        }
      ]
    };

    try {
      const fetch = (await import('node-fetch')).default;
      const response = await fetch(this.config.slack.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Slack API error: ${response.status} ${text}`);
      }

      logger.info('[NotificationService] Slack notification sent', {
        alertId: alert._id
      });
      return { sent: true };
    } catch (err) {
      logger.error('[NotificationService] Failed to send Slack notification', {
        alertId: alert._id,
        error: err.message
      });
      return { sent: false, error: err.message };
    }
  }

  /**
   * Send generic webhook notification
   */
  async sendWebhook(alert) {
    if (!this.config.webhook.enabled) {
      return { sent: false, error: 'Webhook notifications not enabled' };
    }

    if (!this.config.webhook.url) {
      return { sent: false, error: 'Webhook URL not configured' };
    }

    const payload = {
      alert: {
        id: alert._id,
        title: alert.title,
        message: alert.message,
        severity: alert.severity,
        ruleName: alert.ruleName,
        ruleId: alert.ruleId,
        source: alert.source,
        context: alert.context,
        createdAt: alert.createdAt,
        status: alert.status
      },
      timestamp: new Date().toISOString(),
      source: 'agentx'
    };

    try {
      const fetch = (await import('node-fetch')).default;
      const maxAttempts = Math.max(1, this.config.webhook.retry.maxAttempts);
      let lastError = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const response = await this._fetchWithTimeout(fetch, this.config.webhook.url, {
            method: this.config.webhook.method,
            headers: {
              'Content-Type': 'application/json',
              ...this.config.webhook.headers
            },
            body: JSON.stringify(payload)
          }, this.config.webhook.timeoutMs);

          if (!response.ok) {
            const text = await response.text();
            throw new Error(`Webhook error: ${response.status} ${text}`);
          }

          logger.info('[NotificationService] Webhook notification sent', {
            alertId: alert._id,
            url: this.config.webhook.url,
            attempts: attempt
          });
          return { sent: true, statusCode: response.status, attempts: attempt };
        } catch (err) {
          lastError = err.message;
          if (attempt < maxAttempts) {
            const delayMs = this._calculateWebhookRetryDelay(attempt - 1);
            logger.warn('[NotificationService] Webhook retry scheduled', {
              alertId: alert._id,
              attempt,
              nextDelayMs: delayMs,
              error: err.message
            });
            await this._sleep(delayMs);
            continue;
          }
        }
      }

      logger.error('[NotificationService] Failed to send webhook notification', {
        alertId: alert._id,
        error: lastError
      });
      return { sent: false, error: lastError, attempts: maxAttempts, lastError };
    } catch (err) {
      logger.error('[NotificationService] Failed to send webhook notification', {
        alertId: alert._id,
        error: err.message
      });
      return { sent: false, error: err.message, lastError: err.message };
    }
  }

  /**
   * Verify channel configuration
   */
  async verifyChannel(channel) {
    switch (channel) {
      case 'email':
        if (!this.config.email.enabled) {
          return { valid: false, error: 'Email not enabled' };
        }
        if (!this.transporter) {
          return { valid: false, error: 'Transporter not initialized' };
        }
        try {
          await this.transporter.verify();
          return { valid: true };
        } catch (err) {
          return { valid: false, error: err.message };
        }

      case 'slack':
        if (!this.config.slack.enabled) {
          return { valid: false, error: 'Slack not enabled' };
        }
        if (!this.config.slack.webhookUrl) {
          return { valid: false, error: 'Webhook URL not configured' };
        }
        // Send test message
        try {
          const fetch = (await import('node-fetch')).default;
          const response = await fetch(this.config.slack.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'AgentX notification test' })
          });
          return { valid: response.ok, statusCode: response.status };
        } catch (err) {
          return { valid: false, error: err.message };
        }

      case 'webhook':
        if (!this.config.webhook.enabled) {
          return { valid: false, error: 'Webhook not enabled' };
        }
        if (!this.config.webhook.url) {
          return { valid: false, error: 'Webhook URL not configured' };
        }
        return { valid: true, message: 'Configuration valid (not tested)' };

      default:
        return { valid: false, error: `Unknown channel: ${channel}` };
    }
  }

  /**
   * Get configuration status for all channels
   */
  getStatus() {
    return {
      email: {
        enabled: this.config.email.enabled,
        configured: !!(this.config.email.host && this.config.email.auth.user)
      },
      slack: {
        enabled: this.config.slack.enabled,
        configured: !!this.config.slack.webhookUrl
      },
      webhook: {
        enabled: this.config.webhook.enabled,
        configured: !!this.config.webhook.url
      }
    };
  }

  _calculateWebhookRetryDelay(attempt) {
    const baseDelay = this.config.webhook.retry.baseDelayMs;
    const jitterMs = this.config.webhook.retry.jitterMs;
    const backoff = baseDelay * Math.pow(2, attempt);
    const jitter = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
    return backoff + jitter;
  }

  async _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async _fetchWithTimeout(fetch, url, options, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Helper methods for formatting

  _formatAlertText(alert) {
    return `
ALERT: ${alert.title}

Severity: ${alert.severity.toUpperCase()}
Rule: ${alert.ruleName}
Component: ${alert.context?.component || 'N/A'}
Source: ${alert.source || 'agentx'}

Message:
${alert.message}

Details:
- Current Value: ${alert.context?.currentValue}
- Threshold: ${alert.context?.threshold}
- Metric: ${alert.context?.metric || 'N/A'}

Triggered: ${alert.createdAt}
Alert ID: ${alert._id}

---
AgentX Alert System
    `.trim();
  }

  _formatAlertHtml(alert) {
    const severityColor = this._getSeverityColor(alert.severity);
    return `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .header { background-color: ${severityColor}; color: white; padding: 20px; }
    .content { padding: 20px; }
    .field { margin: 10px 0; }
    .label { font-weight: bold; }
    .footer { padding: 20px; color: #666; font-size: 12px; border-top: 1px solid #ddd; }
  </style>
</head>
<body>
  <div class="header">
    <h1>${alert.title}</h1>
    <p>Severity: ${alert.severity.toUpperCase()}</p>
  </div>
  <div class="content">
    <div class="field">
      <span class="label">Rule:</span> ${alert.ruleName}
    </div>
    <div class="field">
      <span class="label">Component:</span> ${alert.context?.component || 'N/A'}
    </div>
    <div class="field">
      <span class="label">Source:</span> ${alert.source || 'agentx'}
    </div>
    <div class="field">
      <span class="label">Message:</span><br>
      ${alert.message}
    </div>
    <div class="field">
      <span class="label">Details:</span>
      <ul>
        <li>Current Value: ${alert.context?.currentValue}</li>
        <li>Threshold: ${alert.context?.threshold}</li>
        <li>Metric: ${alert.context?.metric || 'N/A'}</li>
      </ul>
    </div>
    <div class="field">
      <span class="label">Triggered:</span> ${alert.createdAt}
    </div>
    <div class="field">
      <span class="label">Alert ID:</span> ${alert._id}
    </div>
  </div>
  <div class="footer">
    AgentX Alert System
  </div>
</body>
</html>
    `.trim();
  }

  _getSeverityColor(severity) {
    const colors = {
      critical: '#dc3545',
      high: '#fd7e14',
      medium: '#ffc107',
      low: '#17a2b8',
      info: '#6c757d'
    };
    return colors[severity] || colors.medium;
  }
}

// Singleton instance
let instance = null;

function getNotificationService() {
  if (!instance) {
    instance = new NotificationService();
  }
  return instance;
}

module.exports = { NotificationService, getNotificationService };
