# n8n Deployment & Operations Guide

**For AgentX v1.0.0**  
**Last Updated:** December 4, 2025

This guide covers deploying n8n for AgentX automation workflows including document ingestion and prompt improvement loops.

---

## Table of Contents

1. [Overview](#overview)
2. [n8n Deployment](#n8n-deployment)
3. [Workflow Setup](#workflow-setup)
4. [Document Ingestion Workflows](#document-ingestion-workflows)
5. [Prompt Improvement Workflows](#prompt-improvement-workflows)
6. [Monitoring & Maintenance](#monitoring--maintenance)
7. [Troubleshooting](#troubleshooting)

---

## Overview

### What is n8n?

n8n is a workflow automation tool that connects AgentX with external systems for:
- **Automated document ingestion** from folders, webhooks, APIs
- **Scheduled RAG updates** for keeping knowledge base current
- **Prompt improvement loops** based on feedback analytics
- **Data pipeline orchestration** for training datasets

### Architecture

```
┌─────────────────┐
│   Document      │
│   Sources       │
│  (Files/APIs)   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐      ┌──────────────┐
│   n8n Workflows │─────▶│   AgentX     │
│   - Ingestion   │      │  RAG API     │
│   - Monitoring  │◀─────│  Analytics   │
│   - Prompts     │      └──────────────┘
└─────────────────┘
```

### Prerequisites

- AgentX server running and accessible
- Docker (recommended for n8n deployment)
- OR Node.js 18+ (for native installation)

---

## n8n Deployment

### Option 1: Docker (Recommended)

**Step 1: Create docker-compose.yml**

```yaml
# File: n8n-docker-compose.yml
version: '3.8'

services:
  n8n:
    image: n8nio/n8n:latest
    container_name: agentx-n8n
    ports:
      - "5678:5678"
    environment:
      - N8N_HOST=localhost
      - N8N_PORT=5678
      - N8N_PROTOCOL=http
      - WEBHOOK_URL=http://localhost:5678/
      - GENERIC_TIMEZONE=America/New_York
      - N8N_BASIC_AUTH_ACTIVE=true
      - N8N_BASIC_AUTH_USER=admin
      - N8N_BASIC_AUTH_PASSWORD=change_this_password
      - AGENTX_API_BASE_URL=http://host.docker.internal:3080
    volumes:
      - n8n_data:/home/node/.n8n
      - ./n8n-workflows:/workflows:ro
    restart: unless-stopped

volumes:
  n8n_data:
```

**Step 2: Start n8n**

```bash
# Start n8n
docker-compose -f n8n-docker-compose.yml up -d

# View logs
docker-compose -f n8n-docker-compose.yml logs -f

# Stop n8n
docker-compose -f n8n-docker-compose.yml down
```

**Step 3: Access n8n**

Open browser: `http://localhost:5678`  
Login with credentials from docker-compose.yml

### Option 2: Native Installation

```bash
# Install n8n globally
npm install -g n8n

# Set environment variables
export N8N_BASIC_AUTH_ACTIVE=true
export N8N_BASIC_AUTH_USER=admin
export N8N_BASIC_AUTH_PASSWORD=your_password
export AGENTX_API_BASE_URL=http://localhost:3080

# Start n8n
n8n start

# Access at http://localhost:5678
```

### Option 3: systemd Service

```ini
# File: /etc/systemd/system/n8n.service
[Unit]
Description=n8n Workflow Automation
After=network.target

[Service]
Type=simple
User=n8n
Environment="N8N_BASIC_AUTH_ACTIVE=true"
Environment="N8N_BASIC_AUTH_USER=admin"
Environment="N8N_BASIC_AUTH_PASSWORD=your_password"
Environment="AGENTX_API_BASE_URL=http://localhost:3080"
ExecStart=/usr/bin/n8n start
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable n8n
sudo systemctl start n8n
```

---

## Workflow Setup

### Configure AgentX Connection

All workflows need to connect to AgentX APIs. Configure once globally:

1. **Open n8n**: http://localhost:5678
2. **Credentials** → **New**
3. **Select**: Generic HTTP API
4. **Configure**:
   - Name: `AgentX API`
   - Base URL: `http://localhost:3080` (or your AgentX URL)
   - Authentication: None (for local deployment)
5. **Save**

### Import Workflow Templates

Workflow JSON files are in `docs/reports/`:
- `n8n-ingestion.md` - Document ingestion workflows
- `n8n-prompt-improvement-v4.md` - Prompt optimization workflows

**To Import:**

1. Copy the JSON from the documentation
2. n8n → **Workflows** → **Import from File**
3. Paste JSON or upload file
4. Update node credentials to use "AgentX API"
5. Activate workflow

---

## Document Ingestion Workflows

### Workflow 1: Scheduled Folder Sync

**Purpose:** Automatically sync documents from a folder to AgentX RAG

**Configuration:**

```javascript
// Cron Schedule Node
Schedule: "0 */6 * * *"  // Every 6 hours

// Read Files Node
Directory: "/path/to/docs"
File Extensions: "*.md,*.txt,*.pdf"

// HTTP Request Node
URL: {{ $env.AGENTX_API_BASE_URL }}/api/rag/ingest
Method: POST
Body: {
  "documents": [
    {
      "id": "{{ $node['Read Files'].json['fileName'] }}",
      "text": "{{ $node['Read Files'].json['content'] }}",
      "metadata": {
        "source": "local_docs",
        "path": "{{ $node['Read Files'].json['filePath'] }}",
        "title": "{{ $node['Read Files'].json['fileName'] }}",
        "timestamp": "{{ $now }}"
      }
    }
  ]
}
```

**Setup Steps:**

1. Create workflow in n8n
2. Add **Cron** trigger node
   - Set schedule (e.g., every 6 hours)
3. Add **Read Binary Files** node
   - Directory: Your docs folder
   - File filter: `*.md` or `*.txt`
4. Add **Function** node to format for AgentX
5. Add **HTTP Request** node
   - URL: `http://localhost:3080/api/rag/ingest`
   - Method: POST
   - Body: Format as per V3 contract
6. Activate workflow

**Test:**

```bash
# Manually trigger in n8n UI
# Or add test files to watched folder
echo "Test document content" > /path/to/docs/test.md

# Wait for next cron run or trigger manually
# Check AgentX logs for ingestion
```

### Workflow 2: Webhook-Based Ingestion

**Purpose:** Accept documents from external systems via HTTP webhook

**Configuration:**

```javascript
// Webhook Node
HTTP Method: POST
Path: agentx-ingest
Authentication: Header Auth (optional)

// Function Node - Transform
const documents = $input.all().map(item => ({
  id: item.json.id || crypto.randomUUID(),
  text: item.json.text,
  metadata: {
    source: item.json.source || 'webhook',
    path: item.json.path || '/',
    title: item.json.title || 'Untitled',
    tags: item.json.tags || [],
    timestamp: new Date().toISOString()
  }
}));

return [{ json: { documents } }];

// HTTP Request Node
URL: {{ $env.AGENTX_API_BASE_URL }}/api/rag/ingest
Method: POST
Body: {{ $json }}
```

**Setup Steps:**

1. Add **Webhook** trigger
   - Path: `/agentx-ingest`
   - Method: POST
2. Add **Function** node (transformation code above)
3. Add **HTTP Request** node to AgentX
4. Activate workflow

**Test:**

```bash
# Get webhook URL from n8n
WEBHOOK_URL="http://localhost:5678/webhook/agentx-ingest"

# Send test document
curl -X POST $WEBHOOK_URL \
  -H "Content-Type: application/json" \
  -d '{
    "text": "This is a test document ingested via webhook.",
    "source": "api_test",
    "title": "Webhook Test Document",
    "tags": ["test", "webhook"]
  }'
```

### Workflow 3: Git Repository Sync

**Purpose:** Sync markdown files from Git repositories

**Nodes:**

1. **Cron** - Schedule (daily)
2. **Execute Command** - `git pull` in repo folder
3. **Read Binary Files** - Read markdown files
4. **Function** - Format for AgentX
5. **HTTP Request** - POST to `/api/rag/ingest`

---

## Prompt Improvement Workflows

### Workflow 1: Weekly Feedback Analysis

**Purpose:** Monitor feedback and generate prompt improvement candidates

**Configuration:**

```javascript
// Cron Schedule
Schedule: "0 9 * * MON"  // Every Monday at 9 AM

// HTTP Request 1 - Get Feedback
URL: {{ $env.AGENTX_API_BASE_URL }}/api/analytics/feedback
Method: GET
Query: {
  since: "{{ $now.minus({ days: 7 }).toISO() }}",
  groupBy: "promptVersion"
}

// Function - Analyze
const feedback = $input.first().json;
const negativeRate = feedback.metrics.negativeRate;

if (negativeRate > 0.3) {  // More than 30% negative
  return [{
    json: {
      alert: true,
      message: `High negative feedback rate: ${(negativeRate * 100).toFixed(1)}%`,
      promptVersion: feedback.promptVersion,
      negativeCount: feedback.metrics.negativeCount
    }
  }];
}

return [];

// IF Node - Check if alert
Condition: {{ $json.alert }} === true

// Email/Slack Notification
Subject: "AgentX: Prompt Improvement Needed"
Body: {{ $json.message }}
```

**Setup:**

1. **Cron** trigger (weekly)
2. **HTTP Request** to `/api/analytics/feedback`
3. **Function** to analyze feedback rates
4. **IF** node to check threshold
5. **Send Email** or **Slack** notification

### Workflow 2: Automated Prompt Generation

**Purpose:** Generate new prompt candidates from poor examples

**Workflow:**

1. **Cron** - Weekly trigger
2. **HTTP Request** - Get conversations with negative feedback
   - URL: `/api/dataset/conversations?feedbackRating=negative&limit=20`
3. **Function** - Extract patterns from poor examples
4. **HTTP Request** - Call LLM (Ollama or external) to generate improved prompt
5. **HTTP Request** - POST new prompt to `/api/dataset/prompts`
6. **Notification** - Alert human for review

**Prompt Template for Generation:**

```
Analyze these conversations that received negative feedback:

{{ $json.conversations }}

Current system prompt:
{{ $json.currentPrompt }}

Generate an improved system prompt that addresses the issues in these conversations.
Focus on: clarity, accuracy, tone, and helpfulness.
```

### Workflow 3: A/B Test Deployment

**Purpose:** Gradually roll out new prompts

**Nodes:**

1. **Manual Trigger** (human-initiated)
2. **HTTP Request** - GET `/api/dataset/prompts?status=proposed`
3. **Function** - Select prompt for testing
4. **HTTP Request** - POST `/api/dataset/prompts/:id/activate`
5. **Wait** - 7 days
6. **HTTP Request** - GET `/api/analytics/feedback` (new vs old)
7. **Function** - Compare metrics
8. **IF** - Check if improvement
9. **Keep** or **Rollback** based on results

---

## Monitoring & Maintenance

### Health Check Workflow

```javascript
// Cron: Every hour
// HTTP Request
URL: {{ $env.AGENTX_API_BASE_URL }}/health/detailed
Method: GET

// IF Node
Condition: {{ $json.status }} !== "healthy"

// Slack Alert
Message: "AgentX is degraded: {{ $json }}"
```

### Metrics Dashboard Workflow

```javascript
// Cron: Daily at 8 AM
// HTTP Requests (parallel)
1. GET /api/analytics/usage
2. GET /api/analytics/feedback
3. GET /api/rag/documents (count)

// Function: Format metrics
// Email: Daily summary report
```

### Backup Workflow

```javascript
// Cron: Daily at 2 AM
// HTTP Request
URL: {{ $env.AGENTX_API_BASE_URL }}/api/dataset/conversations
Query: { limit: 1000 }

// Write to File
Path: /backups/agentx-{{ $now.toFormat('yyyy-MM-dd') }}.json
Content: {{ $json }}
```

---

## Troubleshooting

### Issue: n8n Can't Reach AgentX

**Check:**

```bash
# From n8n container
docker exec -it agentx-n8n curl http://host.docker.internal:3080/health

# If fails, check Docker networking
docker network inspect bridge
```

**Solution:**

- Update `AGENTX_API_BASE_URL` to correct IP/hostname
- Use `host.docker.internal` for Docker Desktop
- Use actual IP for Linux: `172.17.0.1` or `192.168.x.x`

### Issue: Webhook Not Triggering

**Check:**

```bash
# Test webhook directly
curl -X POST http://localhost:5678/webhook-test/your-path \
  -H "Content-Type: application/json" \
  -d '{"test": "data"}'
```

**Solutions:**

- Ensure workflow is **activated** (toggle in n8n)
- Check firewall rules for port 5678
- Verify webhook path matches workflow configuration

### Issue: Ingestion Fails

**Check AgentX Logs:**

```bash
# Docker
docker logs agentx

# PM2
pm2 logs agentx

# systemd
sudo journalctl -u agentx -n 100
```

**Common Causes:**

- Invalid document format (missing required fields)
- Ollama not running (embedding generation fails)
- Document too large (increase chunk size)

### Issue: High Failure Rate in Workflows

**Debug Mode:**

1. n8n → Workflow → **Settings**
2. Enable **Save Execution Data**
3. Enable **Save Error Data**
4. Re-run workflow
5. Check **Executions** tab for details

---

## Best Practices

### Security

1. **Change default credentials** immediately
2. **Use environment variables** for secrets
3. **Enable HTTPS** for production (reverse proxy)
4. **Restrict webhook access** with API keys
5. **Regular backups** of n8n data

### Performance

1. **Batch document ingestion** (max 50 per request)
2. **Use appropriate cron schedules** (avoid overlap)
3. **Monitor n8n memory usage** (limit concurrent workflows)
4. **Archive old executions** regularly

### Reliability

1. **Error handling** in all workflows (try-catch nodes)
2. **Retry logic** for HTTP requests (3 retries)
3. **Monitoring workflows** for critical paths
4. **Alerting** for failures (Slack/Email)

---

## Next Steps

1. Deploy n8n using preferred method
2. Import document ingestion workflow
3. Configure cron schedule for your needs
4. Test with sample documents
5. Set up monitoring workflow
6. Optionally: Add prompt improvement workflows

---

## Resources

- **n8n Documentation**: https://docs.n8n.io
- **AgentX API Reference**: `docs/api/reference.md`
- **V3 RAG Contract**: `docs/api/contracts/v3-snapshot.md`
- **V4 Analytics Contract**: `docs/api/contracts/v4-contract.md`
- **Workflow Examples**: `docs/reports/n8n-*.md`

---

## Support

For issues:
- n8n Community: https://community.n8n.io
- AgentX GitHub: https://github.com/WindriderQc/AgentX/issues

**End of n8n Deployment Guide**
