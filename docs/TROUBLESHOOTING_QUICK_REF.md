# SBQC Troubleshooting Quick Reference

**Emergency Hotline:** Run this first when things break
```bash
curl -s http://192.168.2.33:3080/health && \
curl -s http://192.168.2.33:3003/health && \
echo "All systems operational" || echo "SYSTEM DOWN - Check logs"
```

---

## Common Issues at a Glance

| Issue | Quick Fix | Full Guide Section |
|-------|-----------|-------------------|
| Webhook 404 | `curl -X POST -H "X-N8N-API-KEY: $N8N_API_KEY" "https://n8n.specialblend.icu/api/v1/workflows/$WORKFLOW_ID/activate"` | Issue 1 |
| Wrong response | Edit workflow: `responseMode: "responseNode"` → Redeploy | Issue 2 |
| Slow AI | Use smaller model: `qwen2.5:3b-instruct-q4_0` | Issue 3 |
| Workflow fails | Check logs: `pm2 logs agentx --lines 50` | Issue 4 |
| Connection refused | Restart: `pm2 restart all` | Issue 5 |
| Deploy fails | Check: `./scripts/deploy-n8n-workflows.sh --check` | Issue 6 |
| 401 Unauthorized | Source env: `source .env` + check API keys | Issue 7 |

---

## One-Line Diagnostics

```bash
# Full health check (2 minutes)
/home/yb/codes/AgentX/scripts/health-check.sh

# Quick services check (5 seconds)
pm2 status && docker ps | grep -E "(n8n|mongo)"

# Test webhook (10 seconds)
curl -s https://n8n.specialblend.icu/webhook/test-deployment | jq '.'

# Test AI query (30 seconds)
curl -s -X POST https://n8n.specialblend.icu/webhook/sbqc-ai-query \
  -H "Content-Type: application/json" \
  -d '{"message":"ping","useRag":false}' | jq '.success'

# Check for errors (5 seconds)
pm2 logs agentx --lines 20 --nostream | grep -i error
```

---

## Emergency Restart Sequence

```bash
# 1. Stop everything
pm2 stop all
docker stop n8n
sudo systemctl stop ollama

# 2. Start in order
sudo systemctl start mongodb  # Wait 10s
sudo systemctl start ollama   # Wait 10s
docker start n8n              # Wait 20s
pm2 start all                 # Wait 10s

# 3. Verify
curl http://192.168.2.33:3080/health
curl http://192.168.2.33:3003/health
curl https://n8n.specialblend.icu/webhook/sbqc-health
```

---

## Key File Locations

```
/home/yb/codes/AgentX/.env           # AgentX environment variables
/home/yb/codes/DataAPI/.env          # DataAPI environment variables
/home/yb/codes/AgentX/AgentC/*.json  # n8n workflow definitions
/home/yb/codes/AgentX/scripts/       # Deployment and utility scripts
~/.pm2/logs/                         # pm2 service logs
```

---

## Essential Commands

```bash
# Workflow deployment
cd /home/yb/codes/AgentX
./scripts/deploy-n8n-workflows.sh N3.2.json
source .env && curl -X POST -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "https://n8n.specialblend.icu/api/v1/workflows/$WORKFLOW_ID/activate"

# Service management
pm2 status                    # Check status
pm2 restart agentx           # Restart AgentX
pm2 logs agentx --lines 50   # View logs
pm2 restart all              # Restart all

# Database access
mongosh mongodb://localhost:27017/agentx    # AgentX database
mongosh mongodb://localhost:27017/dataapi   # DataAPI database

# Check workflows
cd /home/yb/codes/AgentX && source .env
curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "https://n8n.specialblend.icu/api/v1/workflows" | \
  jq '.data[] | {id, name, active}'
```

---

## Troubleshooting Decision Tree

```
Problem?
├── Can't reach service → Check: pm2 status, docker ps
│   ├── Service down → pm2 restart all
│   └── Service up → Check firewall, network
│
├── Webhook 404 → Check: workflow active, webhookId present
│   ├── Inactive → Activate workflow
│   └── Missing fields → Fix JSON, redeploy
│
├── Slow response → Check: CPU, memory, Ollama
│   ├── High CPU → Use smaller model
│   └── High memory → Restart Ollama
│
├── Workflow error → Check: n8n execution logs
│   ├── AgentX error → Check AgentX logs
│   ├── DataAPI error → Check DataAPI logs
│   └── JSON error → Validate workflow JSON
│
└── Authentication error → Check: .env files, API keys
    ├── Missing keys → Generate and add
    └── Key mismatch → Sync across services
```

---

## When All Else Fails

1. **Check the full guide:** `/home/yb/codes/AgentX/docs/TROUBLESHOOTING.md`
2. **Review workflow guide:** `/home/yb/codes/AgentX/AgentC/WORKFLOW-GUIDE.md`
3. **Check API docs:** `/home/yb/codes/AgentX/docs/API.md`
4. **Nuclear option:** Full restart (see Emergency Restart Sequence above)

---

**Quick Reference Version:** 1.0.0
**Full Guide:** [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)
