# SBQC Troubleshooting Documentation

This directory contains comprehensive troubleshooting documentation for the SBQC (System Brain Query Control) platform.

## Documents Overview

### 1. [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) - Main Playbook
**Size:** 36KB | **Lines:** 1,514

The comprehensive troubleshooting playbook covering:
- Quick Diagnostics Checklist (5-step, 2-minute health check)
- 7 Common Issues & Solutions with detailed diagnostics
- Health Check Procedures (system-wide and component-specific)
- Workflow Debugging Steps (7-step process)
- Performance Troubleshooting (bottleneck identification & optimization)
- Emergency Procedures (6 critical scenarios)
- Command Reference (quick lookup)

**Coverage:**
- Webhook 404 errors
- Slow AI responses (>30s)
- Workflow execution failures
- Connection issues (AgentX, DataAPI, n8n)
- Deployment failures
- Authentication issues

### 2. [TROUBLESHOOTING_QUICK_REF.md](./TROUBLESHOOTING_QUICK_REF.md) - Quick Reference
**Size:** 4.5KB | **Lines:** 149

One-page quick reference with:
- Emergency hotline command
- Common issues table (7 issues)
- One-line diagnostics
- Emergency restart sequence
- Key file locations
- Essential commands
- Troubleshooting decision tree

**Use Case:** Print this for quick desk reference or keep open in terminal

### 3. [../scripts/health-check.sh](../scripts/health-check.sh) - Automated Health Check
**Size:** 3.2KB | **Executable:** Yes

Automated health check script that tests:
- pm2 services (AgentX, DataAPI)
- Docker containers (n8n, MongoDB)
- Ollama service
- All health endpoints
- Database connectivity
- Webhooks
- Disk space and memory

**Usage:**
```bash
cd /home/yb/codes/AgentX
./scripts/health-check.sh
```

**Exit Codes:**
- `0` = All critical services operational
- `1` = Some services down (check output)

## Quick Start

### For New Users
Start with the Quick Reference, then dive into specific sections of the main playbook as needed.

### For Emergencies
1. Run health check: `./scripts/health-check.sh`
2. Check Quick Reference decision tree
3. Follow specific issue instructions in main playbook

### For Development
Use main playbook as reference when:
- Deploying new workflows
- Debugging complex issues
- Optimizing performance
- Setting up monitoring

## Related Documentation

- [WORKFLOW-GUIDE.md](../AgentC/WORKFLOW-GUIDE.md) - n8n workflow development
- [API.md](./API.md) - SBQC API documentation
- [AUTHENTICATION.md](./AUTHENTICATION.md) - Security and auth
- [SECURITY_HARDENING.md](./SECURITY_HARDENING.md) - Production security

## Document Structure

### Main Playbook Organization

```
TROUBLESHOOTING.md
├── Quick Diagnostics Checklist (5 checks, ~2 minutes)
│   ├── System Health
│   ├── Network Connectivity
│   ├── Database Connectivity
│   ├── Ollama AI Service
│   └── Webhook Endpoints
│
├── Common Issues & Solutions
│   ├── Issue 1: Webhook 404 (not registered)
│   ├── Issue 2: Wrong response ("Workflow was started")
│   ├── Issue 3: Slow AI responses (>30s)
│   ├── Issue 4: Workflow execution failures
│   ├── Issue 5: Connection issues
│   ├── Issue 6: Deployment failures
│   └── Issue 7: Authentication issues
│
├── Health Check Procedures
│   ├── Full System Health Check
│   ├── AgentX Detailed Health
│   ├── DataAPI Detailed Health
│   ├── n8n Detailed Health
│   └── Ollama Health
│
├── Workflow Debugging Steps (7 steps)
│   ├── Step 1: Identify failing workflow
│   ├── Step 2: Analyze execution logs
│   ├── Step 3: Test components individually
│   ├── Step 4: Validate workflow JSON
│   ├── Step 5: Test in n8n UI
│   ├── Step 6: Check dependencies
│   └── Step 7: Fix and redeploy
│
├── Performance Troubleshooting
│   ├── Identify bottlenecks
│   ├── Optimize AgentX
│   ├── Optimize DataAPI
│   ├── Optimize Ollama
│   └── Optimize n8n
│
├── Emergency Procedures
│   ├── Emergency 1: Complete system down
│   ├── Emergency 2: MongoDB crashed
│   ├── Emergency 3: Ollama out of memory
│   ├── Emergency 4: n8n database corruption
│   ├── Emergency 5: Disk full
│   └── Emergency 6: Security breach
│
└── Appendix: Command Reference
    ├── Quick Commands
    ├── File Locations
    ├── Environment Variables
    └── Log Locations
```

## Statistics

### Coverage Metrics
- **Total Issues Documented:** 7 common issues + 6 emergency scenarios = 13 scenarios
- **Diagnostic Commands:** 100+ executable commands
- **Health Checks:** 4 comprehensive health check procedures
- **Performance Optimizations:** 4 service-specific optimization guides
- **Emergency Procedures:** 6 critical failure scenarios

### Content Breakdown
- **Quick Diagnostics:** 5 checks, ~2 minutes to run
- **Issue Resolution:** Average 3-5 steps per issue
- **Health Checks:** 4 detailed procedures (system, AgentX, DataAPI, n8n, Ollama)
- **Commands:** 100+ copy-paste ready bash commands
- **Code Examples:** 50+ code snippets with explanations

## Key Features

### Actionable Commands
Every diagnostic and solution includes:
- ✓ Copy-paste ready bash commands
- ✓ Expected output examples
- ✓ Verification steps
- ✓ Exit conditions

### Realistic Scenarios
Based on actual issues from:
- WORKFLOW-GUIDE.md common mistakes
- Production deployment experience
- n8n webhook configuration issues
- Integration pain points

### Progressive Detail
- Quick Reference: 1-page, <5 minutes
- Main Playbook: Comprehensive, searchable
- Scripts: Automated, repeatable

## Maintenance

### Updating This Documentation

When adding new issues:
1. Document symptoms clearly
2. Provide diagnostic steps with commands
3. List root causes
4. Provide solutions with verification
5. Update Quick Reference if common
6. Test all commands before committing

### Version Control
- **Current Version:** 1.0.0
- **Last Updated:** 2026-01-02
- **Next Review:** When new issues are discovered

### Contributing
Found an issue not covered? Add it following the existing format:
```markdown
### Issue X: [Clear Description]

**Symptoms:**
- List observable symptoms

**Diagnostic Steps:**
```bash
# Commands to diagnose
```

**Solutions:**
```bash
# Commands to fix
```

**Verification:**
```bash
# Commands to verify fix
```
```

## Testing

All commands in these documents have been:
- ✓ Syntax validated (bash -n)
- ✓ Tested against system architecture
- ✓ Verified with actual services
- ✓ Cross-referenced with WORKFLOW-GUIDE.md

## License

These troubleshooting documents are part of the AgentX project.

---

**Quick Access:**
- Emergency? → [Quick Reference](./TROUBLESHOOTING_QUICK_REF.md)
- Deep dive? → [Main Playbook](./TROUBLESHOOTING.md)
- Automated check? → `./scripts/health-check.sh`

**Version:** 1.0.0 | **Maintained By:** SBQC Team
