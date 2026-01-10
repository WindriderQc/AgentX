# SBQC Troubleshooting Playbook

**Version:** 1.0.0
**Last Updated:** 2026-01-02
**System:** SBQC (System Brain Query Control) - AgentX + DataAPI + n8n Integration

---

## Table of Contents

1. [Quick Diagnostics Checklist](#quick-diagnostics-checklist)
2. [Common Issues & Solutions](#common-issues--solutions)
3. [Health Check Procedures](#health-check-procedures)
4. [Workflow Debugging Steps](#workflow-debugging-steps)
5. [Performance Troubleshooting](#performance-troubleshooting)
6. [Emergency Procedures](#emergency-procedures)
7. [Appendix: Command Reference](#appendix-command-reference)

---

## Quick Diagnostics Checklist

Run these checks in order when encountering any issue:

### 1. System Health (30 seconds)

```bash
# Check all services are running
curl -s http://192.168.2.33:3080/health | jq '.'
curl -s http://192.168.2.33:3003/health | jq '.'
curl -s https://n8n.specialblend.icu/webhook/sbqc-health | jq '.overall_status'

# Quick service status
pm2 status
docker ps | grep -E "(n8n|mongo)"
```

**Expected Results:**
- AgentX: `{"status":"ok","port":"3080","details":{"mongodb":"connected","ollama":"connected"}}`
- DataAPI: `{"status":"healthy"}` or similar
- n8n Health: `"healthy"`
- pm2: All services showing "online"
- Docker: n8n and MongoDB containers "Up"

### 2. Network Connectivity (10 seconds)

```bash
# Test local network connectivity
ping -c 2 192.168.2.33
ping -c 2 192.168.2.199

# Test DNS/HTTPS for n8n
curl -I https://n8n.specialblend.icu/health 2>&1 | head -1
```

**Expected Results:**
- Pings: 0% packet loss
- n8n HTTPS: `HTTP/2 200` or `HTTP/1.1 200`

### 3. Database Connectivity (10 seconds)

```bash
# Test MongoDB connection
mongosh --quiet --eval "db.adminCommand('ping')" mongodb://localhost:27017/agentx

# Check database sizes
mongosh --quiet --eval "db.stats().dataSize" mongodb://localhost:27017/agentx
mongosh --quiet --eval "db.stats().dataSize" mongodb://localhost:27017/dataapi
```

**Expected Results:**
- Ping: `{ ok: 1 }`
- Data sizes: Non-zero numbers (varies by usage)

### 4. Ollama AI Service (15 seconds)

```bash
# Check Ollama is running
curl -s http://localhost:11434/api/tags | jq '.models | length'

# Test a simple inference
curl -s http://localhost:11434/api/generate -d '{
  "model": "qwen2.5:7b-instruct-q4_0",
  "prompt": "Hi",
  "stream": false
}' | jq -r '.response' | head -1
```

**Expected Results:**
- Model count: > 0 (number of installed models)
- Inference: Returns a greeting response

### 5. Webhook Endpoints (15 seconds)

```bash
# Test deployment test webhook
curl -s https://n8n.specialblend.icu/webhook/test-deployment | jq '.status'

# Test AI gateway (quick query)
curl -s -X POST https://n8n.specialblend.icu/webhook/sbqc-ai-query \
  -H "Content-Type: application/json" \
  -d '{"message":"ping","useRag":false}' | jq '.success'
```

**Expected Results:**
- Deployment test: `"success"`
- AI gateway: `true`

---

## Common Issues & Solutions

### Issue 1: "The requested webhook is not registered" (404)

**Symptoms:**
```json
{
  "code": 404,
  "message": "The requested webhook \"sbqc-ai-query\" is not registered.",
  "hint": "The workflow must be active for a production URL to run successfully. You can activate the workflow using the toggle in the top-right of the editor."
}
```

**Root Causes:**
1. Workflow is not activated in n8n
2. Webhook node is missing `webhookId` field
3. Webhook node is missing `httpMethod` field
4. Wrong HTTP method (POST vs GET)

**Diagnostic Steps:**

```bash
# 1. Check if workflow exists and is active
cd /home/yb/codes/AgentX
source .env
curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "https://n8n.specialblend.icu/api/v1/workflows" | \
  jq '.data[] | select(.name | contains("AI Gateway")) | {id, name, active}'

# 2. Check webhook registration in n8n UI
# Open: https://n8n.specialblend.icu/workflows
# Find workflow -> Check if toggle is ON (blue)

# 3. Verify webhook node structure
jq '.nodes[] | select(.type == "n8n-nodes-base.webhook")' \
  AgentC/N3.2.json
```

**Solutions:**

**A. Activate the workflow:**
```bash
cd /home/yb/codes/AgentX
source .env

# Get workflow ID
WORKFLOW_ID=$(curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "https://n8n.specialblend.icu/api/v1/workflows" | \
  jq -r '.data[] | select(.name | contains("AI Gateway")) | .id')

# Activate it
curl -X POST \
  -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "https://n8n.specialblend.icu/api/v1/workflows/$WORKFLOW_ID/activate"
```

**B. Fix missing webhookId/httpMethod:**
```bash
# 1. Edit the workflow JSON
cd /home/yb/codes/AgentX/AgentC
nano N3.2.json

# 2. Ensure webhook node has:
# {
#   "parameters": {
#     "httpMethod": "POST",
#     "path": "sbqc-ai-query",
#     ...
#   },
#   "webhookId": "sbqc-n32-ai-gateway",
#   "type": "n8n-nodes-base.webhook"
# }

# 3. Redeploy
cd /home/yb/codes/AgentX
./scripts/deploy-n8n-workflows.sh N3.2.json

# 4. Reactivate (script above)
```

**C. Check HTTP method mismatch:**
```bash
# If webhook expects POST but you're sending GET:
curl -X POST https://n8n.specialblend.icu/webhook/sbqc-ai-query \
  -H "Content-Type: application/json" \
  -d '{"message":"test"}'
# NOT: curl https://n8n.specialblend.icu/webhook/sbqc-ai-query
```

**Verification:**
```bash
# Test the webhook
curl -s https://n8n.specialblend.icu/webhook/test-deployment | jq '.'
```

---

### Issue 2: Webhook returns "Workflow was started" instead of data

**Symptoms:**
```json
{
  "message": "Workflow was started"
}
```

**Root Cause:** Webhook `responseMode` is set to `"onReceived"` instead of `"responseNode"`

**Diagnostic Steps:**
```bash
cd /home/yb/codes/AgentX/AgentC
jq '.nodes[] | select(.type == "n8n-nodes-base.webhook") | .parameters.responseMode' N3.2.json
```

**Solution:**
```bash
# 1. Edit workflow JSON
nano AgentC/N3.2.json

# 2. Change:
#   "responseMode": "onReceived"
# To:
#   "responseMode": "responseNode"

# 3. Ensure workflow has a "Respond to Webhook" node

# 4. Redeploy
./scripts/deploy-n8n-workflows.sh N3.2.json

# 5. Reactivate
source .env
WORKFLOW_ID=$(curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "https://n8n.specialblend.icu/api/v1/workflows" | \
  jq -r '.data[] | select(.name | contains("AI Gateway")) | .id')
curl -X POST -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "https://n8n.specialblend.icu/api/v1/workflows/$WORKFLOW_ID/activate"
```

**Verification:**
```bash
curl -s -X POST https://n8n.specialblend.icu/webhook/sbqc-ai-query \
  -H "Content-Type: application/json" \
  -d '{"message":"test"}' | jq '.response'
```

---

### Issue 3: Slow AI Responses (>30 seconds)

**Symptoms:**
- Webhook requests timeout
- Client receives 504 Gateway Timeout
- Responses take 60+ seconds

**Diagnostic Steps:**

```bash
# 1. Check Ollama performance
time curl -s http://localhost:11434/api/generate -d '{
  "model": "qwen2.5:7b-instruct-q4_0",
  "prompt": "Hello, how are you?",
  "stream": false
}' | jq -r '.response'

# 2. Check system resources
htop  # Check CPU usage
nvidia-smi  # If using GPU
free -h  # Check RAM

# 3. Check model size and quantization
curl -s http://localhost:11434/api/show -d '{"name":"qwen2.5:7b-instruct-q4_0"}' | \
  jq '{size: .details.parameter_size, format: .details.format}'

# 4. Check for concurrent requests
ps aux | grep ollama | wc -l
curl -s http://localhost:11434/api/ps | jq '.models'

# 5. Check conversation history size
mongosh --quiet mongodb://localhost:27017/agentx --eval '
  db.conversations.aggregate([
    {$project: {messageCount: {$size: "$messages"}}},
    {$group: {_id: null, avg: {$avg: "$messageCount"}, max: {$max: "$messageCount"}}}
  ])
'
```

**Root Causes & Solutions:**

**A. Ollama is CPU-bound (no GPU acceleration):**
```bash
# Check if GPU is available
nvidia-smi

# If GPU available but not used, reinstall Ollama with CUDA support
# Follow: https://ollama.ai/download

# Temporary: Use smaller/faster model
curl -s -X POST https://n8n.specialblend.icu/webhook/sbqc-ai-query \
  -H "Content-Type: application/json" \
  -d '{"message":"test","model":"qwen2.5:3b-instruct-q4_0"}'
```

**B. Large conversation history:**
```bash
# Find conversations with too many messages
mongosh mongodb://localhost:27017/agentx --eval '
  db.conversations.find(
    {$expr: {$gte: [{$size: "$messages"}, 50]}}
  ).forEach(c => print(c._id + ": " + c.messages.length + " messages"))
'

# Prune old conversations (optional)
mongosh mongodb://localhost:27017/agentx --eval '
  db.conversations.updateMany(
    {$expr: {$gte: [{$size: "$messages"}, 100]}},
    {$set: {archived: true}}
  )
'
```

**C. RAG search taking too long:**
```bash
# Test RAG performance
cd /home/yb/codes/AgentX
node -e "
const { ragStore } = require('./src/services/ragStore');
(async () => {
  const start = Date.now();
  const results = await ragStore.search('test query', 5);
  console.log('RAG search took:', Date.now() - start, 'ms');
  console.log('Results:', results.length);
})();
"

# If >2000ms, consider optimizing embeddings or using Qdrant
# See: docs/QDRANT_DEPLOYMENT.md
```

**D. Multiple concurrent requests:**
```bash
# Check n8n workflow execution queue
curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "https://n8n.specialblend.icu/api/v1/executions?status=running" | \
  jq '.data | length'

# If >5, increase Ollama worker threads (if CPU-bound)
# Edit: /etc/systemd/system/ollama.service
# Add: Environment="OLLAMA_NUM_PARALLEL=4"
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

**Verification:**
```bash
# Test response time
time curl -s -X POST https://n8n.specialblend.icu/webhook/sbqc-ai-query \
  -H "Content-Type: application/json" \
  -d '{"message":"What is 2+2?","useRag":false}' | jq '.latency'
```

---

### Issue 4: Workflow Execution Failures

**Symptoms:**
- n8n shows "ERROR" status in execution list
- Workflow stops mid-execution
- No response from webhook

**Diagnostic Steps:**

```bash
# 1. Check recent executions
cd /home/yb/codes/AgentX
source .env
curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "https://n8n.specialblend.icu/api/v1/executions?status=error&limit=5" | \
  jq '.data[] | {id, workflowName: .workflowData.name, error: .data.resultData.error}'

# 2. Get detailed error for specific execution
EXECUTION_ID="<id-from-above>"
curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "https://n8n.specialblend.icu/api/v1/executions/$EXECUTION_ID" | \
  jq '.data.resultData.error'

# 3. Check n8n logs
docker logs n8n --tail 100

# 4. Check AgentX logs
pm2 logs agentx --lines 100
```

**Common Causes & Solutions:**

**A. AgentX /api/chat endpoint unreachable:**
```bash
# Test endpoint directly
curl -s -X POST http://192.168.2.33:3080/api/chat \
  -H "Content-Type: application/json" \
  -H "x-api-key: $AGENTX_API_KEY" \
  -d '{"message":"test","model":"qwen2.5:7b-instruct-q4_0"}'

# If 401: Check API key
grep AGENTX_API_KEY /home/yb/codes/AgentX/.env

# If connection refused: Check if AgentX is running
pm2 status agentx
pm2 restart agentx
```

**B. DataAPI unreachable:**
```bash
# Test DataAPI
curl -s http://192.168.2.33:3003/health

# If down, restart
pm2 status dataapi
pm2 restart dataapi

# Check DataAPI logs
pm2 logs dataapi --lines 50
```

**C. Invalid JSON in workflow:**
```bash
# Validate workflow JSON
cd /home/yb/codes/AgentX/AgentC
jq empty N3.2.json && echo "Valid JSON" || echo "Invalid JSON"

# Check for common issues
jq '.connections' N3.2.json  # Should use node names, not IDs
```

**D. Node timeout:**
```bash
# Check n8n workflow timeout settings
curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "https://n8n.specialblend.icu/api/v1/workflows/$WORKFLOW_ID" | \
  jq '.settings.executionTimeout'

# Increase if needed (in n8n UI or workflow JSON)
```

**Verification:**
```bash
# Test workflow end-to-end
curl -s -X POST https://n8n.specialblend.icu/webhook/sbqc-ai-query \
  -H "Content-Type: application/json" \
  -d '{"message":"test"}' | jq '.success'
```

---

### Issue 5: Connection Issues (AgentX, DataAPI, n8n)

**Symptoms:**
- `ECONNREFUSED` errors
- `ETIMEDOUT` errors
- 503 Service Unavailable

**Diagnostic Steps:**

```bash
# 1. Check all services
pm2 status
docker ps

# 2. Check network interfaces
ip addr show | grep "inet "

# 3. Check firewall
sudo iptables -L -n | grep -E "(3003|3080|5678)"

# 4. Check port listeners
sudo netstat -tlnp | grep -E "(3003|3080|5678|11434)"

# 5. Test localhost vs IP
curl -s http://localhost:3080/health
curl -s http://192.168.2.33:3080/health
```

**Solutions:**

**A. Service is down:**
```bash
# Restart services
pm2 restart all

# If MongoDB is down
sudo systemctl status mongodb
sudo systemctl restart mongodb

# If n8n is down
docker restart n8n

# If Ollama is down
sudo systemctl status ollama
sudo systemctl restart ollama
```

**B. Port conflict:**
```bash
# Check what's using the port
sudo lsof -i :3080
sudo lsof -i :3003

# If wrong process, kill it
sudo kill -9 <PID>

# Restart correct service
pm2 restart agentx
pm2 restart dataapi
```

**C. Firewall blocking:**
```bash
# Allow ports (Ubuntu/Debian)
sudo ufw allow 3003/tcp
sudo ufw allow 3080/tcp
sudo ufw reload

# Or disable firewall temporarily for testing
sudo ufw disable
```

**D. Wrong IP address:**
```bash
# Check actual IP
hostname -I

# Update .env files
cd /home/yb/codes/AgentX
sed -i 's/192.168.2.XX/192.168.2.33/g' .env

cd /home/yb/codes/DataAPI
sed -i 's/192.168.2.XX/192.168.2.33/g' .env

# Restart services
pm2 restart all
```

**Verification:**
```bash
# Test all connections
curl http://192.168.2.33:3080/health
curl http://192.168.2.33:3003/health
curl https://n8n.specialblend.icu/webhook/sbqc-health | jq '.overall_status'
```

---

### Issue 6: Deployment Failures

**Symptoms:**
- `./scripts/deploy-n8n-workflows.sh` fails
- "Workflow not found" errors
- Nodes disconnected after deployment

**Diagnostic Steps:**

```bash
# 1. Check API connectivity
cd /home/yb/codes/AgentX
./scripts/deploy-n8n-workflows.sh --check

# 2. Check environment variables
source .env
echo "N8N_API_KEY: ${N8N_API_KEY:0:10}..."
echo "N8N_URL: $N8N_URL"

# 3. Validate workflow JSON
cd AgentC
jq empty N3.2.json && echo "Valid" || echo "Invalid"

# 4. Check for connection issues
jq '.connections' N3.2.json
```

**Solutions:**

**A. Missing N8N_API_KEY:**
```bash
# Get API key from n8n UI
# Settings -> API -> Create New API Key

# Add to .env
echo "N8N_API_KEY=your-key-here" >> /home/yb/codes/AgentX/.env
source /home/yb/codes/AgentX/.env
```

**B. Connections use IDs instead of names:**
```bash
# Fix connections automatically
cd /home/yb/codes/AgentX
jq -f scripts/fix-workflow-connections.jq AgentC/N3.2.json > AgentC/N3.2-fixed.json
mv AgentC/N3.2-fixed.json AgentC/N3.2.json

# Redeploy
./scripts/deploy-n8n-workflows.sh N3.2.json
```

**C. Workflow name mismatch:**
```bash
# Check workflow name in JSON
jq -r '.name' AgentC/N3.2.json

# List existing workflows
curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "https://n8n.specialblend.icu/api/v1/workflows" | \
  jq '.data[] | {id, name}'
```

**D. n8n API unreachable:**
```bash
# Test n8n API directly
curl -I https://n8n.specialblend.icu/api/v1/workflows

# Check Docker logs
docker logs n8n --tail 50

# Restart n8n
docker restart n8n
sleep 10
```

**Verification:**
```bash
# Deploy test workflow
./scripts/deploy-n8n-workflows.sh N0.0-test-deployment.json

# Activate and test
source .env
WORKFLOW_ID=$(curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "https://n8n.specialblend.icu/api/v1/workflows" | \
  jq -r '.data[] | select(.name | contains("Deployment Test")) | .id')
curl -X POST -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "https://n8n.specialblend.icu/api/v1/workflows/$WORKFLOW_ID/activate"
curl -s https://n8n.specialblend.icu/webhook/test-deployment | jq '.status'
```

---

### Issue 7: Authentication Issues

**Symptoms:**
- 401 Unauthorized
- 403 Forbidden
- "x-api-key header required"

**Diagnostic Steps:**

```bash
# 1. Check AgentX authentication
curl -s -X POST http://192.168.2.33:3080/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"test"}' | jq '.error'

# Should return: "x-api-key header required" or similar

# 2. Test with API key
cd /home/yb/codes/AgentX
source .env
curl -s -X POST http://192.168.2.33:3080/api/chat \
  -H "Content-Type: application/json" \
  -H "x-api-key: $AGENTX_API_KEY" \
  -d '{"message":"test"}' | jq '.success'

# 3. Check n8n API key
curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "https://n8n.specialblend.icu/api/v1/workflows" | jq '.data | length'
```

**Solutions:**

**A. Missing API keys in .env:**
```bash
# Generate new keys
cd /home/yb/codes/AgentX
node -e "const crypto = require('crypto');
console.log('AGENTX_API_KEY=' + crypto.randomBytes(32).toString('hex'));
console.log('N8N_API_KEY=<get-from-n8n-ui>');"

# Add to .env
nano .env
# Restart services
pm2 restart agentx
```

**B. API key mismatch between AgentX and workflows:**
```bash
# Check workflow HTTP Request node credentials
cd /home/yb/codes/AgentX/AgentC
jq '.nodes[] | select(.type == "n8n-nodes-base.httpRequest") | .parameters.headerParameters' N3.2.json

# Should include: {"name": "x-api-key", "value": "={{ $env.AGENTX_API_KEY }}"}

# Update n8n environment variables
# n8n UI -> Settings -> Environment Variables
# Add: AGENTX_API_KEY=<value-from-agentx-.env>
```

**C. DataAPI API key mismatch:**
```bash
# Check DataAPI .env
grep DATAAPI_API_KEY /home/yb/codes/DataAPI/.env

# Check AgentX .env
grep DATAAPI_API_KEY /home/yb/codes/AgentX/.env

# Should match! If not, sync them
# Restart services
pm2 restart all
```

**Verification:**
```bash
# Test authenticated endpoints
source /home/yb/codes/AgentX/.env

curl -s -X POST http://192.168.2.33:3080/api/chat \
  -H "Content-Type: application/json" \
  -H "x-api-key: $AGENTX_API_KEY" \
  -d '{"message":"test","model":"qwen2.5:7b-instruct-q4_0"}' | jq '.success'

# Should return: true
```

---

## Health Check Procedures

### Full System Health Check

Run this comprehensive check to assess entire SBQC stack:

```bash
#!/bin/bash
# Save as: /home/yb/codes/AgentX/scripts/health-check.sh
# chmod +x scripts/health-check.sh

echo "=== SBQC System Health Check ==="
echo ""

# 1. Services
echo "1. Service Status:"
pm2 status | grep -E "(agentx|dataapi)"
docker ps | grep -E "(n8n|mongo)" | awk '{print $NF, $7}'
sudo systemctl is-active ollama
echo ""

# 2. Health Endpoints
echo "2. Health Endpoints:"
echo -n "AgentX: "
curl -s -m 5 http://192.168.2.33:3080/health | jq -r '.status' || echo "FAILED"
echo -n "DataAPI: "
curl -s -m 5 http://192.168.2.33:3003/health | jq -r '.status' || echo "FAILED"
echo -n "n8n: "
curl -s -m 5 https://n8n.specialblend.icu/webhook/sbqc-health | jq -r '.overall_status' || echo "FAILED"
echo ""

# 3. Database
echo "3. Database:"
mongosh --quiet --eval "db.adminCommand('ping').ok" mongodb://localhost:27017/agentx && echo "MongoDB: OK" || echo "MongoDB: FAILED"
echo ""

# 4. AI Service
echo "4. Ollama:"
curl -s -m 5 http://localhost:11434/api/tags | jq -r '.models | length' | xargs -I {} echo "Models available: {}"
echo ""

# 5. Webhooks
echo "5. Webhook Tests:"
echo -n "Deployment Test: "
curl -s -m 5 https://n8n.specialblend.icu/webhook/test-deployment | jq -r '.status' || echo "FAILED"
echo ""

# 6. Disk Space
echo "6. Disk Space:"
df -h | grep -E "(Filesystem|/$|/home)"
echo ""

# 7. Memory
echo "7. Memory:"
free -h | grep -E "(Mem|Swap)"
echo ""

echo "=== Health Check Complete ==="
```

**Usage:**
```bash
cd /home/yb/codes/AgentX
chmod +x scripts/health-check.sh
./scripts/health-check.sh
```

---

### Component-Specific Health Checks

#### AgentX Detailed Health

```bash
# Full health endpoint
curl -s http://192.168.2.33:3080/health/detailed | jq '.'

# Check specific subsystems
curl -s http://192.168.2.33:3080/api/dashboard/health | jq '.'

# Voice service health
curl -s http://192.168.2.33:3080/api/voice/health | jq '.'

# Check recent conversations
mongosh --quiet mongodb://localhost:27017/agentx --eval '
  db.conversations.find().sort({updatedAt: -1}).limit(5).forEach(c =>
    print(c.updatedAt + " | " + c.model + " | " + c.messages.length + " messages")
  )
'

# Check error logs
pm2 logs agentx --lines 50 --nostream | grep -i error
```

#### DataAPI Detailed Health

```bash
# Health endpoint
curl -s http://192.168.2.33:3003/health | jq '.'

# Check database collections
mongosh --quiet mongodb://localhost:27017/dataapi --eval '
  db.getCollectionNames().forEach(name => {
    print(name + ": " + db[name].countDocuments() + " documents");
  })
'

# Check recent logs
pm2 logs dataapi --lines 50 --nostream
```

#### n8n Detailed Health

```bash
cd /home/yb/codes/AgentX
source .env

# Check workflow status
curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "https://n8n.specialblend.icu/api/v1/workflows" | \
  jq '.data[] | {name, active, id}'

# Check recent executions
curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "https://n8n.specialblend.icu/api/v1/executions?limit=10" | \
  jq '.data[] | {finished: .finished, status: .status, workflow: .workflowData.name}'

# Check for errors in last hour
curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "https://n8n.specialblend.icu/api/v1/executions?status=error" | \
  jq '.data[0:5] | .[] | {time: .stoppedAt, workflow: .workflowData.name}'
```

#### Ollama Health

```bash
# Check running models
curl -s http://localhost:11434/api/ps | jq '.'

# List available models
curl -s http://localhost:11434/api/tags | jq '.models[] | {name, size: .size}'

# Test inference speed
time curl -s http://localhost:11434/api/generate -d '{
  "model": "qwen2.5:7b-instruct-q4_0",
  "prompt": "Count to 3",
  "stream": false
}' | jq -r '.response'

# Check GPU usage (if applicable)
nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv
```

---

## Workflow Debugging Steps

### Step 1: Identify the Failing Workflow

```bash
cd /home/yb/codes/AgentX
source .env

# List all workflows
curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "https://n8n.specialblend.icu/api/v1/workflows" | \
  jq '.data[] | {id, name, active}'

# Check recent failed executions
curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "https://n8n.specialblend.icu/api/v1/executions?status=error&limit=5" | \
  jq '.data[] | {id, workflow: .workflowData.name, error: .data.resultData.error.message}'
```

### Step 2: Analyze Execution Logs

```bash
# Get specific execution details
EXECUTION_ID="<id-from-above>"
curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "https://n8n.specialblend.icu/api/v1/executions/$EXECUTION_ID" | \
  jq '.data | {
    status: .status,
    startedAt: .startedAt,
    stoppedAt: .stoppedAt,
    error: .data.resultData.error,
    lastNode: .data.resultData.lastNodeExecuted
  }'
```

### Step 3: Test Workflow Components Individually

```bash
# Test webhook trigger (for webhook workflows)
curl -v https://n8n.specialblend.icu/webhook/<webhook-path>

# Test AgentX endpoint directly
curl -s -X POST http://192.168.2.33:3080/api/chat \
  -H "Content-Type: application/json" \
  -H "x-api-key: $AGENTX_API_KEY" \
  -d '{
    "message": "test",
    "model": "qwen2.5:7b-instruct-q4_0",
    "useRag": false
  }' | jq '.'

# Test DataAPI endpoint directly
curl -s http://192.168.2.33:3003/api/v1/<endpoint>
```

### Step 4: Validate Workflow JSON

```bash
cd /home/yb/codes/AgentX/AgentC

# Check JSON validity
jq empty N3.2.json && echo "Valid JSON" || echo "Invalid JSON"

# Check webhook node configuration
jq '.nodes[] | select(.type == "n8n-nodes-base.webhook") | {
  path: .parameters.path,
  httpMethod: .parameters.httpMethod,
  responseMode: .parameters.responseMode,
  webhookId: .webhookId
}' N3.2.json

# Check HTTP Request nodes
jq '.nodes[] | select(.type == "n8n-nodes-base.httpRequest") | {
  name: .name,
  url: .parameters.url,
  method: .parameters.method
}' N3.2.json

# Check connections (should use node names)
jq '.connections' N3.2.json
```

### Step 5: Test in n8n UI

1. Open n8n UI: `https://n8n.specialblend.icu`
2. Find the workflow
3. Click "Execute Workflow" button
4. Check each node's output/error in the UI
5. Look for red X marks indicating failed nodes

### Step 6: Check Dependencies

```bash
# Check if AgentX is responding
curl -s http://192.168.2.33:3080/health | jq '.details'

# Check if DataAPI is responding
curl -s http://192.168.2.33:3003/health

# Check if Ollama is responding
curl -s http://localhost:11434/api/tags | jq '.models | length'

# Check if MongoDB is responding
mongosh --quiet --eval "db.adminCommand('ping')" mongodb://localhost:27017/agentx
```

### Step 7: Fix and Redeploy

```bash
# After fixing the workflow JSON:
cd /home/yb/codes/AgentX

# Validate
jq empty AgentC/N3.2.json

# Deploy
./scripts/deploy-n8n-workflows.sh N3.2.json

# Activate
source .env
WORKFLOW_ID=$(curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "https://n8n.specialblend.icu/api/v1/workflows" | \
  jq -r '.data[] | select(.name | contains("AI Gateway")) | .id')
curl -X POST -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "https://n8n.specialblend.icu/api/v1/workflows/$WORKFLOW_ID/activate"

# Test
curl -s -X POST https://n8n.specialblend.icu/webhook/sbqc-ai-query \
  -H "Content-Type: application/json" \
  -d '{"message":"test"}' | jq '.'
```

---

## Performance Troubleshooting

### Identify Performance Bottlenecks

```bash
# 1. Check system resources
htop
iotop  # Disk I/O
nethogs  # Network usage

# 2. Check service response times
time curl -s http://192.168.2.33:3080/health
time curl -s http://192.168.2.33:3003/health
time curl -s http://localhost:11434/api/tags

# 3. Database performance
mongosh --quiet mongodb://localhost:27017/agentx --eval '
  db.conversations.find().explain("executionStats")
' | jq '.executionStats.executionTimeMillis'

# 4. Ollama performance
time curl -s http://localhost:11434/api/generate -d '{
  "model": "qwen2.5:7b-instruct-q4_0",
  "prompt": "Say hi",
  "stream": false
}'
```

### Optimize AgentX Performance

```bash
# 1. Check conversation count
mongosh --quiet mongodb://localhost:27017/agentx --eval '
  db.conversations.countDocuments()
'

# 2. Archive old conversations
mongosh mongodb://localhost:27017/agentx --eval '
  const cutoff = new Date(Date.now() - 30*24*60*60*1000); // 30 days ago
  db.conversations.updateMany(
    {updatedAt: {$lt: cutoff}},
    {$set: {archived: true}}
  );
'

# 3. Check index usage
mongosh mongodb://localhost:27017/agentx --eval '
  db.conversations.getIndexes()
'

# 4. Create missing indexes
cd /home/yb/codes/AgentX
node scripts/create-indexes.js

# 5. Restart AgentX
pm2 restart agentx
```

### Optimize DataAPI Performance

```bash
# 1. Check collection sizes
mongosh --quiet mongodb://localhost:27017/dataapi --eval '
  db.getCollectionNames().forEach(name => {
    const stats = db[name].stats();
    print(name + ": " + (stats.size / 1024 / 1024).toFixed(2) + " MB");
  })
'

# 2. Compact database (if needed)
mongosh mongodb://localhost:27017/dataapi --eval '
  db.runCommand({compact: "your_large_collection"})
'

# 3. Restart DataAPI
pm2 restart dataapi
```

### Optimize Ollama Performance

```bash
# 1. Use GPU acceleration (if available)
nvidia-smi
# If GPU available, ensure Ollama is using it

# 2. Adjust parallel requests
sudo nano /etc/systemd/system/ollama.service
# Add: Environment="OLLAMA_NUM_PARALLEL=4"
sudo systemctl daemon-reload
sudo systemctl restart ollama

# 3. Use quantized models for speed
curl -s http://localhost:11434/api/tags | jq '.models[] | select(.name | contains("q4_0"))'

# 4. Unload unused models
curl -s -X POST http://localhost:11434/api/generate -d '{
  "model": "unused-model:latest",
  "keep_alive": 0
}'
```

### Optimize n8n Performance

```bash
# 1. Check execution history size
cd /home/yb/codes/AgentX
source .env
curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "https://n8n.specialblend.icu/api/v1/executions" | jq '.data | length'

# 2. Prune old executions (via n8n UI)
# Settings -> Log Streaming -> Execution Retention -> Set to 7 days

# 3. Optimize workflow settings
# In each workflow JSON, set:
# "settings": {
#   "executionTimeout": 300,
#   "saveExecutionProgress": false,
#   "saveManualExecutions": false
# }

# 4. Restart n8n
docker restart n8n
```

---

## Emergency Procedures

### Emergency 1: Complete System Down

**Symptoms:** All services unreachable

**Action:**

```bash
# 1. Check if server is responsive
ping 192.168.2.33

# 2. SSH into server
ssh user@192.168.2.33

# 3. Check system load
uptime
free -h
df -h

# 4. Start all services
sudo systemctl start mongodb
sudo systemctl start ollama
docker start n8n
pm2 resurrect

# 5. Verify
./home/yb/codes/AgentX/scripts/health-check.sh
```

### Emergency 2: MongoDB Crashed

**Symptoms:** All APIs return database connection errors

**Action:**

```bash
# 1. Check MongoDB status
sudo systemctl status mongodb

# 2. Check logs
sudo journalctl -u mongodb -n 100

# 3. Check disk space (common cause)
df -h

# 4. Restart MongoDB
sudo systemctl restart mongodb

# 5. Verify connection
mongosh --eval "db.adminCommand('ping')"

# 6. Restart dependent services
pm2 restart all

# 7. Test
curl http://192.168.2.33:3080/health
```

### Emergency 3: Ollama Out of Memory

**Symptoms:**
- Ollama not responding
- System swap usage at 100%
- AI requests timeout

**Action:**

```bash
# 1. Check memory
free -h
ps aux | grep ollama | head -1

# 2. Kill Ollama process (will auto-restart if systemd service)
sudo pkill ollama

# 3. Or restart service
sudo systemctl restart ollama

# 4. Unload large models
curl -X POST http://localhost:11434/api/generate -d '{
  "model": "large-model:latest",
  "keep_alive": 0
}'

# 5. Use smaller models temporarily
# Edit workflows to use "qwen2.5:3b-instruct-q4_0" instead of 7b

# 6. Add swap space (if needed)
sudo fallocate -l 8G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

### Emergency 4: n8n Database Corruption

**Symptoms:**
- n8n won't start
- Docker logs show database errors
- Workflows disappeared

**Action:**

```bash
# 1. Stop n8n
docker stop n8n

# 2. Backup n8n data
cd /path/to/n8n/data  # Check docker-compose.yml for volume path
sudo tar -czf n8n-backup-$(date +%Y%m%d-%H%M%S).tar.gz .

# 3. Check n8n database
# If using SQLite:
sqlite3 database.sqlite "PRAGMA integrity_check;"

# 4. Restore from backup (if needed)
# Restore latest backup from backups/

# 5. Start n8n
docker start n8n

# 6. Redeploy workflows
cd /home/yb/codes/AgentX
./scripts/deploy-n8n-workflows.sh
```

### Emergency 5: Disk Full

**Symptoms:**
- Services crash randomly
- "No space left on device" errors

**Action:**

```bash
# 1. Check disk usage
df -h
du -sh /var/* | sort -h | tail -10
du -sh /home/* | sort -h | tail -10

# 2. Clean Docker
docker system prune -a --volumes -f

# 3. Clean logs
sudo journalctl --vacuum-time=7d
pm2 flush  # Clear pm2 logs

# 4. Clean MongoDB old data (if safe)
mongosh mongodb://localhost:27017/agentx --eval '
  const cutoff = new Date(Date.now() - 90*24*60*60*1000);
  db.conversations.deleteMany({updatedAt: {$lt: cutoff}, archived: true});
'

# 5. Clean system
sudo apt-get clean
sudo apt-get autoremove

# 6. Restart services
pm2 restart all
docker restart n8n
```

### Emergency 6: Security Breach / Suspicious Activity

**Symptoms:**
- Unusual API traffic
- Unknown processes
- Unauthorized access attempts

**Action:**

```bash
# 1. IMMEDIATE: Block external access
sudo ufw enable
sudo ufw deny 3003
sudo ufw deny 3080

# 2. Check active connections
sudo netstat -anp | grep -E "(3003|3080)"

# 3. Check logs for suspicious activity
pm2 logs agentx --lines 1000 --nostream | grep -E "(error|unauthorized|failed)"
pm2 logs dataapi --lines 1000 --nostream | grep -E "(error|unauthorized|failed)"

# 4. Rotate API keys
cd /home/yb/codes/AgentX
node -e "const crypto = require('crypto');
console.log('NEW_AGENTX_API_KEY=' + crypto.randomBytes(32).toString('hex'));"

# Update .env files
nano .env

# 5. Restart services with new keys
pm2 restart all

# 6. Check for backdoors
sudo find / -name "*.sh" -mtime -1 2>/dev/null
sudo find / -perm /4000 -mtime -1 2>/dev/null

# 7. Update n8n API keys
# n8n UI -> Settings -> API -> Revoke old keys -> Create new

# 8. Review and document incident
# Document: what happened, when, what was accessed, remediation
```

---

## Appendix: Command Reference

### Quick Commands

```bash
# Service Management
pm2 status                          # Check pm2 services
pm2 restart all                     # Restart all pm2 services
pm2 logs agentx --lines 100         # View AgentX logs
sudo systemctl restart mongodb      # Restart MongoDB
sudo systemctl restart ollama       # Restart Ollama
docker restart n8n                  # Restart n8n

# Health Checks
curl http://192.168.2.33:3080/health
curl http://192.168.2.33:3003/health
curl https://n8n.specialblend.icu/webhook/sbqc-health

# Database
mongosh mongodb://localhost:27017/agentx
mongosh mongodb://localhost:27017/dataapi

# Workflow Deployment
cd /home/yb/codes/AgentX
./scripts/deploy-n8n-workflows.sh N3.2.json
./scripts/deploy-n8n-workflows.sh --check

# Workflow Activation
source .env
WORKFLOW_ID="<id>"
curl -X POST -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "https://n8n.specialblend.icu/api/v1/workflows/$WORKFLOW_ID/activate"

# Testing
curl -s -X POST https://n8n.specialblend.icu/webhook/sbqc-ai-query \
  -H "Content-Type: application/json" \
  -d '{"message":"test"}' | jq '.'
```

### File Locations

```
/home/yb/codes/AgentX/           # AgentX main directory
├── .env                          # Environment variables
├── server.js                     # Main server file
├── AgentC/                       # n8n workflow JSONs
├── scripts/
│   ├── deploy-n8n-workflows.sh  # Deployment script
│   └── fix-workflow-connections.jq  # Connection fixer
└── docs/
    ├── TROUBLESHOOTING.md        # This file
    ├── API.md                    # API documentation
    └── AgentC/WORKFLOW-GUIDE.md  # Workflow development guide

/home/yb/codes/DataAPI/          # DataAPI directory
├── .env                          # Environment variables
├── data_serv.js                  # Main server file

n8n URL: https://n8n.specialblend.icu
n8n API: https://n8n.specialblend.icu/api/v1
```

### Environment Variables

```bash
# AgentX (.env)
PORT=3080
MONGODB_URI=mongodb://localhost:27017/agentx
OLLAMA_HOST=http://localhost:11434
AGENTX_API_KEY=<secret>
DATAAPI_BASE_URL=http://192.168.2.33:3003
DATAAPI_API_KEY=<secret>
N8N_API_KEY=<secret>
N8N_WEBHOOK_BASE_URL=https://n8n.specialblend.icu/webhook

# DataAPI (.env)
PORT=3003
MONGODB_URI=mongodb://localhost:27017/dataapi
DATAAPI_API_KEY=<secret>

# Load variables
source /home/yb/codes/AgentX/.env
```

### Log Locations

```bash
# pm2 logs
~/.pm2/logs/

# MongoDB logs
sudo journalctl -u mongodb

# Ollama logs
sudo journalctl -u ollama

# n8n logs
docker logs n8n

# System logs
/var/log/syslog
```

---

## Support & Resources

### Documentation

- [Workflow Development Guide](/home/yb/codes/AgentX/AgentC/WORKFLOW-GUIDE.md)
- [API Documentation](/home/yb/codes/AgentX/docs/API.md)
- [Authentication Guide](/home/yb/codes/AgentX/docs/AUTHENTICATION.md)
- [Security Hardening](/home/yb/codes/AgentX/docs/SECURITY_HARDENING.md)

### External Resources

- [n8n Documentation](https://docs.n8n.io/)
- [Ollama Documentation](https://ollama.ai/docs)
- [MongoDB Documentation](https://docs.mongodb.com/)
- [Express.js Guide](https://expressjs.com/en/guide/routing.html)

### Getting Help

1. Check this troubleshooting guide first
2. Review relevant logs (pm2, docker, journalctl)
3. Test components individually
4. Check n8n execution history for workflow errors
5. Consult workflow guide for deployment issues

### Contributing Fixes

When you discover and fix a new issue:

1. Document the symptoms, root cause, and solution
2. Add diagnostic commands
3. Update this guide with a new issue section
4. Commit changes to git

```bash
cd /home/yb/codes/AgentX
git add docs/TROUBLESHOOTING.md
git commit -m "docs: add troubleshooting for [issue description]"
git push
```

---

**Document Version:** 1.0.0
**Last Updated:** 2026-01-02
**Maintained By:** SBQC Team
