# SBQC Workflow Architect - Quick Reference Card

## Installation (One-Time)

```bash
cd /home/yb/codes/AgentX
node scripts/seed-workflow-architect.js
```

## Usage

### Via AgentX UI
1. Open http://localhost:3080
2. Select "sbqc_workflow_architect" persona
3. Describe your workflow

### Via API
```bash
curl -X POST http://localhost:3080/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Your workflow description here",
    "options": {"persona": "sbqc_workflow_architect"}
  }'
```

## Common Requests

### Health Check
```
Create a workflow that checks [service] health every [N] minutes
```

### Threshold Alert
```
Create a workflow that monitors [metric] and alerts if above [threshold]
```

### Data Pipeline
```
Create a workflow that receives [data] via webhook, processes it, and stores results
```

### Multi-Service Check
```
Create a workflow that checks [service A], [service B], and [service C] in parallel
```

## Request Templates

### Minimal
```
Create [type] workflow for [service]
```

### Standard
```
Create a workflow that:
- Runs [schedule]
- Checks [endpoint]
- Alerts if [condition]
- Logs to DataAPI
```

### Detailed
```
Create SBQC N[X.Y] [Name] workflow:
- Schedule: [cron or interval]
- Manual trigger: webhook at [path]
- Check: [HTTP method] [URL] ([timeout], [error handling])
- Process: [logic description]
- Alert: [condition] sends to [destination]
- Log: POST to DataAPI event sink
- Tags: [SBQC, Priority-N, Domain]
```

## SBQC Workflow Naming

- **N0.x** - Testing & Diagnostics
- **N1.x** - System Health & Monitoring
- **N2.x** - Data Collection & Scanning
- **N3.x** - Performance Monitoring
- **N5.x** - Analytics & Optimization
- **N6.x** - Workflow Generation

## Common Schedules

```
Every 5 minutes:  {"field": "minutes", "minutes": 5}
Every hour:       {"field": "hours", "hours": 1}
Daily 2 AM:       {"field": "cronExpression", "expression": "0 2 * * *"}
Weekly Sun 3 AM:  {"field": "cronExpression", "expression": "0 3 * * 0"}
```

## SBQC Endpoints

```
DataAPI Health:     http://192.168.2.33:3003/health
AgentX Health:      http://192.168.2.33:3080/health
Ollama 99 Tags:     http://192.168.2.99:11434/api/tags
Ollama 12 Tags:     http://192.168.2.12:11434/api/tags
DataAPI Event Sink: http://192.168.2.33:3003/integrations/events/n8n
```

## Deployment

1. Copy generated JSON
2. Open n8n: http://192.168.2.199:5678
3. Import from File
4. Configure credentials
5. Test via webhook
6. Activate

## Webhook Testing

```bash
curl -X POST http://192.168.2.199:5678/webhook/[webhook-path]
```

## Verification

```bash
# Check installation
mongo agentx --eval "db.promptconfigs.findOne({name: 'sbqc_workflow_architect'})"

# Check stats
mongo agentx --eval "db.promptconfigs.findOne({name: 'sbqc_workflow_architect'}, {stats: 1})"
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Persona not found | Run seed script |
| Invalid JSON | Validate at jsonlint.com |
| Won't import to n8n | Check node names match in connections |
| Credentials fail | Create/update HTTP Header Auth in n8n |
| Generic responses | Verify persona selection in request |

## Documentation

- Full Guide: `personas/INSTALLATION.md`
- Patterns: `personas/WORKFLOW_PATTERNS.md`
- Examples: `personas/EXAMPLE_WORKFLOW.md`
- Reference: `/home/yb/codes/AgentX/AgentC/*.json`

## Support

1. Review documentation in `personas/` directory
2. Study example workflows in `AgentC/`
3. Test with simple requests first
4. Validate generated JSON before import
5. Provide feedback to improve results

---

**Quick Start:** `node scripts/seed-workflow-architect.js` then ask: "Create a health check workflow for DataAPI"
