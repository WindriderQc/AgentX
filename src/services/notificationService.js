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
    this.testMode = process.env.ALERT_TEST_MODE === 'true';
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
        from: process.env.ALERT_EMAIL_FROM || process.env.SMTP_FROM || 'alerts@agentx.local'
      },
      slack: {
        enabled: process.env.SLACK_ENABLED === 'true',
        webhookUrl: process.env.SLACK_WEBHOOK_URL
      },
      webhook: {
        enabled: process.env.WEBHOOK_ENABLED === 'true',
        url: process.env.WEBHOOK_URL,
        method: process.env.WEBHOOK_METHOD || 'POST',
        headers: this._parseHeaders(process.env.WEBHOOK_HEADERS)
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

  _normalizeHeaders(headers) {
    if (!headers) return {};
    if (typeof headers === 'string') {
      return this._parseHeaders(headers);
    }
    if (typeof headers === 'object') {
      return headers;
    }
    return {};
  }

  _buildTemplateData(alert) {
    const base = typeof alert?.toObject === 'function' ? alert.toObject() : { ...alert };
    return {
      ...base,
      context: base.context || alert.context || {},
      delivery: base.delivery || alert.delivery || {}
    };
  }

  _getTemplateValue(data, key) {
    if (!key) return '';
    const parts = key.split('.');
    let value = data;
    for (const part of parts) {
      if (value && Object.prototype.hasOwnProperty.call(value, part)) {
        value = value[part];
      } else {
        return '';
      }
    }
    return value === null || value === undefined ? '' : value;
  }

  _renderTemplate(template, data) {
    if (!template) return '';
    return String(template).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
      const value = this._getTemplateValue(data, key);
      return value === undefined || value === null ? '' : String(value);
    });
  }

  _applyTemplateObject(template, data) {
    if (Array.isArray(template)) {
      return template.map(item => this._applyTemplateObject(item, data));
    }
    if (template && typeof template === 'object') {
      return Object.entries(template).reduce((acc, [key, value]) => {
        acc[key] = this._applyTemplateObject(value, data);
        return acc;
      }, {});
    }
    if (typeof template === 'string') {
      return this._renderTemplate(template, data);
    }
    return template;
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
    if (this.testMode) {
      const recipients = this._resolveEmailRecipients(alert);
      return { sent: true, messageId: 'test-mode', recipients };
    }

    if (!this.config.email.enabled) {
      return { sent: false, error: 'Email notifications not enabled' };
    }

    if (!this.transporter) {
      return { sent: false, error: 'Email transporter not initialized' };
    }

    const recipients = this._resolveEmailRecipients(alert);
    if (!recipients) {
      return { sent: false, error: 'No email recipients configured' };
    }

    const templateData = this._buildTemplateData(alert);
    const subjectTemplate = alert.channelConfig?.email?.subject;
    const subject = subjectTemplate
      ? this._renderTemplate(subjectTemplate, templateData)
      : `[${alert.severity.toUpperCase()}] ${alert.title}`;

    const fromAddress = alert.channelConfig?.email?.from || this.config.email.from;
    const replyTo = alert.channelConfig?.email?.replyTo;
    const mailOptions = {
      from: fromAddress,
      replyTo,
      to: recipients,
      subject,
      text: this._formatAlertText(alert),
      html: this._formatAlertHtml(alert)
    };

    try {
      const info = await this.transporter.sendMail(mailOptions);
      logger.info('[NotificationService] Email sent', {
        alertId: alert._id,
        messageId: info.messageId
      });
      return { sent: true, messageId: info.messageId, recipients };
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
    if (this.testMode) {
      return { sent: true };
    }

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
    if (this.testMode) {
      const webhookConfig = this._resolveWebhookConfig(alert);
      return { sent: true, statusCode: 200, url: webhookConfig.url };
    }

    if (!this.config.webhook.enabled) {
      return { sent: false, error: 'Webhook notifications not enabled' };
    }

    const webhookConfig = this._resolveWebhookConfig(alert);
    if (!webhookConfig.url) {
      return { sent: false, error: 'Webhook URL not configured' };
    }

    const payload = this._buildWebhookPayload(alert, webhookConfig.template);

    try {
      const fetch = (await import('node-fetch')).default;
      const response = await fetch(webhookConfig.url, {
        method: webhookConfig.method,
        headers: {
          'Content-Type': 'application/json',
          ...webhookConfig.headers
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Webhook error: ${response.status} ${text}`);
      }

      logger.info('[NotificationService] Webhook notification sent', {
        alertId: alert._id,
        url: webhookConfig.url
      });
      return { sent: true, statusCode: response.status, url: webhookConfig.url };
    } catch (err) {
      logger.error('[NotificationService] Failed to send webhook notification', {
        alertId: alert._id,
        error: err.message
      });
      return { sent: false, error: err.message };
    }
  }

  /**
   * Verify channel configuration
   */
  async verifyChannel(channel) {
    switch (channel) {
      case 'email':
        if (this.testMode) {
          return { valid: true, message: 'Test mode enabled' };
        }
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
        if (this.testMode) {
          return { valid: true, message: 'Test mode enabled' };
        }
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
        if (this.testMode) {
          return { valid: true, message: 'Test mode enabled' };
        }
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

  _resolveEmailRecipients(alert) {
    const recipients = alert.channelConfig?.email?.recipients || alert.emailRecipients || process.env.ALERT_EMAIL_RECIPIENTS;
    if (Array.isArray(recipients)) {
      return recipients.filter(Boolean).join(', ');
    }
    return recipients;
  }

  _resolveWebhookConfig(alert) {
    const normalizedHeaders = this._normalizeHeaders(alert.channelConfig?.webhook?.headers);
    const resolvedHeaders = Object.keys(normalizedHeaders || {}).length > 0
      ? normalizedHeaders
      : this.config.webhook.headers;
    return {
      url: alert.channelConfig?.webhook?.url || this.config.webhook.url,
      method: alert.channelConfig?.webhook?.method || this.config.webhook.method,
      headers: resolvedHeaders,
      template: alert.channelConfig?.webhook?.template
    };
  }

  _buildWebhookPayload(alert, template) {
    const templateData = this._buildTemplateData(alert);
    if (template) {
      if (typeof template === 'string') {
        const rendered = this._renderTemplate(template, templateData);
        try {
          return JSON.parse(rendered);
        } catch {
          return { text: rendered };
        }
      }
      if (typeof template === 'object') {
        return this._applyTemplateObject(template, templateData);
      }
    }

    return {
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
