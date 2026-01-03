# SBQC Workflow Architect (N6.1) - Installation Guide

This guide walks through installing and using the SBQC Workflow Architect persona.

## Quick Start

### 1. Install the Persona

```bash
cd /home/yb/codes/AgentX
node scripts/seed-workflow-architect.js
```

Expected output:
```
🏗️  SBQC Workflow Architect (N6.1) Seeding Script
────────────────────────────────────────────────────────────
📄 Loading persona from: /home/yb/codes/AgentX/personas/sbqc_workflow_architect.json
✓ Loaded persona: sbqc_workflow_architect

📡 Connecting to MongoDB: mongodb://localhost:27017/agentx
✓ Connected to MongoDB

📋 Checking for existing sbqc_workflow_architect persona...
✓ Created sbqc_workflow_architect persona (version 1)

📊 Persona Details:
────────────────────────────────────────────────────────────
Name:        sbqc_workflow_architect
Version:     1
Active:      Yes
Description: N6.1 SBQC Workflow Architect - Expert in generating n8n workflow JSON from natural language descriptions
System Prompt Length: 10354 characters
Traffic Weight: 100%

✅ Seeding complete!
```

### 2. Test the Persona

#### Option A: Via AgentX Chat UI

1. Open http://localhost:3080 in your browser
2. Look for the persona dropdown in the chat interface
3. Select "sbqc_workflow_architect"
4. Try a test query:
   ```
   Create a workflow that checks DataAPI health every 5 minutes
   ```

#### Option B: Via API

```bash
curl -X POST http://localhost:3080/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Create a simple health check workflow for DataAPI",
    "options": {
      "persona": "sbqc_workflow_architect",
      "model": "qwen2.5:7b-instruct-q4_0"
    }
  }'
```

### 3. Use Generated Workflow

The persona will return a complete n8n workflow JSON. To deploy it:

1. Copy the generated JSON
2. Open n8n at http://192.168.2.199:5678
3. Click "+" → "Import from File"
4. Paste JSON and click "Import"
5. Configure any required credentials
6. Test via webhook or activate for scheduled execution

---

## Verification

### Check Persona is Installed

```bash
# Via MongoDB
mongo agentx --eval "db.promptconfigs.find({name: 'sbqc_workflow_architect'}).pretty()"

# Via AgentX API (if available)
curl http://localhost:3080/api/personas
```

### Check Persona is Active

```bash
mongo agentx --eval "db.promptconfigs.findOne({name: 'sbqc_workflow_architect', isActive: true}, {name:1, version:1, isActive:1})"
```

Expected output:
```json
{
  "_id" : ObjectId("..."),
  "name" : "sbqc_workflow_architect",
  "version" : 1,
  "isActive" : true
}
```

---

## Example Requests

### Simple Health Check

**Request:**
```
Create a workflow that checks if AgentX is responding every 10 minutes
```

**Generated:** N1.x health monitoring workflow with schedule + webhook triggers

---

### Conditional Alert

**Request:**
```
Create a workflow that runs daily at 3 AM, checks MongoDB disk usage via DataAPI,
and sends an alert if usage is above 80%
```

**Generated:** N3.x monitoring workflow with threshold logic and conditional alerts

---

### Parallel Service Check

**Request:**
```
Create a workflow that checks DataAPI, AgentX, and both Ollama hosts in parallel
every 5 minutes, aggregates the results, and logs to DataAPI sink
```

**Generated:** N1.x multi-service health check with parallel execution and aggregation

---

### Data Pipeline

**Request:**
```
Create a workflow that receives file scan results via webhook, identifies duplicates
by comparing with existing records, flags them for Janitor review, and returns a summary
```

**Generated:** N2.x data processing workflow with validation and API integration

---

## Troubleshooting

### Persona Not Appearing in Dropdown

**Symptoms:** Can't find "sbqc_workflow_architect" in persona selector

**Solutions:**
1. Verify installation: `mongo agentx --eval "db.promptconfigs.find({name: 'sbqc_workflow_architect'})"`
2. Check isActive flag is true
3. Restart AgentX server: `pm2 restart agentx` or restart via your process manager
4. Check browser console for errors
5. Clear browser cache and reload

---

### Persona Returns Generic Responses

**Symptoms:** AI doesn't seem to know about n8n or SBQC workflows

**Solutions:**
1. Verify correct persona is selected in request
2. Check persona system prompt loaded correctly:
   ```bash
   mongo agentx --eval "db.promptconfigs.findOne({name: 'sbqc_workflow_architect'}).systemPrompt.substring(0, 200)"
   ```
3. Ensure request includes `"persona": "sbqc_workflow_architect"` in options
4. Try reinstalling persona (version will increment)

---

### Generated Workflows Don't Import

**Symptoms:** n8n shows error when importing generated JSON

**Solutions:**
1. Validate JSON syntax: Copy to https://jsonlint.com
2. Check for missing required fields (name, nodes, connections)
3. Verify all node names in connections exist in nodes array
4. Check for duplicate node IDs
5. Review error message for specific issues

Common issues:
- **"Node not found"**: Connection references non-existent node name
- **"Invalid JSON"**: Syntax error in generated code
- **"Missing required field"**: Node missing required parameter

---

### Credentials Not Working

**Symptoms:** Workflow executes but HTTP requests fail with auth errors

**Solution:**
1. Open n8n credentials manager
2. Check for "Header Auth account" with ID "PIrrA2wpOppzVodi"
3. If missing, create new HTTP Header Auth credential:
   - Name: `Header Auth account`
   - Header Name: `Authorization` (or your auth header)
   - Header Value: `Bearer YOUR_TOKEN` (or your auth value)
4. Update workflow nodes with new credential ID

---

## Updating the Persona

### Modify System Prompt

1. Edit `/home/yb/codes/AgentX/personas/sbqc_workflow_architect.json`
2. Update the `systemPrompt` field
3. Save file
4. Re-run seed script:
   ```bash
   node scripts/seed-workflow-architect.js
   ```
5. Version will auto-increment
6. Restart AgentX if needed

### A/B Test New Version

To test improvements without fully replacing current version:

```javascript
// In seed script or MongoDB
const newVersion = {
  ...existingPersona,
  version: 2,
  systemPrompt: "Updated prompt...",
  trafficWeight: 20,  // 20% of traffic
  abTestGroup: "workflow_gen_v2"
};

const currentVersion = {
  ...existingPersona,
  trafficWeight: 80,  // 80% keeps current
  abTestGroup: "workflow_gen_v2"
};

// Save both versions with isActive: true
```

System will randomly distribute requests based on traffic weights.

---

## Performance Monitoring

### View Usage Stats

```bash
mongo agentx --eval "
  db.promptconfigs.findOne(
    {name: 'sbqc_workflow_architect'},
    {name:1, version:1, 'stats.impressions':1, 'stats.positiveCount':1, 'stats.negativeCount':1}
  )
"
```

### Check Success Rate

```javascript
const persona = await PromptConfig.findOne({ name: 'sbqc_workflow_architect' });
const total = persona.stats.positiveCount + persona.stats.negativeCount;
const successRate = total > 0 ? (persona.stats.positiveCount / total * 100).toFixed(1) : 'N/A';
console.log(`Success Rate: ${successRate}%`);
```

### View Recent Feedback

```bash
mongo agentx --eval "
  db.feedbacks.find(
    {promptVersion: /sbqc_workflow_architect/}
  ).sort({createdAt: -1}).limit(10).pretty()
"
```

---

## Integration Examples

### Node.js Script

```javascript
const axios = require('axios');

async function generateWorkflow(description) {
  const response = await axios.post('http://localhost:3080/api/chat', {
    message: description,
    options: {
      persona: 'sbqc_workflow_architect',
      model: 'qwen2.5:7b-instruct-q4_0'
    }
  });

  // Extract JSON from response
  const jsonMatch = response.data.response.match(/```json\n([\s\S]+?)\n```/);
  if (jsonMatch) {
    return JSON.parse(jsonMatch[1]);
  }

  throw new Error('No workflow JSON found in response');
}

// Use it
const workflow = await generateWorkflow('Create a health check for DataAPI');
console.log('Generated workflow:', workflow.name);
```

### Shell Script

```bash
#!/bin/bash

# Generate workflow
DESCRIPTION="Create a workflow that monitors MongoDB disk usage hourly"

RESPONSE=$(curl -s -X POST http://localhost:3080/api/chat \
  -H "Content-Type: application/json" \
  -d "{
    \"message\": \"$DESCRIPTION\",
    \"options\": {
      \"persona\": \"sbqc_workflow_architect\"
    }
  }")

# Extract JSON (requires jq)
echo "$RESPONSE" | jq -r '.response' | \
  sed -n '/```json/,/```/p' | \
  sed '1d;$d' > generated_workflow.json

echo "Workflow saved to generated_workflow.json"

# Import to n8n (requires n8n API access)
curl -X POST http://192.168.2.199:5678/api/v1/workflows \
  -H "Content-Type: application/json" \
  -d @generated_workflow.json

echo "Workflow imported to n8n"
```

---

## Best Practices

### Writing Good Prompts

**✅ DO:**
- Be specific about triggers (schedule, webhook, or both)
- Mention exact endpoints and URLs
- Specify conditions and thresholds
- Include error handling requirements
- Mention logging/alerting needs

**❌ DON'T:**
- Use vague terms like "monitor the system"
- Assume default behaviors
- Omit trigger details
- Forget to mention error cases

### Example Prompts

**Good:**
```
Create a workflow that:
1. Runs every 10 minutes (schedule) + has manual webhook
2. Checks AgentX /health endpoint with 5s timeout
3. Logs result to DataAPI event sink
4. Uses continueOnFail for logging
```

**Better:**
```
Create SBQC N1.5 AgentX Health Monitor:
- Schedule: every 10 minutes
- Manual trigger: webhook at sbqc-n1-5-agentx-health
- Check: GET http://192.168.2.33:3080/health (5s timeout, continueOnFail)
- Process: code node to format status
- Log: POST to DataAPI event sink (workflow_id: N1.5, event_type: agentx_health)
- Tags: SBQC, Priority-1, Health
```

---

## Documentation

- **Main README**: `/home/yb/codes/AgentX/personas/README.md`
- **Workflow Patterns**: `/home/yb/codes/AgentX/personas/WORKFLOW_PATTERNS.md`
- **Example Workflows**: `/home/yb/codes/AgentX/personas/EXAMPLE_WORKFLOW.md`
- **Existing Workflows**: `/home/yb/codes/AgentX/AgentC/*.json`

---

## Support

### Getting Help

1. **Check Documentation**: Review the READMEs in personas/ directory
2. **Review Examples**: Study workflows in AgentC/ directory
3. **Test Incrementally**: Start with simple workflows, add complexity
4. **Validate Output**: Always test generated workflows in n8n
5. **Provide Feedback**: Rate responses to improve persona performance

### Reporting Issues

When reporting problems, include:
- Exact prompt/request used
- Generated workflow JSON (if applicable)
- Error messages from n8n or AgentX
- Expected vs actual behavior
- Persona version (check MongoDB)

---

## Next Steps

1. ✅ Install persona via seed script
2. ✅ Verify installation in MongoDB
3. ✅ Test with simple request
4. ✅ Review generated workflow
5. ✅ Import to n8n and test execution
6. ✅ Provide feedback (positive/negative rating)
7. ✅ Try more complex workflows
8. ✅ Integrate into your development workflow

---

**Version:** 1.0
**Last Updated:** 2026-01-02
**Maintained By:** SBQC Team
**Related Personas:** sbqc_ops, datalake_janitor
