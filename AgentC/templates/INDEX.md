# SBQC Workflow Templates - Complete Index

## Overview

This directory contains a comprehensive workflow template library designed for the SBQC Architect AI system. The templates provide production-ready patterns for rapid n8n workflow development.

**Version:** 1.0.0
**Created:** 2026-01-02
**Location:** `/home/yb/codes/AgentX/AgentC/templates/`

---

## Directory Contents

### Core Files

| File | Size | Purpose |
|------|------|---------|
| **workflow-templates.json** | 42KB | Main template library with 5 production-ready patterns |
| **README.md** | 8.5KB | Complete documentation and quick start guide |
| **USAGE_EXAMPLES.md** | 14KB | Practical examples showing how to use each template |
| **validate-templates.sh** | 3KB | Validation script to verify template integrity |
| **INDEX.md** | This file | Directory overview and navigation |

**Total:** ~68KB, 1,955 lines of documentation and templates

---

## Quick Navigation

### For AI Architect
- **Start here:** `workflow-templates.json` - Read this to understand available patterns
- **Template structure:** See `customization_guide` section in JSON
- **Integration patterns:** See `example_use_cases_by_template` section

### For Developers
- **Quick start:** `README.md` - Get up to speed in 5 minutes
- **Practical examples:** `USAGE_EXAMPLES.md` - Real-world implementations
- **Validation:** Run `./validate-templates.sh` to verify templates

### For Documentation
- **Template overview:** `README.md` sections on each pattern
- **Best practices:** `README.md` > Best Practices section
- **Troubleshooting:** `README.md` > Troubleshooting section

---

## Template Library Summary

### 5 Core Templates

1. **Basic Webhook** (3 nodes)
   - Webhook → Process → Respond
   - Use for: Simple APIs, status checks, quick transformations

2. **Scheduled Job** (4 nodes)
   - Schedule → Fetch → Process → Log
   - Use for: Health checks, periodic syncs, scheduled reports

3. **Conditional Flow** (7 nodes)
   - Webhook → Validate → IF → Success/Error paths → Respond
   - Use for: Validation workflows, approval processes, quality checks

4. **Multi-step API** (9 nodes)
   - Webhook → Prepare → Parallel APIs → Process → Merge → Respond
   - Use for: Data enrichment, multi-service orchestration, aggregation

5. **Error Handling** (12 nodes)
   - Webhook → Context → Risky Op → Check → IF → Success/Error → Log → Respond
   - Use for: Production APIs, critical workflows, robust error handling

---

## Key Features

### Production-Ready
- All templates tested and validated
- Based on real SBQC production workflows (N0.0-N5.1)
- Include error handling with `continueOnFail`
- Integrated with DataAPI logging

### Well-Documented
- Inline comments with "CUSTOMIZE" markers
- Complete parameter examples
- Node-by-node explanations
- Best practices embedded

### AI-Friendly
- Structured JSON format
- Clear customization points
- Consistent naming conventions
- Reusable patterns

---

## Usage Workflow

### Step 1: Select Template
```bash
# List available templates
jq '.templates | keys' workflow-templates.json

# View template details
jq '.templates["1_basic_webhook"]' workflow-templates.json
```

### Step 2: Extract & Customize
```bash
# Extract template
jq '.templates["1_basic_webhook"].workflow' workflow-templates.json > my-workflow.json

# Edit customization points (search for CUSTOMIZE)
# Update: workflow_id, credentials, URLs, business logic
```

### Step 3: Validate
```bash
# Check JSON syntax
jq empty my-workflow.json

# Validate structure
./validate-templates.sh
```

### Step 4: Deploy
```bash
# Deploy to n8n
/home/yb/codes/AgentX/scripts/deploy-n8n-workflows.sh my-workflow.json
```

### Step 5: Test
```bash
# For webhooks
curl https://n8n.specialblend.icu/webhook/your-path

# For scheduled jobs
# Check execution in n8n UI
```

---

## Template Selection Decision Tree

```
Need to create a workflow?
│
├─ Triggered by time/schedule?
│  └─ Yes → Use Template 2 (Scheduled Job)
│
├─ Calls multiple APIs in parallel?
│  └─ Yes → Use Template 4 (Multi-step API)
│
├─ Needs validation or branching logic?
│  └─ Yes → Use Template 3 (Conditional Flow)
│
├─ Must be production-critical with full error handling?
│  └─ Yes → Use Template 5 (Error Handling)
│
└─ Simple webhook endpoint?
   └─ Yes → Use Template 1 (Basic Webhook)
```

---

## Integration with SBQC Stack

### Architecture Alignment
Templates follow SBQC design principles:

- **n8n = Orchestration only** (no AI reasoning)
- **AgentX = All AI logic** (reasoning, classification)
  - Endpoint: `http://192.168.2.33:3080/api/chat`
- **DataAPI = Source of truth** (storage, scans)
  - Endpoint: `http://192.168.2.33:3003`
- **Ollama = Inference** (via AgentX only)

### Standard Endpoints Used

```javascript
// AgentX Chat API
"url": "http://192.168.2.33:3080/api/chat"

// DataAPI Integration Sink (for logging)
"url": "http://192.168.2.33:3003/integrations/events/n8n"

// DataAPI Health
"url": "http://192.168.2.33:3003/health"

// AgentX Health
"url": "http://192.168.2.33:3080/health"
```

---

## Customization Requirements

### Mandatory Replacements

Every template requires these customizations:

1. **Workflow Identity**
   ```json
   {
     "name": "YOUR_WORKFLOW_NAME",
     "workflow_id": "YOUR_WORKFLOW_ID"  // e.g., "N1.1"
   }
   ```

2. **Webhook Paths**
   ```json
   {
     "path": "your-unique-webhook-path",
     "webhookId": "unique-webhook-id"
   }
   ```

3. **Credentials**
   ```json
   {
     "credentials": {
       "httpHeaderAuth": {
         "id": "YOUR_CREDENTIAL_ID"  // Get from n8n UI
       }
     }
   }
   ```

4. **Business Logic**
   - Search for "CUSTOMIZE" comments in code nodes
   - Replace example logic with actual requirements
   - Update validation rules, data processing, etc.

---

## Best Practices Checklist

When creating workflows from templates:

- [ ] Set unique workflow name and ID
- [ ] Configure unique webhook path (if applicable)
- [ ] Replace all credential placeholders
- [ ] Update all API endpoint URLs
- [ ] Customize business logic in code nodes
- [ ] Set appropriate timeouts (5000-30000ms)
- [ ] Enable `continueOnFail` on all HTTP nodes
- [ ] Add DataAPI logging for errors
- [ ] Test with sample data before production
- [ ] Document any deviations from template

---

## Validation

Run the validation script to verify template integrity:

```bash
./validate-templates.sh
```

Expected output:
```
✓ Checking main JSON structure...
  ✓ Valid JSON
  ✓ Version: 1.0.0
  ✓ Templates found: 5

...

✓ All templates are valid!
```

---

## Real-World Examples

### From Production SBQC Workflows

| Production Workflow | Template Used | Key Customizations |
|---------------------|---------------|-------------------|
| N0.0 Deployment Test | Basic Webhook | Returns deployment status info |
| N0.1 Health Dashboard | Basic Webhook | Aggregates system health checks |
| N1.1 System Health | Scheduled Job + Multi-step API | Parallel health checks every 5 min |
| N3.2 AI Gateway | Conditional Flow + Error Handling | Validates requests, calls AgentX |
| N2.3 RAG Ingestion | Scheduled Job | Weekly document processing |

---

## Troubleshooting

### Common Issues

**Template won't import:**
```bash
# Validate JSON
jq empty workflow.json
```

**Credentials not found:**
- Create credential in n8n UI: Settings > Credentials
- Copy credential ID
- Replace `YOUR_CREDENTIAL_ID` in workflow JSON

**Webhook returns 404:**
- Verify workflow is active
- Check webhook path matches JSON
- Test: `curl http://n8n.example.com/webhook/your-path`

**Node reference errors:**
- Use `$input.first()` instead of `$node` with merged inputs
- See README.md > Node Reference Guide

---

## Resources

### Documentation
- **This directory:** `/home/yb/codes/AgentX/AgentC/templates/`
- **Production workflows:** `/home/yb/codes/AgentX/AgentC/N*.json`
- **SBQC workflow guide:** `/home/yb/codes/AgentX/AgentC/WORKFLOW-GUIDE.md`
- **Deployment guide:** `/home/yb/codes/AgentX/docs/SBQC-Stack-Final/05-DEPLOYMENT.md`

### Tools
- **Deployment script:** `/home/yb/codes/AgentX/scripts/deploy-n8n-workflows.sh`
- **Validation script:** `./validate-templates.sh`
- **n8n UI:** `http://192.168.2.199:5678`
- **Public URL:** `https://n8n.specialblend.icu`

### External
- **n8n Documentation:** https://docs.n8n.io/
- **n8n API Reference:** https://docs.n8n.io/api/

---

## Contributing

To add new templates:

1. Follow existing structure in `workflow-templates.json`
2. Include comprehensive "CUSTOMIZE" comments
3. Set clean position coordinates
4. Test thoroughly
5. Add to this INDEX and README
6. Run `./validate-templates.sh` to verify

---

## Version History

### v1.0.0 (2026-01-02)
**Initial release**

Templates:
- Basic Webhook Workflow
- Scheduled Job Pattern
- Conditional Flow Pattern
- Multi-step API Pattern
- Error Handling Pattern

Documentation:
- README.md (complete guide)
- USAGE_EXAMPLES.md (5 detailed examples)
- INDEX.md (this file)
- validate-templates.sh (validation tool)

Based on:
- N0.0 Deployment Test
- N0.1 Health Dashboard
- N1.1 System Health Check
- N3.2 External AI Gateway
- SBQC production best practices

---

## Quick Links

- **Start here:** [README.md](README.md)
- **See examples:** [USAGE_EXAMPLES.md](USAGE_EXAMPLES.md)
- **View templates:** `jq '.templates | keys' workflow-templates.json`
- **Validate:** `./validate-templates.sh`
- **Deploy:** `/home/yb/codes/AgentX/scripts/deploy-n8n-workflows.sh`

---

**Last updated:** 2026-01-02
**Maintained by:** SBQC Team
**For questions:** See `/home/yb/codes/AgentX/AgentC/README.md`
