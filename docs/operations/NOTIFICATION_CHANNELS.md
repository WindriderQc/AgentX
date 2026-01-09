# Notification Channels

AgentX supports multiple notification channels for alerts: Email, Slack, and Generic Webhooks. This document describes how to configure and customize these channels.

## 1. Email Notifications

Send rich HTML email alerts via SMTP.

### Configuration
Set the following environment variables in your `.env` file:

```env
EMAIL_ENABLED=true
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=true
SMTP_USER=your_username
SMTP_PASS=your_password
SMTP_FROM=alerts@agentx.company.com
ALERT_EMAIL_RECIPIENTS=ops@company.com,oncall@company.com
```

### Features
- **HTML Templates**: Automatic responsive HTML formatting with severity color coding.
- **Custom Subjects**: Can be customized per alert using templates.
- **Recipients**: Configure global defaults or override per alert rule.

## 2. Slack Notifications

Send alerts to Slack channels via Incoming Webhooks.

### Configuration
1. Create an Incoming Webhook in your Slack App.
2. Set the environment variable:

```env
SLACK_ENABLED=true
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR_WORKSPACE/YOUR_CHANNEL/YOUR_WEBHOOK_KEY
```

### Retry Logic
Slack delivery includes automatic retries for transient failures (e.g., 503 Service Unavailable).
Default configuration (customizable via env):

```env
SLACK_RETRY_MAX_ATTEMPTS=3
SLACK_RETRY_BASE_DELAY_MS=500
SLACK_RETRY_JITTER_MS=250
```

## 3. Generic Webhooks

Send JSON payloads to any external service (e.g., PagerDuty, OpsGenie, Custom-built tools).

### Configuration

```env
WEBHOOK_ENABLED=true
WEBHOOK_URL=https://api.custom-service.com/alerts
WEBHOOK_METHOD=POST
WEBHOOK_HEADERS={"Authorization":"Bearer token"}
```

### Retry Logic
Includes exponential backoff with jitter to handle rate limits and downtime.

```env
WEBHOOK_RETRY_MAX_ATTEMPTS=3
WEBHOOK_RETRY_BASE_DELAY_MS=500
WEBHOOK_RETRY_JITTER_MS=250
```

### Payloads
By default, sends a standard JSON payload:

```json
{
  "alert": {
    "id": "alert-id",
    "title": "CPU Usage High",
    "severity": "critical",
    ...
  },
  "timestamp": "2026-01-09T00:00:00.000Z",
  "source": "agentx"
}
```

### Custom Templates
You can customize the webhook payload per alert using Handlebars-style syntax:

```json
{
  "summary": "{{title}}",
  "level": "{{severity}}",
  "details": {
    "host": "{{context.host}}"
  }
}
```

## Troubleshooting

- **Check Logs**: Detailed logs are written to `logger` for every attempt and retry.
- **Verify Channel**: The system verifies channel configuration on startup.
- **Test Mode**: Set `ALERT_TEST_MODE=true` to simulate sending without making actual network requests.
