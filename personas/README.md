# AgentX Personas

This directory contains persona definitions for specialized AI agents in the AgentX system.

## Overview

Personas are specialized system prompts that configure the AI for specific tasks and domains. Each persona is stored in the MongoDB `PromptConfig` collection and can be selected when making chat requests.

## Available Personas

### 1. SBQC Workflow Architect (N6.1)
**File:** `sbqc_workflow_architect.json`
**Name:** `sbqc_workflow_architect`
**Purpose:** Generate complete n8n workflow JSON from natural language descriptions

**Capabilities:**
- Expert in n8n node types (webhook, schedule, httpRequest, code, if, merge, etc.)
- Understands SBQC workflow naming conventions (N0.x through N6.x)
- Generates valid JSON with proper node IDs, connections, and positioning
- Follows best practices for error handling, logging, and credentials
- Creates deployable workflows for the SBQC infrastructure

**Example Usage:**
```bash
curl -X POST http://localhost:3080/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Create a workflow that monitors MongoDB disk usage hourly",
    "options": {
      "persona": "sbqc_workflow_architect"
    }
  }'
```

### 2. SBQC Ops
**Name:** `sbqc_ops`
**Purpose:** Infrastructure monitoring and operations for SBQC stack

**Capabilities:**
- Monitor system health (DataAPI, AgentX, MongoDB, Ollama hosts, n8n)
- Execute diagnostic tool calls
- Report infrastructure status
- Help diagnose operational issues

### 3. Datalake Janitor
**Name:** `datalake_janitor`
**Purpose:** File management, deduplication, and storage optimization

**Capabilities:**
- Search and manage NAS files
- Identify duplicate files
- Manage deletion queue
- Optimize storage usage

### 4. Default Chat
**Name:** `default_chat`
**Purpose:** General-purpose conversational AI assistant

## Installation

### Method 1: Using Seed Scripts

Install the Workflow Architect persona:
```bash
node scripts/seed-workflow-architect.js
```

Install all standard personas:
```bash
node scripts/seed-sbqc-ops.js
```

### Method 2: Manual MongoDB Insert

```javascript
const PromptConfig = require('./models/PromptConfig');
const personaData = require('./personas/sbqc_workflow_architect.json');
await PromptConfig.create(personaData);
```

### Method 3: Via API (if available)

```bash
curl -X POST http://localhost:3080/api/admin/personas \
  -H "Content-Type: application/json" \
  -d @personas/sbqc_workflow_architect.json
```

## Creating New Personas

### 1. JSON Structure

Create a new persona file following this structure:

```json
{
  "name": "unique_persona_name",
  "version": 1,
  "isActive": true,
  "description": "Brief description of persona purpose",
  "systemPrompt": "Comprehensive system prompt defining behavior, knowledge, and capabilities...",
  "trafficWeight": 100,
  "abTestGroup": null,
  "stats": {
    "impressions": 0,
    "positiveCount": 0,
    "negativeCount": 0
  }
}
```

### 2. System Prompt Guidelines

A good system prompt should include:

1. **Role Definition**: Who is this AI agent?
2. **Core Expertise**: What domains does it specialize in?
3. **Available Tools/APIs**: What systems can it interact with?
4. **Response Format**: How should it structure outputs?
5. **Best Practices**: What conventions should it follow?
6. **Examples**: Concrete examples of input/output patterns

### 3. Naming Conventions

- Use lowercase snake_case for persona names
- Be descriptive but concise
- Avoid spaces or special characters
- Examples: `sbqc_ops`, `datalake_janitor`, `code_reviewer`

## Usage in Code

### JavaScript/Node.js

```javascript
const { handleChatRequest } = require('./src/services/chatService');

const response = await handleChatRequest({
  userId: 'user123',
  message: 'Generate a workflow that checks API health',
  options: {
    persona: 'sbqc_workflow_architect'
  }
});
```

### Chat Interface

1. Open AgentX chat at `http://localhost:3080`
2. Select persona from dropdown menu
3. Start chatting with specialized agent

### API Request

```bash
curl -X POST http://localhost:3080/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Your message here",
    "options": {
      "persona": "sbqc_workflow_architect",
      "model": "qwen2.5:7b-instruct-q4_0"
    }
  }'
```

## Persona Versioning

Personas support versioning for A/B testing and continuous improvement:

- **version**: Integer version number (auto-incremented on updates)
- **isActive**: Boolean flag (only active personas are used)
- **trafficWeight**: Percentage of traffic (0-100) for A/B testing
- **abTestGroup**: Optional group ID for related test variants

### Example: A/B Testing

```javascript
// Version 1 (baseline)
{
  "name": "sbqc_workflow_architect",
  "version": 1,
  "isActive": true,
  "trafficWeight": 50,
  "abTestGroup": "workflow_gen_test_1"
}

// Version 2 (experimental)
{
  "name": "sbqc_workflow_architect",
  "version": 2,
  "isActive": true,
  "trafficWeight": 50,
  "abTestGroup": "workflow_gen_test_1"
}
```

The system will randomly select between versions based on traffic weights.

## Performance Tracking

Personas track performance metrics automatically:

- **impressions**: Number of times persona was used
- **positiveCount**: Number of positive feedback ratings
- **negativeCount**: Number of negative feedback ratings

View metrics:
```javascript
const persona = await PromptConfig.findOne({ name: 'sbqc_workflow_architect' });
const successRate = persona.stats.positiveCount /
                    (persona.stats.positiveCount + persona.stats.negativeCount);
```

## Best Practices

### For Persona Creators

1. **Be Specific**: Define clear boundaries of expertise
2. **Include Examples**: Show concrete input/output patterns
3. **Document APIs**: List available endpoints and formats
4. **Error Handling**: Specify how to handle edge cases
5. **Validation Rules**: Include checklists for output quality
6. **Test Thoroughly**: Validate with diverse inputs before deployment

### For Persona Users

1. **Choose Appropriately**: Select persona that matches task domain
2. **Provide Context**: Give clear, detailed requirements
3. **Verify Output**: Always validate generated content
4. **Give Feedback**: Rate responses to improve performance
5. **Report Issues**: Document any problems or edge cases

## Maintenance

### Updating Personas

1. Edit the JSON file in `personas/` directory
2. Run the seed script to update MongoDB
3. Version number will auto-increment
4. Old versions remain in database for rollback

### Deactivating Personas

```javascript
const persona = await PromptConfig.findOne({ name: 'persona_name' });
persona.isActive = false;
await persona.save();
```

### Viewing All Personas

```bash
mongo agentx --eval "db.promptconfigs.find({}, {name:1, version:1, isActive:1, description:1}).pretty()"
```

## Troubleshooting

### Persona Not Available in Dropdown

1. Check if persona is active: `db.promptconfigs.find({ name: 'persona_name', isActive: true })`
2. Restart AgentX server to refresh cache
3. Verify MongoDB connection

### Persona Not Behaving as Expected

1. Check system prompt length (very long prompts may be truncated)
2. Verify JSON structure is valid
3. Review recent changes to persona definition
4. Check feedback metrics for patterns

### Seeding Script Fails

1. Verify MongoDB is running: `mongo --eval "db.stats()"`
2. Check MONGODB_URI in `.env` file
3. Ensure persona JSON file exists and is valid
4. Check for duplicate name+version combinations

## Related Files

- `/models/PromptConfig.js` - MongoDB schema definition
- `/src/services/chatService.js` - Persona selection logic
- `/scripts/seed-sbqc-ops.js` - Standard personas seeding script
- `/scripts/seed-workflow-architect.js` - Workflow architect seeding script

## Contributing

To contribute a new persona:

1. Create JSON file in `personas/` directory
2. Create corresponding seed script in `scripts/`
3. Update this README with persona documentation
4. Test thoroughly with diverse inputs
5. Submit pull request with examples and test results

## Support

For issues or questions about personas:
- Check AgentX documentation
- Review persona system prompt
- Test with simpler inputs
- Report bugs via issue tracker
