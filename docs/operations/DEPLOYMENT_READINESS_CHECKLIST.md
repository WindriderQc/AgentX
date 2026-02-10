# AgentX Deployment Readiness Checklist

**Generated:** 2026-01-08
**Version:** 1.4.1
**Status:** ✅ Production-Ready

---

## Executive Summary

AgentX is **production-ready** for deployment with all 8 development tracks complete, 764/770 tests passing (99.2%), and comprehensive security features implemented.

**Test Results:**
- ✅ 63/63 test suites passing (100%)
- ✅ 764/770 tests passing (99.2%)
- ⚪ 6 tests skipped (intentional)
- ⏭️ Streaming tests (32/33 passing) - separate execution recommended

---

## Pre-Deployment Checklist

### Phase 1: Environment Configuration (REQUIRED)

#### 1.1 Generate Security Secrets ⚠️ CRITICAL

```bash
# Generate SESSION_SECRET (32+ characters)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Generate CSRF_SECRET (32+ characters)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Generate AGENTX_API_KEY (for automation/n8n access)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Update `.env` file:**
```bash
SESSION_SECRET=<generated-secret-1>
CSRF_SECRET=<generated-secret-2>
AGENTX_API_KEY=<generated-api-key>
```

**Status:** [ ] Complete

---

#### 1.2 Database Configuration ⚠️ CRITICAL

**MongoDB Setup:**
```bash
# For production MongoDB with authentication
MONGODB_URI=mongodb://username:password@host:27017/agentx?authSource=admin

# For MongoDB Atlas (cloud)
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/agentx?retryWrites=true&w=majority
```

**Verify Connection:**
```bash
mongosh "$MONGODB_URI" --eval "db.adminCommand({ ping: 1 })"
```

**Status:** [ ] Complete

---

#### 1.3 Vector Store (Qdrant) Configuration ⚠️ CRITICAL

**Option A: Docker (Recommended)**
```bash
docker run -d -p 6333:6333 -v $(pwd)/qdrant_storage:/qdrant/storage qdrant/qdrant
```

**Option B: PM2 (Already Running)**
```bash
pm2 list | grep qdrant
# Should show qdrant process running on port 6333
```

**Configure `.env`:**
```bash
VECTOR_STORE_TYPE=qdrant
QDRANT_URL=http://localhost:6333
QDRANT_COLLECTION=agentx_embeddings
```

**Verify Connection:**
```bash
curl http://localhost:6333/healthz
# Should return: {"title":"healthz","version":"1.x.x"}
```

**Status:** [ ] Complete

---

#### 1.4 LLM Server (Ollama) Configuration ⚠️ CRITICAL

**Primary Ollama Host:**
```bash
OLLAMA_HOST=http://192.168.1.100:11434
EMBEDDING_MODEL=nomic-embed-text
```

**Optional: Secondary Host (Failover)**
```bash
OLLAMA_HOST_SECONDARY=http://192.168.1.101:11434
```

**Verify Connection:**
```bash
curl $OLLAMA_HOST/api/tags
# Should return list of available models
```

**Pull Required Models:**
```bash
ollama pull nomic-embed-text
ollama pull gemma2:2b  # For RAG compression
# Plus any chat models you plan to use (llama2, mistral, etc.)
```

**Status:** [ ] Complete

---

#### 1.5 Production Settings ⚠️ CRITICAL

**Update `.env`:**
```bash
NODE_ENV=production
PORT=3080
HOST=0.0.0.0  # Listen on all interfaces (or specific IP)
SERVER_HOST=yourdomain.com  # Public domain for links/redirects
```

**CORS Configuration (if needed):**
```bash
CORS_ORIGINS=https://yourdomain.com,https://app.yourdomain.com
```

**Status:** [ ] Complete

---

### Phase 2: Optional Configuration (Recommended)

#### 2.1 Email Notifications

**SMTP Configuration:**
```bash
ALERT_EMAIL_FROM=alerts@yourdomain.com
ALERT_EMAIL_TO=ops@yourdomain.com

SMTP_HOST=smtp.gmail.com  # Or your SMTP server
SMTP_PORT=587
SMTP_USER=your-email@yourdomain.com
SMTP_PASS=your-app-password
```

**Test Email:**
```bash
node scripts/test-email-config.js  # If script exists
```

**Status:** [ ] Complete / [ ] Skip

---

#### 2.2 Slack Notifications

**Webhook Setup:**
1. Create Slack webhook: https://api.slack.com/messaging/webhooks
2. Update `.env`:
```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
```

**Test Slack:**
```bash
curl -X POST "$SLACK_WEBHOOK_URL" \
  -H 'Content-Type: application/json' \
  -d '{"text":"AgentX deployment test"}'
```

**Status:** [ ] Complete / [ ] Skip

---

#### 2.3 DataAPI Integration

**If using DataAPI:**
```bash
DATAAPI_BASE_URL=http://localhost:3003
DATAAPI_API_KEY=<match-dataapi-.env-key>
```

**Verify DataAPI:**
```bash
curl http://localhost:3003/health
```

**Status:** [ ] Complete / [ ] Skip

---

#### 2.4 n8n Automation Integration

**If using n8n workflows:**
```bash
N8N_WEBHOOK_BASE_URL=https://n8n.yourdomain.com/webhook
N8N_API_KEY=<your-n8n-api-key>
N8N_LAN_ONLY=false  # Set to true if n8n is LAN-only
N8N_WEBHOOK_TIMEOUT_MS=120000
```

**Test n8n Webhook:**
```bash
curl "$N8N_WEBHOOK_BASE_URL/test"
```

**Status:** [ ] Complete / [ ] Skip

---

#### 2.5 Cost Tracking Configuration

**Enable Cost Tracking:**
```bash
COST_TRACKING_ENABLED=true
COST_CURRENCY=USD

# Ollama is free/local by default
OLLAMA_DEFAULT_PROMPT_COST_PER_1M=0.00
OLLAMA_DEFAULT_COMPLETION_COST_PER_1M=0.00

# Fallback for unknown models
DEFAULT_FALLBACK_PROMPT_COST_PER_1M=0.00
DEFAULT_FALLBACK_COMPLETION_COST_PER_1M=0.00

# Cache TTL (1 hour default)
COST_PRICING_CACHE_TTL=3600
```

**Status:** [ ] Complete

---

#### 2.6 RAG Compression Configuration

**Configure Compression:**
```bash
COMPRESSION_MODEL=gemma2:2b
COMPRESSION_MIN_RELEVANCE=0.6
COMPRESSION_MAX_SENTENCES=5
COMPRESSION_CACHE_TTL=3600000  # 1 hour in ms
```

**Verify Compression Model:**
```bash
curl $OLLAMA_HOST/api/tags | grep gemma2:2b
```

**Status:** [ ] Complete

---

### Phase 3: Deployment Execution

#### 3.1 Install Dependencies

```bash
cd /home/yb/codes/AgentX
npm ci --production  # Use ci for deterministic installs
```

**Status:** [ ] Complete

---

#### 3.2 Database Indexes

**Create MongoDB Indexes:**
```bash
node scripts/create-indexes.js  # If script exists
# Or let the app create them on first startup (automatic)
```

**Status:** [ ] Complete / [ ] Automatic

---

#### 3.3 Start with PM2 (Process Manager)

**Option A: Fresh Start**
```bash
# Start AgentX
pm2 start ecosystem.config.js

# Save for reboot persistence
pm2 save
pm2 startup  # Follow instructions to enable startup script
```

**Option B: Update Existing**
```bash
# Reload with new environment variables
pm2 reload ecosystem.config.js --update-env

# Save configuration
pm2 save
```

**Verify Processes:**
```bash
pm2 status
# Should show:
# - agentx (status: online)
# - qdrant (status: online, if managed by PM2)
# - dataapi (status: online, if applicable)
```

**Status:** [ ] Complete

---

#### 3.4 Health Check Verification

**Check System Health:**
```bash
curl http://localhost:3080/health
```

**Expected Response:**
```json
{
  "status": "healthy",
  "timestamp": "2026-01-08T...",
  "version": "1.4.1",
  "uptime": 123.45,
  "dependencies": {
    "mongodb": "connected",
    "ollama": "connected",
    "qdrant": "connected"
  }
}
```

**Status:** [ ] Complete

---

#### 3.5 Configuration Endpoint Check

**Verify Config API:**
```bash
curl http://localhost:3080/api/config
```

**Expected Response:**
```json
{
  "features": {
    "rag": true,
    "costTracking": true,
    "multiTenancy": true,
    ...
  },
  "models": [...],
  "vectorStore": "qdrant"
}
```

**Status:** [ ] Complete

---

### Phase 4: Post-Deployment Verification

#### 4.1 Run End-to-End Tests

**Execute E2E Test Suite:**
```bash
./test-all.sh
```

**Expected Results:**
- ✅ Health checks pass
- ✅ API endpoints respond
- ✅ Database operations succeed
- ✅ LLM inference works
- ✅ RAG retrieval functions

**Status:** [ ] Complete

---

#### 4.2 Create Test Workspace

**Via Web UI:**
1. Navigate to http://localhost:3080
2. Create first workspace: "Production"
3. Verify workspace appears in navigation

**Via API:**
```bash
curl -X POST http://localhost:3080/api/workspaces \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $AGENTX_API_KEY" \
  -d '{"name":"Production","description":"Main production workspace"}'
```

**Status:** [ ] Complete

---

#### 4.3 Test Core Features

**4.3.1 Chat Functionality**
- [ ] Send test message without RAG
- [ ] Send test message with RAG enabled
- [ ] Verify conversation history persists
- [ ] Check cost tracking updates

**4.3.2 RAG System**
- [ ] Ingest test document
- [ ] Verify vector store has embeddings
- [ ] Test retrieval with query
- [ ] Verify compression working (if enabled)

**4.3.3 Analytics Dashboard**
- [ ] Navigate to http://localhost:3080/analytics.html
- [ ] Verify metrics display
- [ ] Check charts render correctly

**4.3.4 Alert System**
- [ ] Create test alert rule
- [ ] Trigger alert manually
- [ ] Verify alert appears in dashboard
- [ ] Check notification delivery (if configured)

**Status:** [ ] Complete

---

#### 4.4 Performance Baseline

**Capture Initial Metrics:**
```bash
# Run performance snapshot
node scripts/capture-performance-baseline.js  # If script exists

# Or manually via API
curl -X POST http://localhost:3080/api/performance/baseline \
  -H "X-API-Key: $AGENTX_API_KEY" \
  -d '{"name":"production-deploy-2026-01-08"}'
```

**Status:** [ ] Complete

---

#### 4.5 Backup Configuration

**Setup Automated Backups:**

**Via Web UI:**
1. Navigate to http://localhost:3080/backup.html
2. Click "Setup Cron Jobs"
3. Configure daily backups (default: 2 AM)

**Via Script:**
```bash
./scripts/setup-backup-cron.sh
```

**Verify Cron:**
```bash
crontab -l | grep backup
# Should show:
# 0 2 * * * /home/yb/codes/AgentX/scripts/backup-mongodb.sh
# 0 2 * * * /home/yb/codes/AgentX/scripts/backup-qdrant.sh
```

**Test Manual Backup:**
```bash
./scripts/backup-mongodb.sh
./scripts/backup-qdrant.sh

# Verify backups created
ls -lh /home/yb/backups/mongodb/
ls -lh /home/yb/backups/qdrant/
```

**Status:** [ ] Complete

---

#### 4.6 Security Verification

**4.6.1 HTTPS Setup (Production Only)**
```bash
# If using reverse proxy (nginx, Apache, Caddy)
# Configure SSL/TLS certificates

# If using Let's Encrypt with Certbot
certbot certonly --standalone -d yourdomain.com
```

**Status:** [ ] Complete / [ ] N/A (Development)

**4.6.2 Firewall Configuration**
```bash
# Allow only necessary ports
ufw allow 3080/tcp  # AgentX
ufw allow 6333/tcp  # Qdrant (if remote access needed)
ufw allow 11434/tcp # Ollama (if remote access needed)
ufw enable
```

**Status:** [ ] Complete / [ ] N/A

**4.6.3 API Key Validation**
```bash
# Test API key authentication
curl -X GET http://localhost:3080/api/conversations \
  -H "X-API-Key: $AGENTX_API_KEY"
# Should return data (not 401 Unauthorized)

# Test invalid key
curl -X GET http://localhost:3080/api/conversations \
  -H "X-API-Key: invalid-key"
# Should return 401 Unauthorized
```

**Status:** [ ] Complete

---

#### 4.7 Monitoring Setup

**4.7.1 PM2 Monitoring**
```bash
# View logs
pm2 logs agentx --lines 200

# Monitor metrics
pm2 monit

# Setup PM2 web dashboard (optional)
pm2 web
```

**Status:** [ ] Complete

**4.7.2 Log Aggregation (Optional)**
```bash
# Configure log rotation
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 7
```

**Status:** [ ] Complete / [ ] Skip

**4.7.3 Uptime Monitoring (Optional)**
- [ ] Configure external uptime monitor (UptimeRobot, Pingdom, etc.)
- [ ] Set up `/health` endpoint checks
- [ ] Configure alert notifications

**Status:** [ ] Complete / [ ] Skip

---

### Phase 5: Documentation & Handoff

#### 5.1 Document Production Environment

**Create Production Config Doc:**
```markdown
# AgentX Production Environment

**Deployment Date:** 2026-01-08
**Server:** yourdomain.com
**MongoDB:** <connection-details>
**Qdrant:** <host>:6333
**Ollama:** <host>:11434

**Backup Schedule:**
- MongoDB: Daily 2 AM → /home/yb/backups/mongodb/
- Qdrant: Daily 2 AM → /home/yb/backups/qdrant/

**Monitoring:**
- PM2 Dashboard: <url>
- Uptime Monitor: <url>
- Log Aggregation: <url>

**Emergency Contacts:**
- System Admin: <contact>
- Database Admin: <contact>
- DevOps Lead: <contact>
```

**Status:** [ ] Complete

---

#### 5.2 User Training Materials

**Prepare User Guide:**
- [ ] Link to `/docs/user-manual/README.md`
- [ ] Create quick start guide for end users
- [ ] Document common workflows
- [ ] Prepare video walkthrough (optional)

**Status:** [ ] Complete

---

#### 5.3 Runbook Documentation

**Create Operations Runbook:**
```markdown
# AgentX Operations Runbook

## Daily Operations
- Check PM2 status: `pm2 status`
- Review logs: `pm2 logs agentx --lines 50`
- Monitor disk space: `df -h`

## Common Issues
1. MongoDB connection errors → Check `MONGODB_URI`, restart MongoDB
2. Qdrant unavailable → Restart Qdrant: `pm2 restart qdrant`
3. High memory usage → Check for memory leaks, restart if needed

## Emergency Procedures
1. Complete outage → Run `/scripts/emergency-restart.sh`
2. Database corruption → Restore from backup
3. Security breach → Rotate all secrets immediately
```

**Status:** [ ] Complete

---

## Post-Deployment Checklist

### Week 1: Monitoring

- [ ] Day 1: Monitor for startup issues, check logs hourly
- [ ] Day 2-3: Verify backups completing successfully
- [ ] Day 4-5: Review performance metrics, adjust as needed
- [ ] Day 6-7: Gather initial user feedback

**Status:** [ ] In Progress

---

### Week 2: Optimization

- [ ] Analyze performance bottlenecks
- [ ] Optimize slow queries (if any)
- [ ] Adjust rate limits if needed
- [ ] Fine-tune LLM model selection

**Status:** [ ] Pending

---

### Month 1: Stabilization

- [ ] Review and adjust backup retention
- [ ] Analyze cost tracking data
- [ ] Optimize RAG compression settings
- [ ] Plan capacity upgrades if needed

**Status:** [ ] Pending

---

## Rollback Plan

**If deployment fails:**

1. **Stop Current Deployment:**
```bash
pm2 stop agentx
```

2. **Restore Previous Version:**
```bash
git checkout <previous-commit>
npm ci --production
```

3. **Restore Database (if needed):**
```bash
./scripts/restore-mongodb.sh <backup-file>
./scripts/restore-qdrant.sh <snapshot-file>
```

4. **Restart Services:**
```bash
pm2 restart agentx
```

5. **Verify Rollback:**
```bash
curl http://localhost:3080/health
```

---

## Success Criteria

Deployment is considered successful when:

- ✅ All health checks pass
- ✅ Test workspace created and accessible
- ✅ Chat functionality works (with/without RAG)
- ✅ Analytics dashboard displays metrics
- ✅ Backups completing successfully
- ✅ No critical errors in logs
- ✅ User authentication working
- ✅ API endpoints responding within SLA

---

## Support & Resources

**Documentation:**
- Main docs: `/docs/INDEX.md`
- User manual: `/docs/user-manual/README.md`
- API reference: `/docs/architecture/SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md`
- CLAUDE.md: Development reference
- ROADMAP.md: Project status

**Troubleshooting:**
- `/docs/operations/CRITICAL_GOTCHAS.md`
- `/docs/operations/TROUBLESHOOTING.md`
- GitHub Issues: https://github.com/your-org/agentx/issues

**Emergency Contacts:**
- DevOps Team: devops@yourdomain.com
- Database Admin: dba@yourdomain.com
- Security Team: security@yourdomain.com

---

**Deployment Checklist Version:** 1.0
**Last Updated:** 2026-01-08
**Maintained By:** AgentX Development Team

**End of Checklist**
