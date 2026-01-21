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
        webhookUrl: process.env.SLACK_WEBHOOK_URL,
        retry: {
          maxAttempts: parseInt(process.env.SLACK_RETRY_MAX_ATTEMPTS || '3'),
          baseDelayMs: parseInt(process.env.SLACK_RETRY_BASE_DELAY_MS || '500'),
          jitterMs: parseInt(process.env.SLACK_RETRY_JITTER_MS || '250')
        }
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
    // Handle null/undefined alert
    if (!alert) {
      return { context: {}, delivery: {} };
    }

    const base = typeof alert?.toObject === 'function' ? alert.toObject() : { ...alert };
    return {
      ...base,
      context: base.context || alert?.context || {},
      delivery: base.delivery || alert?.delivery || {}
    };
  }

  _getTemplateValue(data, key) {
    if (!key) return '';
    const parts = key.split('.');
    // Limit depth to prevent deep traversal that could expose sensitive properties
    const MAX_DEPTH = 3;
    if (parts.length > MAX_DEPTH) {
      return '';
    }
    let value = data;
    for (const part of parts) {
      // Block access to prototype-related or internal properties
      if (part === '__proto__' || part === 'constructor' || part === 'prototype') {
        return '';
      }
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
      // Optimize for primitive arrays - no need to recurse
      if (template.length > 0 && typeof template[0] !== 'object') {
        return template.map(item => 
          typeof item === 'string' ? this._renderTemplate(item, data) : item
        );
      }
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
      : `[${(alert.severity?.toUpperCase() || 'UNKNOWN')}] ${alert.title}`;

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
   * Get fetch implementation
   */
  async _getFetch() {
    return (await import('node-fetch')).default;
  }

  /**
   * Shared retry logic for external requests
   */
  async _sendWithRetry(url, options, retryConfig, context = {}) {
     const maxAttempts = Math.max(1, retryConfig.maxAttempts);
     let lastError = null;
     const fetch = await this._getFetch();

     for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
       try {
         const response = await this._fetchWithTimeout(fetch, url, options, this.config.webhook.timeoutMs);

         if (!response.ok) {
           const text = await response.text();
           throw new Error(`API error: ${response.status} ${text}`);
         }

         logger.info('[NotificationService] Notification sent', {
           ...context,
           url,
           attempts: attempt
         });

         return { sent: true, statusCode: response.status, attempts: attempt };
       } catch (err) {
         lastError = err.message;
         if (attempt < maxAttempts) {
           const delayMs = this._calculateRetryDelay(attempt - 1, retryConfig);
           logger.warn('[NotificationService] Retry scheduled', {
             ...context,
             attempt,
             nextDelayMs: delayMs,
             error: err.message
           });
           await this._sleep(delayMs);
           continue;
         }
       }
     }

     logger.error('[NotificationService] Failed to send notification after retries', {
       ...context,
       url,
       error: lastError
     });
     return { sent: false, error: lastError, attempts: maxAttempts, lastError };
  }

  _calculateRetryDelay(attempt, retryConfig) {
    const baseDelay = retryConfig.baseDelayMs !== undefined ? retryConfig.baseDelayMs : 500;
    const jitterMs = retryConfig.jitterMs !== undefined ? retryConfig.jitterMs : 250;
    const backoff = baseDelay * Math.pow(2, attempt);
    const jitter = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
    return backoff + jitter;
  }

  // Keeping the old method for backward compatibility if any test calls it directly
  _calculateWebhookRetryDelay(attempt) {
      return this._calculateRetryDelay(attempt, this.config.webhook.retry);
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

    return await this._sendWithRetry(
        this.config.slack.webhookUrl,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        },
        this.config.slack.retry,
        { alertId: alert._id, channel: 'slack' }
    );
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

    return await this._sendWithRetry(
        webhookConfig.url,
        {
            method: webhookConfig.method,
            headers: {
              'Content-Type': 'application/json',
              ...webhookConfig.headers
            },
            body: JSON.stringify(payload)
        },
        this.config.webhook.retry,
        { alertId: alert._id, channel: 'webhook' }
    );
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
          const fetch = await this._getFetch();
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
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; }
    .header { background-color: ${severityColor}; color: white; padding: 20px; border-radius: 5px 5px 0 0; }
    .content { padding: 20px; border: 1px solid #ddd; border-top: none; background: #fff; }
    .field { margin: 10px 0; }
    .label { font-weight: bold; color: #555; }
    .footer { padding: 20px; color: #888; font-size: 12px; text-align: center; background: #f9f9f9; border: 1px solid #ddd; border-top: none; border-radius: 0 0 5px 5px; }
    .details-box { background: #f5f5f5; padding: 10px; border-radius: 4px; margin-top: 5px; }
    ul { margin: 0; padding-left: 20px; }
    .alert-id { font-family: monospace; color: #666; }
  </style>
</head>
<body>
  <div class="header">
    <h1 style="margin:0; font-size: 24px;">${alert.title}</h1>
    <p style="margin:5px 0 0 0; opacity: 0.9;">Severity: ${alert.severity.toUpperCase()}</p>
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
    <div class="field" style="margin-top: 20px;">
      <span class="label">Message:</span><br>
      <div style="font-size: 1.1em; color: #000;">${alert.message}</div>
    </div>
    <div class="field">
      <span class="label">Details:</span>
      <div class="details-box">
        <ul>
          <li><strong>Current Value:</strong> ${alert.context?.currentValue}</li>
          <li><strong>Threshold:</strong> ${alert.context?.threshold}</li>
          <li><strong>Metric:</strong> ${alert.context?.metric || 'N/A'}</li>
        </ul>
      </div>
    </div>
    <div class="field" style="margin-top: 20px; border-top: 1px solid #eee; padding-top: 10px;">
      <span class="label">Triggered:</span> ${alert.createdAt}<br>
      <span class="label">Alert ID:</span> <span class="alert-id">${alert._id}</span>
    </div>
  </div>
  <div class="footer">
    Sent by <strong>AgentX Alert System</strong><br>
    <a href="#" style="color: #666; text-decoration: none;">View in Dashboard</a>
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
        } catch (err) {
          logger.warn('[NotificationService] Failed to parse webhook template as JSON, falling back to text payload', {
            error: err && err.message ? err.message : String(err),
            alertId: alert && alert._id ? alert._id : undefined
          });
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
