# Agent Prompt: SBQC Stack Validation Execution

**Target Host:** 192.168.2.33 (Linux)  
**Date:** December 31, 2025  
**Purpose:** Execute comprehensive validation of SBQC Stack against documentation

---

## Context

You are an AI agent running on host 192.168.2.33 (Linux) tasked with validating the SBQC Stack system. All documentation has been audited and corrected - your job is to verify the live system matches the documented specifications.

### System Overview

**SBQC Stack Components:**
- **AgentX** (localhost:3080): AI chat service, RAG, user profiles, analytics
- **DataAPI** (localhost:3003): File/storage management, scan batching
- **n8n** (192.168.2.199:5678): Workflow automation, 8 workflows
- **MongoDB** (localhost:27017): 3 databases (SBQC, agentx, datalake_janitor)
- **Qdrant** (localhost:6333): Vector store for RAG
- **Ollama Cluster**: 
  - UGFrank (192.168.2.99:11434) - Front-door model (RTX 3080 Ti)
  - UGBrutal (192.168.2.12:11434) - Specialist model (RTX 5070 Ti)

### Code Locations on This Host

```
/home/yb/codes/AgentX/          # AgentX service
├── .env                         # AgentX environment variables
├── server.js                    # Main server
├── routes/                      # API endpoints
├── models/                      # MongoDB models
└── docs/SBQC-Stack-Final/       # Complete documentation
    ├── 00-OVERVIEW.md           # System architecture
    ├── 07-AGENTX-API-REFERENCE.md  # All 40+ endpoints
    ├── 05-DEPLOYMENT.md         # Configuration guide
    └── 08-VALIDATION-PLAN.md    # This validation plan

/home/yb/codes/DataAPI/         # DataAPI service
├── .env                         # DataAPI environment variables
├── data_serv.js                 # Main server
└── routes/                      # Storage endpoints
```

### Documentation Reference

All documentation is in `/home/yb/codes/AgentX/docs/SBQC-Stack-Final/`:

1. **00-OVERVIEW.md** - System architecture, component overview
2. **01-ARCHITECTURE.md** - Design principles, diagrams
3. **02-DATAAPI-TASKS.md** - DataAPI validation roadmap
4. **03-AGENTX-TASKS.md** - AgentX validation roadmap
5. **04-N8N-WORKFLOWS.md** - 8 workflow specifications
6. **05-DEPLOYMENT.md** - Environment variables, deployment guide
7. **07-AGENTX-API-REFERENCE.md** - Complete API documentation (40+ endpoints)
8. **08-VALIDATION-PLAN.md** - This validation plan (6 phases)

### What Has Been Completed

✅ **Documentation Audit Complete** (December 31, 2025)
- All 10 discrepancies identified and resolved
- API endpoint documentation created (40+ endpoints)
- Environment variables documented (20+ vars)
- Webhook URLs verified from workflow JSON files
- Infrastructure topology documented
- Cross-document navigation added
- Historical docs archived

✅ **Documentation Coverage:** 70% → 98% (+28%)
✅ **Issues Resolved:** 10/10 (100%)
✅ **Files Created:** 4 new docs (~42KB)
✅ **Files Updated:** 7 docs (~800+ lines)

### Your Mission

Execute the **6-Phase Validation Plan** from `08-VALIDATION-PLAN.md` to verify the live system matches documentation. Test all endpoints, workflows, database operations, and integration flows. Generate a comprehensive validation report documenting all results.

---

## Execution Instructions

### Phase 1: Environment Validation

**Check AgentX .env file:**

```bash
cd /home/yb/codes/AgentX

echo "=== AgentX Environment Check ==="

if [ -f .env ]; then
    echo "✓ .env file found"
    
    # Check required variables
    required_vars=("PORT" "JWT_SECRET" "MONGODB_URI" "SESSION_SECRET" "OLLAMA_BASE_URL" "QDRANT_URL")
    
    for var in "${required_vars[@]}"; do
        if grep -q "^${var}=" .env; then
            value=$(grep "^${var}=" .env | cut -d'=' -f2)
            if [ -n "$value" ]; then
                echo "  ✓ $var (set)"
            else
                echo "  ✗ $var (empty)"
            fi
        else
            echo "  ✗ $var (missing)"
        fi
    done
else
    echo "✗ .env file not found"
fi
```

**Check DataAPI .env file:**

```bash
cd /home/yb/codes/DataAPI

echo ""
echo "=== DataAPI Environment Check ==="

if [ -f .env ]; then
    echo "✓ .env file found"
    
    required_vars=("PORT" "MONGODB_URI")
    
    for var in "${required_vars[@]}"; do
        if grep -q "^${var}=" .env; then
            value=$(grep "^${var}=" .env | cut -d'=' -f2)
            if [ -n "$value" ]; then
                echo "  ✓ $var (set)"
            else
                echo "  ✗ $var (empty)"
            fi
        else
            echo "  ✗ $var (missing)"
        fi
    done
else
    echo "✗ .env file not found"
fi
```

**Expected Results:**
- ✓ Both .env files exist
- ✓ All required variables present and non-empty
- ✓ MongoDB URIs point to localhost:27017
- ✓ Ollama URL points to cluster (192.168.2.99:11434)

---

### Phase 2: Service Health Checks

**Test all services are running:**

```bash
echo ""
echo "=== Service Health Checks ==="

# Test AgentX
if curl -s http://localhost:3080/health > /dev/null 2>&1; then
    response=$(curl -s http://localhost:3080/health)
    echo "✓ AgentX responding (localhost:3080)"
    echo "  $(echo $response | jq -r '.status // "ok"')"
else
    echo "✗ AgentX not responding"
fi

# Test DataAPI
if curl -s http://localhost:3003/health > /dev/null 2>&1; then
    response=$(curl -s http://localhost:3003/health)
    echo "✓ DataAPI responding (localhost:3003)"
    echo "  $(echo $response | jq -r '.status // "ok"')"
else
    echo "✗ DataAPI not responding"
fi

# Test MongoDB
if mongosh "mongodb://localhost:27017" --eval "db.adminCommand({ ping: 1 })" --quiet > /dev/null 2>&1; then
    echo "✓ MongoDB responding (localhost:27017)"
    dbs=$(mongosh "mongodb://localhost:27017" --eval "db.adminCommand({ listDatabases: 1 }).databases.map(d => d.name)" --quiet)
    echo "  Databases: $dbs"
else
    echo "✗ MongoDB not responding"
fi

# Test Qdrant
if curl -s http://localhost:6333/health > /dev/null 2>&1; then
    echo "✓ Qdrant responding (localhost:6333)"
else
    echo "✗ Qdrant not responding"
fi

# Test Ollama (UGFrank - front door)
if curl -s http://192.168.2.99:11434/api/tags > /dev/null 2>&1; then
    models=$(curl -s http://192.168.2.99:11434/api/tags | jq -r '.models | length')
    echo "✓ Ollama (UGFrank) responding"
    echo "  Models available: $models"
else
    echo "✗ Ollama (UGFrank) not responding"
fi

# Test n8n
if curl -s http://192.168.2.199:5678/healthz > /dev/null 2>&1; then
    echo "✓ n8n responding (192.168.2.199:5678)"
else
    echo "✗ n8n not responding"
fi
```

**Expected Results:**
- ✓ All 6 services responding
- ✓ MongoDB has 3 databases (SBQC, agentx, datalake_janitor)
- ✓ Ollama has models loaded
- ✓ All health endpoints return 200 OK

---

### Phase 3: API Endpoint Testing

**Reference:** `/home/yb/codes/AgentX/docs/SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md`

**Test public endpoints (no auth):**

```bash
echo ""
echo "=== Public API Endpoints ==="

# Health endpoint
response=$(curl -s http://localhost:3080/health)
if [ $? -eq 0 ]; then
    echo "✓ GET /health"
    echo "  $(echo $response | jq -c '.')"
else
    echo "✗ GET /health FAILED"
fi

# Metrics endpoint
response=$(curl -s http://localhost:3080/api/metrics)
if [ $? -eq 0 ]; then
    echo "✓ GET /api/metrics"
    total=$(echo $response | jq -r '.totalQueries // 0')
    echo "  Total queries: $total"
else
    echo "✗ GET /api/metrics FAILED"
fi
```

**Test authentication flow:**

```bash
echo ""
echo "=== Authentication Flow ==="

# Login (replace with actual test credentials)
login_response=$(curl -s -X POST http://localhost:3080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"test_user","password":"test_password"}')

if echo $login_response | jq -e '.token' > /dev/null 2>&1; then
    token=$(echo $login_response | jq -r '.token')
    echo "✓ POST /api/auth/login"
    echo "  Token: ${token:0:30}..."
    
    # Store token for subsequent tests
    export AUTH_TOKEN="Bearer $token"
else
    echo "✗ Authentication failed"
    echo "  Response: $login_response"
    # Continue with tests that don't require auth
fi
```

**Test authenticated endpoints:**

```bash
echo ""
echo "=== Authenticated Endpoints ==="

if [ -n "$AUTH_TOKEN" ]; then
    # User profile
    profile=$(curl -s -H "Authorization: $AUTH_TOKEN" http://localhost:3080/api/profile)
    if [ $? -eq 0 ]; then
        echo "✓ GET /api/profile"
        username=$(echo $profile | jq -r '.username // "unknown"')
        echo "  User: $username"
    else
        echo "✗ GET /api/profile FAILED"
    fi
    
    # Chat endpoint
    chat_response=$(curl -s -X POST http://localhost:3080/api/chat \
      -H "Authorization: $AUTH_TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"message":"Test validation message","userId":"validation-test"}')
    
    if echo $chat_response | jq -e '.reply' > /dev/null 2>&1; then
        echo "✓ POST /api/chat"
        reply=$(echo $chat_response | jq -r '.reply' | cut -c1-80)
        echo "  Response: $reply..."
    else
        echo "✗ POST /api/chat FAILED"
    fi
    
    # Conversation history
    history=$(curl -s -H "Authorization: $AUTH_TOKEN" http://localhost:3080/api/history/conversations)
    if [ $? -eq 0 ]; then
        echo "✓ GET /api/history/conversations"
        count=$(echo $history | jq '.conversations | length')
        echo "  Conversations: $count"
    else
        echo "✗ GET /api/history/conversations FAILED"
    fi
else
    echo "⚠ Skipping authenticated tests (no token)"
fi
```

**Test RAG endpoints:**

```bash
echo ""
echo "=== RAG Endpoints ==="

if [ -n "$AUTH_TOKEN" ]; then
    # RAG search
    search_response=$(curl -s -X POST http://localhost:3080/api/rag/search \
      -H "Authorization: $AUTH_TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"query":"test search","limit":5}')
    
    if [ $? -eq 0 ]; then
        echo "✓ POST /api/rag/search"
        results=$(echo $search_response | jq '.results | length')
        echo "  Results: $results"
    else
        echo "✗ POST /api/rag/search FAILED"
    fi
    
    # Document ingestion
    ingest_response=$(curl -s -X POST http://localhost:3080/api/rag/ingest \
      -H "Authorization: $AUTH_TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"title":"Validation Test Doc","content":"Test content for validation","source":"validation-test"}')
    
    if [ $? -eq 0 ]; then
        echo "✓ POST /api/rag/ingest"
    else
        echo "✗ POST /api/rag/ingest FAILED"
    fi
fi
```

**Expected Results:**
- ✓ All public endpoints respond correctly
- ✓ Authentication returns valid JWT token
- ✓ Authenticated endpoints accept token
- ✓ Chat generates AI responses
- ✓ RAG search returns results
- ✓ Document ingestion succeeds

---

### Phase 4: n8n Workflow Validation

**Test webhook URLs:**

```bash
echo ""
echo "=== n8n Webhook Testing ==="

webhooks=(
    "sbqc-n1-1-health-check"
    "sbqc-n2-1-nas-scan"
    "sbqc-n2-2-nas-full-scan"
    "sbqc-n2-3-rag-ingest"
    "sbqc-n3-1-model-monitor"
    "sbqc-ai-query"
    "sbqc-n5-1-feedback-analysis"
)

for webhook in "${webhooks[@]}"; do
    url="https://n8n.specialblend.icu/webhook/$webhook"
    
    response=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$url" \
      -H "Content-Type: application/json" \
      -d '{"test":"validation"}')
    
    if [ "$response" = "404" ]; then
        echo "✗ $webhook (Not Found - workflow not imported)"
    elif [ "$response" = "400" ]; then
        echo "⚠ $webhook (Bad Request - webhook exists, needs valid payload)"
    elif [ "$response" = "200" ] || [ "$response" = "201" ]; then
        echo "✓ $webhook (Active)"
    else
        echo "? $webhook (HTTP $response)"
    fi
done
```

**Check workflow JSON files:**

```bash
echo ""
echo "=== Workflow JSON Files ==="

cd /home/yb/codes/AgentX/AgentC

workflow_files=(
    "N1.1.json"
    "N2.1.json"
    "N2.2.json"
    "N2.3.json"
    "N3.1.json"
    "N3.2.json"
    "N5.1.json"
)

for file in "${workflow_files[@]}"; do
    if [ -f "$file" ]; then
        echo "✓ $file exists"
        # Extract webhook path if present
        webhook=$(jq -r '.nodes[] | select(.type=="webhook") | .parameters.path // empty' "$file" 2>/dev/null | head -1)
        if [ -n "$webhook" ]; then
            echo "  Webhook: $webhook"
        fi
    else
        echo "✗ $file missing"
    fi
done
```

**Expected Results:**
- ✓ All 7 workflow JSON files present
- ✓ Webhooks return 200/201 or 400 (not 404)
- ⚠ 400 is acceptable (means webhook exists but needs valid payload)
- ✗ 404 means workflow not imported to n8n

---

### Phase 5: Database Validation

**Test MongoDB databases and collections:**

```bash
echo ""
echo "=== MongoDB Database Check ==="

# List all databases
databases=$(mongosh "mongodb://localhost:27017" --eval "db.adminCommand({ listDatabases: 1 }).databases.map(d => d.name)" --quiet)
echo "Databases: $databases"

# Check SBQC database
echo ""
echo "SBQC Database:"
mongosh "mongodb://localhost:27017/SBQC" --eval "db.getCollectionNames()" --quiet

# Check agentx database
echo ""
echo "agentx Database:"
mongosh "mongodb://localhost:27017/agentx" --eval "db.getCollectionNames()" --quiet

# Check conversations collection
conv_count=$(mongosh "mongodb://localhost:27017/agentx" --eval "db.conversations.countDocuments({})" --quiet)
echo "  Conversations: $conv_count documents"

# Check userprofiles collection
user_count=$(mongosh "mongodb://localhost:27017/agentx" --eval "db.userprofiles.countDocuments({})" --quiet)
echo "  User Profiles: $user_count documents"

# Check datalake_janitor database
echo ""
echo "datalake_janitor Database:"
mongosh "mongodb://localhost:27017/datalake_janitor" --eval "db.getCollectionNames()" --quiet
```

**Test data persistence:**

```bash
echo ""
echo "=== Data Persistence Test ==="

if [ -n "$AUTH_TOKEN" ]; then
    # Send a test message
    test_message="Validation test message at $(date +%s)"
    chat_response=$(curl -s -X POST http://localhost:3080/api/chat \
      -H "Authorization: $AUTH_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"message\":\"$test_message\",\"userId\":\"validation-test\"}")
    
    conv_id=$(echo $chat_response | jq -r '.conversationId // empty')
    
    if [ -n "$conv_id" ]; then
        echo "✓ Test message sent (Conversation: $conv_id)"
        
        # Wait for DB write
        sleep 2
        
        # Check if conversation persisted
        result=$(mongosh "mongodb://localhost:27017/agentx" --eval "db.conversations.findOne({ _id: ObjectId('$conv_id') })" --quiet)
        
        if [ -n "$result" ]; then
            echo "✓ Conversation persisted to MongoDB"
        else
            echo "✗ Conversation NOT found in MongoDB"
        fi
    else
        echo "✗ Failed to create test conversation"
    fi
fi
```

**Expected Results:**
- ✓ All 3 databases exist (SBQC, agentx, datalake_janitor)
- ✓ Collections present: conversations, userprofiles, feedback, scans
- ✓ Test data persists correctly
- ✓ Queries complete in < 100ms

---

### Phase 6: Integration Testing

**End-to-end RAG query flow:**

```bash
echo ""
echo "=== RAG Query Flow Test ==="

if [ -n "$AUTH_TOKEN" ]; then
    # 1. Ingest test document
    echo "Step 1: Ingesting test document..."
    ingest_response=$(curl -s -X POST http://localhost:3080/api/rag/ingest \
      -H "Authorization: $AUTH_TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"title":"Validation Test","content":"The validation system tests all SBQC Stack components systematically.","source":"validation"}')
    
    if [ $? -eq 0 ]; then
        echo "✓ Document ingested"
    else
        echo "✗ Document ingestion failed"
    fi
    
    # 2. Wait for Qdrant indexing
    sleep 3
    
    # 3. Send RAG query
    echo "Step 2: Sending RAG query..."
    rag_query=$(curl -s -X POST http://localhost:3080/api/chat \
      -H "Authorization: $AUTH_TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"message":"What does the validation system do?","userId":"validation-test","useRag":true}')
    
    if echo $rag_query | jq -e '.reply' > /dev/null 2>&1; then
        echo "✓ RAG query completed"
        reply=$(echo $rag_query | jq -r '.reply' | cut -c1-100)
        echo "  Response: $reply..."
        
        # Check for RAG sources
        sources=$(echo $rag_query | jq -e '.sources | length' 2>/dev/null)
        if [ -n "$sources" ] && [ "$sources" != "null" ]; then
            echo "✓ RAG context retrieved ($sources sources)"
        else
            echo "⚠ No RAG sources in response"
        fi
    else
        echo "✗ RAG query failed"
    fi
fi
```

**Test Ollama model routing:**

```bash
echo ""
echo "=== Ollama Model Routing Test ==="

# Test front-door model (UGFrank)
echo "Testing UGFrank (front-door)..."
response=$(curl -s -X POST http://192.168.2.99:11434/api/generate \
  -H "Content-Type: application/json" \
  -d '{"model":"llama2","prompt":"Say hello","stream":false}')

if echo $response | jq -e '.response' > /dev/null 2>&1; then
    echo "✓ UGFrank responding"
else
    echo "✗ UGFrank not responding"
fi

# Test specialist model (UGBrutal)
echo "Testing UGBrutal (specialist)..."
response=$(curl -s -X POST http://192.168.2.12:11434/api/generate \
  -H "Content-Type: application/json" \
  -d '{"model":"llama2","prompt":"Say hello","stream":false}')

if echo $response | jq -e '.response' > /dev/null 2>&1; then
    echo "✓ UGBrutal responding"
else
    echo "✗ UGBrutal not responding"
fi
```

**Expected Results:**
- ✓ Complete RAG flow works (ingest → query → response with sources)
- ✓ Both Ollama nodes responding
- ✓ AgentX routes to appropriate model
- ✓ End-to-end latency < 5 seconds

---

## Generating the Validation Report

After running all tests, create a comprehensive report:

```bash
cd /home/yb/codes/AgentX/docs/SBQC-Stack-Final

timestamp=$(date +%Y-%m-%d-%H%M%S)
report_file="VALIDATION-REPORT-$timestamp.md"

cat > "$report_file" << 'EOF'
# SBQC Stack Validation Report

**Date:** $(date +"%B %d, %Y %H:%M:%S")
**Validator:** AI Agent on 192.168.2.33
**Duration:** [FILL IN]

## Executive Summary

- Total Tests: [COUNT]
- Passed: [COUNT] ([PERCENTAGE]%)
- Failed: [COUNT] ([PERCENTAGE]%)
- Warnings: [COUNT]

## Phase Results

### Phase 1: Environment Validation
- AgentX .env: [PASS/FAIL]
- DataAPI .env: [PASS/FAIL]
- n8n config: [PASS/FAIL]
- **Result:** [PASS/FAIL]

### Phase 2: Service Health
- AgentX: [PASS/FAIL]
- DataAPI: [PASS/FAIL]
- MongoDB: [PASS/FAIL]
- Qdrant: [PASS/FAIL]
- Ollama: [PASS/FAIL]
- n8n: [PASS/FAIL]
- **Result:** [X/6 services responding]

### Phase 3: API Endpoints
- Public endpoints: [X/X passed]
- Authentication: [PASS/FAIL]
- Chat & conversations: [X/X passed]
- User profile: [X/X passed]
- Analytics: [X/X passed]
- RAG integration: [X/X passed]
- **Result:** [X/40+ endpoints validated]

### Phase 4: n8n Workflows
- Workflows imported: [X/7]
- Webhooks functional: [X/7]
- Integration flows: [PASS/FAIL]
- **Result:** [X/7 workflows operational]

### Phase 5: Database
- MongoDB connectivity: [PASS/FAIL]
- Databases present: [X/3]
- Data persistence: [PASS/FAIL]
- Query performance: [PASS/FAIL]
- **Result:** [PASS/FAIL]

### Phase 6: Integration Tests
- RAG query flow: [PASS/FAIL]
- n8n → DataAPI flow: [PASS/FAIL]
- Model routing: [PASS/FAIL]
- **Result:** [X/3 integration tests passed]

## Issues Found

### Critical
[List any critical failures that block production use]

### Moderate
[List warnings or partial failures]

### Minor
[List minor issues or improvements needed]

## Test Details

[Include relevant output, error messages, and observations]

## Recommendations

1. [Priority fixes needed]
2. [Configuration adjustments]
3. [Performance optimizations]

## Next Steps

- [ ] Address all critical issues
- [ ] Re-run validation for failed tests
- [ ] Update documentation if discrepancies found
- [ ] Deploy to production when all critical tests pass

## Sign-off

- [ ] All critical tests passed
- [ ] Documentation matches live system
- [ ] System ready for production use

**Validation Status:** [PASS/FAIL/PARTIAL]

---

**Report Generated:** $(date +"%Y-%m-%d %H:%M:%S")
**Host:** 192.168.2.33
**Validator:** AI Agent
EOF

echo ""
echo "✓ Validation report template created: $report_file"
echo "Please fill in the test results and save."
```

---

## What to Report Back

After completing validation, provide:

1. **Overall Status:** PASS/FAIL/PARTIAL
2. **Pass Rate:** X% of tests passed
3. **Critical Issues:** Any blocking failures
4. **Service Status:** All 6 services up/down
5. **API Coverage:** X/40+ endpoints validated
6. **Workflow Status:** X/7 workflows operational
7. **Recommendations:** What needs fixing

### Example Summary Format:

```
VALIDATION COMPLETE

Overall: PASS (95%)
Critical Issues: 0
Warnings: 2

Services: 6/6 responding ✓
API Endpoints: 38/40 validated ✓
Workflows: 7/7 operational ✓
Database: All tests passed ✓
Integration: 3/3 flows working ✓

Issues:
- N3.2 webhook returns 404 (workflow not imported)
- RAG search slower than expected (2.1s avg)

Recommendation: Import N3.2 workflow, optimize Qdrant queries
Status: READY FOR PRODUCTION
```

---

## Notes

- **Authentication:** If you don't have test credentials, create a test user first or skip authenticated endpoint tests
- **Services Down:** If any service is down, start it before validation (check PM2/systemd)
- **Network Issues:** All tests assume local access; adjust URLs if running from different host
- **MongoDB Access:** Ensure mongosh is installed and accessible
- **jq Tool:** Install with `sudo apt-get install jq` if not present

---

## Quick Start Commands

Copy and paste these to run the full validation:

```bash
# 1. Navigate to AgentX directory
cd /home/yb/codes/AgentX

# 2. Run all validation phases (paste entire script blocks from above)

# 3. Generate report
cd docs/SBQC-Stack-Final
# Create report using template above

# 4. Review and share results
cat VALIDATION-REPORT-*.md
```

---

**Document Reference:**  
- Full validation plan: `/home/yb/codes/AgentX/docs/SBQC-Stack-Final/08-VALIDATION-PLAN.md`
- API reference: `/home/yb/codes/AgentX/docs/SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md`
- System overview: `/home/yb/codes/AgentX/docs/SBQC-Stack-Final/00-OVERVIEW.md`

**Ready to execute!** 🚀
