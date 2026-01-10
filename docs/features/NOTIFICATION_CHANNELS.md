# Notification Channels Documentation

**Feature:** External Alert Notifications
**Status:** ✅ COMPLETE
**Date:** 2026-01-08

---

## Overview

AgentX now supports external notification channels for alert delivery, allowing alerts to be sent to:
- **Email** (SMTP via nodemailer)
- **Slack** (webhooks)
- **Generic Webhooks** (custom HTTP endpoints)

This extends the existing `dataapi_log` channel and enables real-time alert delivery to external systems.

---

## Architecture

### Components

**NotificationService** (`/src/services/notificationService.js`)
- Singleton service managing all notification channels
- Handles email (nodemailer), Slack webhooks, and generic webhooks
- Configuration via environment variables
- HTML and text formatting for emails
- Slack-formatted attachments with severity colors

**AlertService Integration** (`/src/services/alertService.js`)
- Modified `_sendNotifications()` method to use NotificationService
- Supports channel: `email`, `slack`, `webhook`, `dataapi_log`
- Automatic delivery status tracking in Alert model

**API Endpoints** (`/routes/alerts.js`)
- `GET /api/alerts/notifications/status` - Channel configuration status
- `POST /api/alerts/notifications/test` - Send test notification
- `POST /api/alerts/notifications/verify` - Verify channel configuration

---

## Configuration

### Environment Variables

Add these variables to your `.env` file:

```bash
# Email Notifications (SMTP)
EMAIL_ENABLED=true
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
SMTP_FROM=alerts@agentx.local
ALERT_EMAIL_RECIPIENTS=admin@example.com,ops@example.com

# Slack Notifications
SLACK_ENABLED=true
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL

# Generic Webhook Notifications
WEBHOOK_ENABLED=true
WEBHOOK_URL=https://your-endpoint.com/alerts
WEBHOOK_METHOD=POST
WEBHOOK_HEADERS={"Authorization":"Bearer YOUR_TOKEN","X-API-Key":"your-key"}
```

### Email Configuration Examples

**Gmail:**
```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password  # Generate from Google Account settings
```

**Outlook:**
```bash
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@outlook.com
SMTP_PASS=your-password
```

**SendGrid:**
```bash
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=apikey
SMTP_PASS=your-sendgrid-api-key
```

**Custom SMTP:**
```bash
SMTP_HOST=mail.yourcompany.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=alerts@yourcompany.com
SMTP_PASS=your-password
```

---

## Usage

### Creating Alerts with Notification Channels

```javascript
// Create alert with email notification
POST /api/alerts
{
  "title": "High CPU Usage Detected",
  "message": "CPU usage exceeded 90% on production server",
  "severity": "critical",
  "source": "monitoring",
  "channels": ["email", "slack", "dataapi_log"],
  "context": {
    "component": "prod-server-01",
    "metric": "cpu_usage",
    "currentValue": 95,
    "threshold": 90
  }
}
```

### Testing Notification Channels

```bash
# Test email notifications
curl -X POST http://localhost:3080/api/alerts/notifications/test \
  -H "Content-Type: application/json" \
  -d '{"channel": "email"}'

# Test Slack notifications
curl -X POST http://localhost:3080/api/alerts/notifications/test \
  -H "Content-Type: application/json" \
  -d '{"channel": "slack"}'

# Test webhook notifications
curl -X POST http://localhost:3080/api/alerts/notifications/test \
  -H "Content-Type: application/json" \
  -d '{"channel": "webhook"}'
```

### Verifying Configuration

```bash
# Check all channels status
curl http://localhost:3080/api/alerts/notifications/status

# Response:
{
  "status": "success",
  "data": {
    "email": {
      "enabled": true,
      "configured": true
    },
    "slack": {
      "enabled": true,
      "configured": true
    },
    "webhook": {
      "enabled": true,
      "configured": true
    }
  }
}

# Verify specific channel
curl -X POST http://localhost:3080/api/alerts/notifications/verify \
  -H "Content-Type": application/json" \
  -d '{"channel": "email"}'
```

---

## Alert Delivery Tracking

All notification attempts are tracked in the Alert model's `delivery` field:

```javascript
{
  "_id": "alert-id",
  "title": "High CPU Usage",
  "delivery": {
    "email": {
      "sent": true,
      "sentAt": "2026-01-08T07:30:00.000Z"
    },
    "slack": {
      "sent": true,
      "sentAt": "2026-01-08T07:30:00.500Z"
    },
    "dataapi_log": {
      "sent": true,
      "sentAt": "2026-01-08T07:30:00.200Z"
    }
  }
}
```

Failed deliveries include error details:

```javascript
{
  "delivery": {
    "email": {
      "sent": false,
      "sentAt": "2026-01-08T07:30:00.000Z",
      "error": "SMTP connection failed: Invalid credentials"
    }
  }
}
```

---

## Notification Formats

### Email

**Text Format:**
```
ALERT: High CPU Usage Detected

Severity: CRITICAL
Rule: CPU Threshold Alert
Component: prod-server-01
Source: monitoring

Message:
CPU usage exceeded 90% on production server

Details:
- Current Value: 95
- Threshold: 90
- Metric: cpu_usage

Triggered: 2026-01-08T07:30:00.000Z
Alert ID: 67f8c9d3e4a5b6c7d8e9f0a1

---
AgentX Alert System
```

**HTML Format:**
- Severity-colored header (red for critical, orange for high, etc.)
- Formatted table with all alert details
- Clean, responsive design
- Footer with AgentX branding

### Slack

**Webhook Payload:**
```json
{
  "text": "*High CPU Usage Detected*",
  "attachments": [
    {
      "color": "#dc3545",
      "fields": [
        {
          "title": "Severity",
          "value": "CRITICAL",
          "short": true
        },
        {
          "title": "Rule",
          "value": "CPU Threshold Alert",
          "short": true
        },
        {
          "title": "Component",
          "value": "prod-server-01",
          "short": true
        },
        {
          "title": "Source",
          "value": "monitoring",
          "short": true
        },
        {
          "title": "Message",
          "value": "CPU usage exceeded 90% on production server",
          "short": false
        }
      ],
      "footer": "AgentX Alert System",
      "ts": 1736316600
    }
  ]
}
```

**Severity Colors:**
- `critical`: Red (#dc3545)
- `high`: Orange (#fd7e14)
- `medium`: Yellow (#ffc107)
- `low`: Blue (#17a2b8)
- `info`: Gray (#6c757d)

### Generic Webhook

**POST Request:**
```json
{
  "alert": {
    "id": "67f8c9d3e4a5b6c7d8e9f0a1",
    "title": "High CPU Usage Detected",
    "message": "CPU usage exceeded 90% on production server",
    "severity": "critical",
    "ruleName": "CPU Threshold Alert",
    "ruleId": "rule-cpu-001",
    "source": "monitoring",
    "context": {
      "component": "prod-server-01",
      "metric": "cpu_usage",
      "currentValue": 95,
      "threshold": 90
    },
    "createdAt": "2026-01-08T07:30:00.000Z",
    "status": "active"
  },
  "timestamp": "2026-01-08T07:30:00.000Z",
  "source": "agentx"
}
```

---

## Error Handling

### Email Errors

**Common Issues:**
- Invalid SMTP credentials
- Connection timeout
- No recipients configured
- Transporter not initialized

**Resolution:**
1. Verify SMTP credentials in `.env`
2. Check firewall/network access to SMTP server
3. Test with `POST /api/alerts/notifications/verify`
4. Check logs: `pm2 logs agentx | grep NotificationService`

### Slack Errors

**Common Issues:**
- Invalid webhook URL
- Webhook deactivated/revoked
- Rate limiting

**Resolution:**
1. Regenerate webhook URL in Slack
2. Verify URL format: `https://hooks.slack.com/services/...`
3. Check Slack workspace settings
4. Test with `POST /api/alerts/notifications/test`

### Webhook Errors

**Common Issues:**
- Invalid URL
- Authentication failures
- Endpoint not responding
- Invalid response codes

**Resolution:**
1. Verify webhook URL is accessible
2. Check authentication headers
3. Verify endpoint accepts POST requests
4. Test with curl manually first

---

## Integration Examples

### n8n Workflow

Create an n8n workflow to send alerts to external systems:

```javascript
// Webhook Trigger
// URL: http://localhost:3080/api/alerts

// Function Node: Transform Alert
const alert = $input.item.json;

return {
  json: {
    channel: 'slack',
    title: alert.title,
    message: alert.message,
    severity: alert.severity
  }
};

// HTTP Request: Send to Slack
Method: POST
URL: {{SLACK_WEBHOOK_URL}}
Body: {{$json}}
```

### Custom Alert Rule (Self-Healing)

```json
{
  "id": "notify-all-critical",
  "name": "Critical Alerts - All Channels",
  "enabled": true,
  "conditions": {
    "all": [
      {
        "fact": "severity",
        "operator": "equal",
        "value": "critical"
      }
    ]
  },
  "event": {
    "type": "alert",
    "params": {
      "channels": ["email", "slack", "webhook", "dataapi_log"]
    }
  }
}
```

---

## API Reference

### GET /api/alerts/notifications/status

Get configuration status for all notification channels.

**Response:**
```json
{
  "status": "success",
  "data": {
    "email": {
      "enabled": true,
      "configured": true
    },
    "slack": {
      "enabled": true,
      "configured": true
    },
    "webhook": {
      "enabled": false,
      "configured": false
    }
  }
}
```

### POST /api/alerts/notifications/test

Send a test notification to verify channel configuration.

**Request Body:**
```json
{
  "channel": "email"  // or "slack", "webhook"
}
```

**Response (Success):**
```json
{
  "status": "success",
  "data": {
    "channel": "email",
    "sent": true,
    "message": "Test notification sent successfully to email"
  }
}
```

**Response (Failure):**
```json
{
  "status": "success",
  "data": {
    "channel": "email",
    "sent": false,
    "error": "SMTP connection failed",
    "message": "Failed to send test notification: SMTP connection failed"
  }
}
```

### POST /api/alerts/notifications/verify

Verify notification channel configuration without sending actual notification.

**Request Body:**
```json
{
  "channel": "email"
}
```

**Response (Valid):**
```json
{
  "status": "success",
  "data": {
    "channel": "email",
    "valid": true
  }
}
```

**Response (Invalid):**
```json
{
  "status": "success",
  "data": {
    "channel": "email",
    "valid": false,
    "error": "SMTP host not configured"
  }
}
```

---

## Security Considerations

### SMTP Credentials

- **Never commit** `.env` file to version control
- Use **app-specific passwords** for Gmail/Outlook
- Store credentials in **environment variables** or secure vaults
- Rotate passwords regularly

### Webhook Security

- Use **HTTPS** for webhook URLs
- Include **authentication headers** (Bearer tokens, API keys)
- Validate webhook **response codes**
- Implement **retry logic** for failures

### Slack Webhook URLs

- **Protect webhook URLs** - they provide direct access to your Slack workspace
- Regenerate URLs if compromised
- Use **workspace-level security** settings

---

## Troubleshooting

### Email not sending

1. Check configuration:
   ```bash
   curl http://localhost:3080/api/alerts/notifications/status
   ```

2. Verify SMTP connection:
   ```bash
   curl -X POST http://localhost:3080/api/alerts/notifications/verify \
     -H "Content-Type: application/json" \
     -d '{"channel":"email"}'
   ```

3. Check logs:
   ```bash
   pm2 logs agentx | grep -i "email\|smtp\|notification"
   ```

4. Test manually with nodemailer

### Slack not receiving messages

1. Verify webhook URL is correct
2. Check Slack workspace permissions
3. Test webhook with curl:
   ```bash
   curl -X POST $SLACK_WEBHOOK_URL \
     -H "Content-Type: application/json" \
     -d '{"text":"Test message"}'
   ```

4. Check rate limits (1 message per second)

### Webhook failures

1. Verify endpoint is accessible
2. Check authentication headers
3. Test with curl:
   ```bash
   curl -X POST $WEBHOOK_URL \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer $TOKEN" \
     -d '{"test":"data"}'
   ```

4. Check endpoint logs for errors

---

## Performance

### Delivery Times

- **Email**: 500-2000ms (SMTP handshake + delivery)
- **Slack**: 100-500ms (webhook HTTP call)
- **Generic Webhook**: 100-1000ms (depends on endpoint)
- **DataAPI Log**: <10ms (local logging)

### Optimization

- Notifications are sent **asynchronously** to avoid blocking alert creation
- Failed notifications don't block alert persistence
- Delivery status is updated **after** alert is created
- Retry logic handled by external systems (not AgentX)

---

## Future Enhancements

### Planned Features

- [ ] PagerDuty integration
- [ ] Microsoft Teams webhooks
- [ ] SMS notifications (Twilio)
- [ ] Retry logic with exponential backoff
- [ ] Notification templates (custom formatting)
- [ ] Alert grouping/deduplication
- [ ] Notification scheduling (quiet hours)
- [ ] Escalation policies

---

## Related Documentation

- [Alerts Dashboard Implementation](ALERTS_DASHBOARD_IMPLEMENTATION.md)
- [Self-Healing Quick Start](SELF_HEALING_QUICK_START.md)
- [ROADMAP.md](../ROADMAP.md) - Track 1: Alerts & Notifications

---

**Last Updated:** 2026-01-08
**Status:** Production-Ready ✅
