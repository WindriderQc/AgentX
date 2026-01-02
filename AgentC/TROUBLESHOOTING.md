# n8n Workflow Troubleshooting Guide

Quick reference for diagnosing and fixing common workflow issues.

**Last Updated**: January 2, 2026

---

## 🔍 Quick Diagnostic Commands

### Check Service Health
```bash
# n8n
curl http://192.168.2.199:5678/healthz
# Expected: {"status":"ok"}

# DataAPI
curl http://192.168.2.33:3003/health
# Expected: {"status":"ok",...}

# AgentX
curl http://192.168.2.33:3080/health
# Expected: {"status":"healthy",...}

# Ollama (UGFrank)
curl http://192.168.2.99:11434/api/tags
# Expected: {"models":[...]}

# Ollama (UGBrutal)
curl http://192.168.2.12:11434/api/tags
# Expected: {"models":[...]}
```

### Check Workflow Status
```bash
# List all active workflows (via n8n UI)
http://192.168.2.199:5678/workflows

# Check recent executions
http://192.168.2.199:5678/executions

# View DataAPI event log
curl -H "x-api-key: KEY" http://192.168.2.33:3003/integrations/events/n8n | jq '.data[-10:]'
```

---

## ❌ Common Error Patterns

### 1. "Cannot assign to read only property 'name'"

**Symptom**: Workflow fails in Code node with this error

**Cause**: Using `$node` with merged inputs (n8n limitation)

**Fix**: Use `$input` instead
```javascript
// ❌ WRONG
const frank = $node["Ping UGFrank (99)"].json;

// ✅ CORRECT
const frank = $input.first().json;
const brutal = $input.all()[1]?.json || {};
```

**Affected Workflows**: N3.1 (already fixed)

**Reference**: [WORKFLOW_CHANGES.md](WORKFLOW_CHANGES.md) - N3.1 fix

---

### 2. "maxBuffer length exceeded"

**Symptom**: Execute Command node fails with buffer error

**Cause**: `find` command returns too much data (> default buffer limit)

**Fix Options**:

**Option A**: Limit output
```bash
# Add head to limit results
find /mnt/datalake -type f -name "*.txt" | head -1000
```

**Option B**: Increase buffer in node settings
```json
{
  "parameters": {
    "command": "find ...",
    "options": {
      "maxBuffer": 10485760  // 10MB instead of 1MB
    }
  }
}
```

**Option C**: Split by directory
```bash
# Scan one directory at a time
for dir in /mnt/media/*; do
  find "$dir" -type f
done
```

**Affected Workflows**: N2.1, N2.2 (potential issue)

---

### 3. "Connection timeout" / "ECONNREFUSED"

**Symptom**: HTTP Request node fails to reach endpoint

**Diagnostic Steps**:
```bash
# 1. Check service is running
systemctl status <service>  # or pm2 status

# 2. Check from n8n host
ssh root@192.168.2.199
curl http://192.168.2.33:3003/health

# 3. Check firewall
sudo ufw status
# or
sudo iptables -L -n

# 4. Check network route
ping 192.168.2.33
traceroute 192.168.2.33
```

**Common Causes**:
- Service down (restart with `pm2 restart` or `systemctl restart`)
- Firewall blocking port
- Wrong IP address (check if service moved)
- DNS resolution issue (use IP instead of hostname)

**Fix**:
1. Restart target service
2. Update firewall rules
3. Verify IP in workflow JSON
4. Add `continueOnFail: true` if non-critical

---

### 4. "find: invalid predicate `-printf`"

**Symptom**: Find command fails on BusyBox/Alpine

**Cause**: BusyBox `find` doesn't support GNU options like `-printf`

**Fix**: Use `stat` instead
```bash
# ❌ WRONG (GNU find only)
find /path -type f -printf "%p|%s|%T@\n"

# ✅ CORRECT (BusyBox compatible)
find /path -type f -exec stat -c "%n|%s|%Y" {} + 2>/dev/null
```

**Affected Workflows**: N2.3 (already fixed)

**Reference**: [WORKFLOW_CHANGES.md](WORKFLOW_CHANGES.md) - N2.3 BusyBox fix

---

### 5. "Authentication failed" / "x-api-key required"

**Symptom**: HTTP node returns 401 Unauthorized

**Diagnostic**:
```bash
# Test auth manually
curl -H "x-api-key: YOUR_KEY" http://192.168.2.33:3003/api/v1/files/browse

# If works: Credential issue in n8n
# If fails: API key invalid/expired
```

**Fix**:
1. **Check credential in n8n**:
   - Settings → Credentials → Find credential
   - Verify header name: `x-api-key`
   - Verify key matches `.env` value

2. **Rotate API key if needed**:
   ```bash
   # Generate new
   openssl rand -hex 32

   # Update in DataAPI .env
   nano /home/yb/codes/DataAPI/.env
   pm2 restart dataapi

   # Update in n8n credential store
   ```

3. **Check node configuration**:
   ```json
   {
     "authentication": "genericCredentialType",
     "genericAuthType": "httpHeaderAuth",
     "credentials": {
       "httpHeaderAuth": {
         "id": "PIrrA2wpOppzVodi"
       }
     }
   }
   ```

---

### 6. Webhook Returns 404 Not Found

**Symptom**: Curl to webhook URL returns 404

**Diagnostic**:
```bash
# Check workflow is active
# In n8n UI: Workflows → [Workflow] → Check toggle is ON

# Check webhook path matches
curl https://n8n.specialblend.icu/webhook/sbqc-n1-1-health-check
# Path must exactly match workflow JSON
```

**Common Causes**:
1. Workflow inactive (toggle OFF)
2. Webhook path mismatch
3. n8n restarted and workflows not reloaded
4. Multiple workflows with same webhook (conflict)

**Fix**:
1. Activate workflow in UI
2. Verify path in workflow JSON: `"path": "sbqc-n1-1-health-check"`
3. Restart n8n if needed: `docker restart n8n`
4. Check for duplicate webhooks: Settings → Webhooks

---

### 7. "Cannot read property 'json' of undefined"

**Symptom**: Code node crashes accessing `$json` or `$input`

**Cause**: Previous node returned empty/error, no data available

**Fix**: Add null checks
```javascript
// ❌ WRONG
const data = $input.first().json.models;

// ✅ CORRECT
const data = $input.first()?.json?.models || [];

// Or check explicitly
if (!$input.first() || !$input.first().json) {
  return [{ json: { error: "No data from previous node" } }];
}
```

**Best Practice**: Always use optional chaining (`?.`) when accessing node data

---

### 8. Workflow Runs But No Data in MongoDB

**Symptom**: Workflow completes successfully but no records in database

**Diagnostic**:
```bash
# Check MongoDB connection
mongo --eval "db.adminCommand('ping')"

# Check specific collection
mongo SBQC --eval "db.nasFiles.count()"
mongo SBQC --eval "db.nasFiles.find().limit(5).pretty()"

# Check DataAPI logs
pm2 logs dataapi | grep -i error
```

**Common Causes**:
1. MongoDB connection string wrong in DataAPI
2. Collection name mismatch
3. Validation error (data doesn't match schema)
4. Permissions issue (MongoDB auth)

**Fix**:
1. Verify DataAPI `.env` MongoDB settings
2. Check collection names match code
3. Review DataAPI logs for validation errors
4. Test MongoDB write manually:
   ```javascript
   db.nasFiles.insertOne({
     path: "/test",
     ext: "txt",
     size: 100
   })
   ```

---

## 🔧 Workflow-Specific Issues

### N1.1 - System Health Check

**Issue**: Always reports "degraded" even when services are up

**Fix**: Check `isHttpOk()` function logic in "Aggregate Status" node
```javascript
// Ensure it checks for correct response format
function isHttpOk(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.error) return false;
  return true;
}
```

**Issue**: API key exposed in JSON (FIXED)

**Status**: Fixed in commit `da1de2e`. Deploy updated workflow.

---

### N2.3 - RAG Document Ingestion

**Issue**: "executeOnce" causing only first file to process

**Fix**: Ensure `"executeOnce": false` on loop nodes

**Issue**: File content replaced by cat stdout, losing metadata

**Fix**: Reference original file list from earlier node:
```javascript
const fileList = $("Filter Skipped").all();
```

**Issue**: Qdrant point count not increasing

**Diagnostic**:
```bash
# Check Qdrant collection
curl http://192.168.2.33:6333/collections/rag-documents

# Check AgentX logs
pm2 logs agentx | grep -i qdrant
```

---

### N3.1 - Model Health Monitor

**Issue**: "Cannot assign to read only property" (FIXED)

**Status**: Fixed in commit (see WORKFLOW_CHANGES.md)

**Issue**: Latency always shows "unknown"

**Fix**: Check response headers from Ollama:
```bash
curl -v http://192.168.2.99:11434/api/tags
# Look for X-Runtime or similar timing header
```

---

## 📊 Performance Issues

### Workflow Takes Too Long

**Symptoms**: Execution > 5 minutes, timeouts

**Diagnostic**:
```bash
# Check node execution times in n8n UI
# Workflows → [Workflow] → Executions → Click execution → View timings
```

**Common Bottlenecks**:
1. **Large find command**: Add filters or pagination
2. **HTTP timeouts**: Increase in node settings
3. **Heavy processing in Code node**: Move to external service
4. **MongoDB writes**: Batch inserts instead of individual

**Fixes**:
```json
// Increase HTTP timeout
{
  "options": {
    "timeout": 300000  // 5 minutes
  }
}

// Add pagination to find
find /path -type f | head -10000

// Batch MongoDB inserts (in DataAPI endpoint)
db.collection.insertMany(documents, { ordered: false })
```

---

## 🚨 Emergency Procedures

### Workflow Causing System Issues

**Immediate Actions**:
```bash
# 1. Deactivate workflow in n8n UI
http://192.168.2.199:5678/workflows → Toggle OFF

# 2. Kill running executions
# In n8n UI: Workflows → Executions → Stop all running

# 3. Check system resources
htop  # CPU/Memory
df -h  # Disk space
pm2 status  # Service health
```

### Database Full

```bash
# Check MongoDB size
du -sh /var/lib/mongodb

# Cleanup old data
mongo SBQC --eval "db.nasFiles.deleteMany({createdAt: {$lt: new Date('2025-01-01')}})"
mongo SBQC --eval "db.nas_scans.deleteMany({status: 'complete', createdAt: {$lt: new Date('2025-12-01')}})"

# Compact database
mongo SBQC --eval "db.runCommand({compact: 'nasFiles'})"
```

### n8n Unresponsive

```bash
# Restart n8n
docker restart n8n

# Or if using PM2
pm2 restart n8n

# Check logs
docker logs n8n --tail 100
# or
pm2 logs n8n
```

---

## 📝 Debugging Best Practices

### 1. Add Debug Logging

Insert Code nodes to log state:
```javascript
console.log('DEBUG:', JSON.stringify($json, null, 2));
return [$input.first()];
```

View logs:
```bash
# n8n Docker logs
docker logs -f n8n

# Or n8n stdout if running directly
tail -f ~/.n8n/logs/n8n.log
```

### 2. Test Nodes Individually

Use "Execute Node" button in n8n UI to test single nodes with sample data.

### 3. Use Manual Triggers

Always test with webhook/manual trigger before activating cron schedules.

### 4. Check continueOnFail Settings

Critical nodes should have `continueOnFail: true` to avoid hard failures.

### 5. Monitor First 24 Hours

After deploying new workflow:
- Check executions hourly
- Review DataAPI event logs
- Monitor resource usage

---

## 📚 Reference

- **n8n Docs**: https://docs.n8n.io/
- **MongoDB Docs**: https://docs.mongodb.com/
- **Workflow Changes**: [WORKFLOW_CHANGES.md](WORKFLOW_CHANGES.md)
- **Testing Guide**: [WORKFLOW_TESTING_GUIDE.md](WORKFLOW_TESTING_GUIDE.md)
- **Webhook URLs**: [README.md](README.md#available-webhook-endpoints)

---

## 🆘 Getting Help

1. **Check n8n Community**: https://community.n8n.io/
2. **Review workflow execution details in n8n UI**
3. **Check DataAPI/AgentX logs**: `pm2 logs <service>`
4. **Test endpoints manually with curl**
5. **Create GitHub issue** with:
   - Workflow name and version
   - Error message/screenshot
   - Steps to reproduce
   - Relevant logs
