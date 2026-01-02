# n8n Workflow Testing Guide

**Purpose**: Validate untested workflows before production activation
**Target Workflows**: N2.2, N3.2, N5.1
**Last Updated**: January 2, 2026

---

## 🧪 Testing Philosophy

1. **Test webhooks before activating schedules**
2. **Verify error handling with bad inputs**
3. **Check logging to DataAPI event sink**
4. **Validate end-to-end data flow**
5. **Monitor resource usage during execution**

---

## ⚠️ N2.2 - NAS Full Scan (Pending Test)

### Workflow Purpose
Weekly scan for non-standard file types across all NAS shares.

### Pre-Test Checklist
- [ ] Verify NAS mounts exist on n8n host:
  ```bash
  ssh root@192.168.2.199
  ls -la /mnt/media
  ls -la /mnt/datalake
  ```
- [ ] Check DataAPI `/api/v1/storage/scan` endpoint is responsive:
  ```bash
  curl -H "x-api-key: KEY" http://192.168.2.33:3003/api/v1/storage/scan
  ```
- [ ] Ensure MongoDB has space for results (workflow may create many records)

### Test Execution

#### Test 1: Webhook Trigger (Dry Run)
```bash
# Trigger via webhook
curl -X POST https://n8n.specialblend.icu/webhook/sbqc-n2-2-nas-full-scan \
  -H "Content-Type: application/json" \
  -d '{"test": true, "limit": 10}'

# Expected response: 200 OK with scan started confirmation
```

#### Test 2: Monitor Progress
```bash
# Check DataAPI for scan records
curl -H "x-api-key: KEY" http://192.168.2.33:3003/api/v1/storage/scans \
  | jq '.data[] | select(.status == "running" or .status == "complete") | {id, status, files_found, created_at}'
```

#### Test 3: Verify Results
```bash
# Check files were inserted
curl -H "x-api-key: KEY" "http://192.168.2.33:3003/api/v1/files/browse?limit=10" \
  | jq '.data[] | {path, ext, size, created_at}'
```

### Success Criteria
- ✅ Workflow completes without errors
- ✅ Scan record created in MongoDB (`nas_scans` collection)
- ✅ Files inserted into MongoDB (`nasFiles` collection)
- ✅ Event logged to DataAPI sink
- ✅ No timeout errors (adjust if needed)

### Known Issues
- **Large scans may timeout**: If scanning > 100K files, consider splitting by directory
- **Buffer overflow**: `find` command output may exceed n8n buffer (add `head -1000` for testing)

### Failure Scenarios to Test
```bash
# Test 1: Invalid path
curl -X POST https://n8n.specialblend.icu/webhook/sbqc-n2-2-nas-full-scan \
  -d '{"roots": ["/mnt/nonexistent"]}'

# Expected: Workflow handles error gracefully

# Test 2: DataAPI down
# Stop DataAPI temporarily, run workflow
# Expected: Workflow completes, logging fails gracefully (continueOnFail)
```

---

## 🤖 N3.2 - External AI Gateway (Built, Untested)

### Workflow Purpose
Public webhook endpoint for external systems to submit AI queries routed through AgentX.

### Pre-Test Checklist
- [ ] Verify AgentX `/api/chat` endpoint is working:
  ```bash
  curl -X POST http://192.168.2.33:3080/api/chat \
    -H "Content-Type: application/json" \
    -d '{"message": "Test query", "model": "qwen2.5:7b-instruct-q4_0"}'
  ```
- [ ] Check Ollama instances are online:
  ```bash
  curl http://192.168.2.99:11434/api/tags  # UGFrank
  curl http://192.168.2.12:11434/api/tags  # UGBrutal
  ```
- [ ] Ensure webhook is not publicly exposed without auth (security risk!)

### Test Execution

#### Test 1: Simple Query
```bash
curl -X POST https://n8n.specialblend.icu/webhook/sbqc-ai-query \
  -H "Content-Type: application/json" \
  -d '{
    "query": "What is the capital of France?",
    "model": "qwen2.5:7b-instruct-q4_0"
  }'

# Expected: JSON response with AI answer
```

#### Test 2: With RAG Enabled
```bash
curl -X POST https://n8n.specialblend.icu/webhook/sbqc-ai-query \
  -H "Content-Type: application/json" \
  -d '{
    "query": "What documentation exists about n8n workflows?",
    "useRag": true
  }'

# Expected: AI searches Qdrant and returns context-aware response
```

#### Test 3: Auto-Routing Test
```bash
# Code-related query (should route to qwen2.5-coder)
curl -X POST https://n8n.specialblend.icu/webhook/sbqc-ai-query \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Write a Python function to sort a list",
    "autoRoute": true
  }'

# Expected: Response includes "routedTo": "qwen2.5-coder:14b"
```

#### Test 4: Error Handling
```bash
# Test 1: Empty query
curl -X POST https://n8n.specialblend.icu/webhook/sbqc-ai-query \
  -H "Content-Type: application/json" \
  -d '{}'

# Expected: Error response with helpful message

# Test 2: Invalid model
curl -X POST https://n8n.specialblend.icu/webhook/sbqc-ai-query \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Test",
    "model": "nonexistent-model"
  }'

# Expected: Error response, workflow doesn't crash
```

### Success Criteria
- ✅ Webhook returns AI response in < 30 seconds
- ✅ RAG search works when `useRag: true`
- ✅ Auto-routing selects appropriate model
- ✅ Errors are handled gracefully
- ✅ Response includes metadata (model, latency, conversationId)

### Security Considerations
⚠️ **WARNING**: This webhook is publicly accessible. Consider:
- Add API key authentication (custom header)
- Rate limiting via n8n or CloudFlare
- Input validation (max query length, allowed models)
- Logging all queries for abuse monitoring

### Recommended Rate Limits
```javascript
// Add to workflow: Code node before AgentX call
const MAX_QUERY_LENGTH = 2000;
const query = $json.query || '';

if (query.length > MAX_QUERY_LENGTH) {
  throw new Error(`Query exceeds ${MAX_QUERY_LENGTH} characters`);
}

return [{ json: $json }];
```

---

## 📊 N5.1 - Feedback Analysis (Built, Untested)

### Workflow Purpose
Weekly analysis of user feedback to optimize prompts via A/B testing.

### Pre-Test Checklist
- [ ] Verify AgentX has feedback data:
  ```bash
  curl http://192.168.2.33:3080/api/analytics/feedback?from=2025-12-01
  ```
- [ ] Check if MongoDB has `feedback` collection with data
- [ ] Ensure AgentX `/api/prompts` endpoint is working

### Test Execution

#### Test 1: Manual Trigger
```bash
curl -X POST https://n8n.specialblend.icu/webhook/sbqc-n5-1-feedback-analysis \
  -H "Content-Type: application/json" \
  -d '{"dateRange": "7d", "minFeedbackCount": 5}'

# Expected: Workflow analyzes feedback and generates report
```

#### Test 2: Verify Output
```bash
# Check DataAPI event log for analysis results
curl -H "x-api-key: KEY" http://192.168.2.33:3003/integrations/events/n8n \
  | jq '.data[] | select(.event_type == "feedback_analysis_complete")'
```

#### Test 3: Check Prompt Updates
```bash
# See if any prompts were updated based on analysis
curl http://192.168.2.33:3080/api/prompts/ \
  | jq '.data[] | {name, versions: .versions | length}'
```

### Success Criteria
- ✅ Workflow retrieves feedback data from AgentX
- ✅ Analysis completes (may use AI for sentiment/categorization)
- ✅ Results logged to DataAPI event sink
- ✅ Recommendations generated for prompt improvements
- ✅ No errors even with minimal feedback data

### Edge Cases to Test
```bash
# Test 1: No feedback data
# Ensure MongoDB feedback collection is empty
# Run workflow
# Expected: Graceful handling, log "No feedback data available"

# Test 2: Malformed feedback
# Insert bad data into MongoDB (missing fields)
# Run workflow
# Expected: Workflow filters out invalid records, continues
```

---

## 📝 Test Results Template

Copy this template for each workflow test session:

```markdown
## Test Session: [WORKFLOW_NAME]

**Date**: YYYY-MM-DD
**Tester**: [Name]
**n8n Version**: [Check in n8n UI: Settings → About]
**Environment**: Production / Staging

### Test Results

| Test Case | Status | Duration | Notes |
|-----------|--------|----------|-------|
| Webhook Trigger | ✅ / ❌ | Xs | |
| Error Handling | ✅ / ❌ | Xs | |
| Logging to DataAPI | ✅ / ❌ | Xs | |
| End-to-End Flow | ✅ / ❌ | Xs | |

### Issues Found
1. [Issue description]
   - **Severity**: Critical / High / Medium / Low
   - **Reproduction**: [Steps]
   - **Fix**: [Proposed solution]

### Performance Metrics
- **Average execution time**: Xs
- **Memory usage**: XX MB
- **API calls made**: X
- **Records processed**: X

### Recommendations
- [ ] [Action item 1]
- [ ] [Action item 2]

### Sign-off
- [ ] All critical tests passed
- [ ] Known issues documented
- [ ] Ready for production activation
- [ ] Approved by: [Name]
```

---

## 🚀 Production Activation Checklist

Before activating scheduled execution:

### For All Workflows
- [ ] Webhook tests completed successfully
- [ ] Error handling verified
- [ ] Logging to DataAPI confirmed
- [ ] Documentation updated (README.md status table)
- [ ] Team notified of new active workflow

### Workflow-Specific
**N2.2 (NAS Full Scan)**:
- [ ] Storage capacity verified (MongoDB + NAS)
- [ ] Scan time estimated (may take hours for large NAS)
- [ ] Schedule set to off-peak hours (default: weekly)

**N3.2 (AI Gateway)**:
- [ ] Security review completed (public webhook)
- [ ] Rate limiting configured
- [ ] Monitoring/alerting set up for abuse
- [ ] Usage dashboard created

**N5.1 (Feedback Analysis)**:
- [ ] Prompt update process documented
- [ ] A/B testing framework ready
- [ ] Stakeholders trained on interpreting results
- [ ] Rollback plan established

---

## 🔍 Monitoring After Activation

### Week 1 (Daily Checks)
```bash
# Check for errors
curl -H "x-api-key: KEY" http://192.168.2.33:3003/integrations/events/n8n \
  | jq '.data[] | select(.severity == "error" or .event_type | contains("failed"))'

# Check execution history in n8n UI
# Workflows → [Workflow Name] → Executions → Review failures
```

### Week 2-4 (Weekly Reviews)
- Review execution success rate
- Analyze performance trends
- Check for resource leaks (memory, disk)
- Validate data quality in MongoDB

### Alerting Rules
Set up alerts for:
- ❌ Workflow failure rate > 10%
- ⏱️ Execution time > 2x baseline
- 💾 MongoDB disk usage > 80%
- 🔒 Suspicious API gateway activity (N3.2)

---

## 📚 Related Documentation

- [README.md](README.md) - Workflow overview and quick start
- [WORKFLOW_CHANGES.md](WORKFLOW_CHANGES.md) - Recent changes log
- [DEPLOYMENT_STATUS.md](DEPLOYMENT_STATUS.md) - Deployment tracking
- [n8n Documentation](https://docs.n8n.io/) - Official n8n docs
