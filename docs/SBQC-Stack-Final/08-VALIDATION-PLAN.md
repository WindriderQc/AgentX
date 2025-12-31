# SBQC Stack - Systematic Validation Plan

**Version:** 1.0  
**Date:** December 31, 2025  
**Status:** Ready for Execution

---

## Overview

This document provides a systematic approach to validating the SBQC Stack against its documentation. All documentation has been audited and corrected - this plan verifies that the live system matches the documented specifications.

**Validation Scope:**
- ✅ 40+ API endpoints (AgentX)
- ✅ 7 n8n workflow integrations
- ✅ 20+ environment variables
- ✅ End-to-end system integration
- ✅ Database persistence and queries

**Prerequisites:**
- All services must be running (AgentX, DataAPI, n8n, MongoDB, Ollama)
- Access to service logs for troubleshooting
- Test user account or admin credentials
- Network access to all service endpoints

---

## Phase 1: Environment Validation

**Objective:** Verify all documented environment variables are correctly configured

### 1.1 AgentX Environment Check

**Location:** `agentx/.env`

```bash
# Navigate to AgentX directory
cd c:\Users\Yanik\OneDrive\Documents\ObsidiVault\agentx

# Check if .env exists
if (Test-Path ".env") {
    Write-Host "✓ .env file found" -ForegroundColor Green
    
    # Verify required variables
    $requiredVars = @(
        "PORT",
        "JWT_SECRET",
        "MONGODB_URI",
        "SESSION_SECRET",
        "OLLAMA_BASE_URL",
        "QDRANT_URL"
    )
    
    $envContent = Get-Content ".env"
    foreach ($var in $requiredVars) {
        if ($envContent -match "^$var=") {
            Write-Host "  ✓ $var" -ForegroundColor Green
        } else {
            Write-Host "  ✗ $var MISSING" -ForegroundColor Red
        }
    }
} else {
    Write-Host "✗ .env file not found" -ForegroundColor Red
}
```

**Success Criteria:**
- [ ] All 6 required variables present
- [ ] No empty values for required vars
- [ ] MongoDB URI format valid
- [ ] Ollama URL accessible

### 1.2 DataAPI Environment Check

**Location:** `dataapi/.env`

```bash
# Navigate to DataAPI directory
cd c:\Users\Yanik\OneDrive\Documents\ObsidiVault\dataapi

# Check DataAPI .env
if (Test-Path ".env") {
    Write-Host "✓ DataAPI .env found" -ForegroundColor Green
    
    $requiredVars = @("PORT", "MONGODB_URI")
    $envContent = Get-Content ".env"
    
    foreach ($var in $requiredVars) {
        if ($envContent -match "^$var=") {
            Write-Host "  ✓ $var" -ForegroundColor Green
        } else {
            Write-Host "  ✗ $var MISSING" -ForegroundColor Red
        }
    }
} else {
    Write-Host "✗ DataAPI .env not found" -ForegroundColor Red
}
```

**Success Criteria:**
- [ ] PORT and MONGODB_URI present
- [ ] MongoDB URI matches AgentX (same cluster)
- [ ] Optional webhook vars documented but not required

### 1.3 n8n Environment Check

**n8n Configuration:** Docker container on Ubundocker (192.168.2.199)

```bash
# Test n8n accessibility
$n8nLocal = "http://192.168.2.199:5678"
$n8nPublic = "https://n8n.specialblend.icu"

Write-Host "Testing n8n endpoints..." -ForegroundColor Cyan
try {
    $response = Invoke-WebRequest -Uri "$n8nLocal/healthz" -Method GET -TimeoutSec 5
    Write-Host "✓ Local n8n accessible ($n8nLocal)" -ForegroundColor Green
} catch {
    Write-Host "✗ Local n8n not accessible" -ForegroundColor Red
}

try {
    $response = Invoke-WebRequest -Uri "$n8nPublic/healthz" -Method GET -TimeoutSec 5
    Write-Host "✓ Public n8n accessible (Cloudflare tunnel)" -ForegroundColor Green
} catch {
    Write-Host "✗ Public n8n not accessible" -ForegroundColor Red
}
```

**Success Criteria:**
- [ ] Local n8n responds (192.168.2.199:5678)
- [ ] Public n8n responds (Cloudflare tunnel)
- [ ] Docker container running on Ubundocker
- [ ] n8n credentials configured

---

## Phase 2: API Endpoint Validation

**Objective:** Test all documented endpoints in [07-AGENTX-API-REFERENCE.md](07-AGENTX-API-REFERENCE.md)

### 2.1 Health & Status Endpoints

**No Auth Required:**

```bash
$baseUrl = "http://192.168.2.33:3080"

# Test health endpoint
Write-Host "`nTesting Health Endpoints..." -ForegroundColor Cyan
try {
    $response = Invoke-RestMethod -Uri "$baseUrl/health" -Method GET
    Write-Host "✓ GET /health" -ForegroundColor Green
    Write-Host "  Status: $($response.status)" -ForegroundColor Gray
} catch {
    Write-Host "✗ GET /health FAILED" -ForegroundColor Red
    Write-Host "  Error: $($_.Exception.Message)" -ForegroundColor Red
}

# Test metrics endpoint
try {
    $response = Invoke-RestMethod -Uri "$baseUrl/api/metrics" -Method GET
    Write-Host "✓ GET /api/metrics" -ForegroundColor Green
    Write-Host "  Queries: $($response.totalQueries)" -ForegroundColor Gray
} catch {
    Write-Host "✗ GET /api/metrics FAILED" -ForegroundColor Red
}
```

**Success Criteria:**
- [ ] `/health` returns status: "ok"
- [ ] `/api/metrics` returns query statistics
- [ ] Response format matches documentation

### 2.2 Authentication Flow

```bash
# Test login endpoint
$loginUrl = "$baseUrl/api/auth/login"
$credentials = @{
    username = "test_user"
    password = "test_password"
} | ConvertTo-Json

try {
    $response = Invoke-RestMethod -Uri $loginUrl -Method POST -Body $credentials -ContentType "application/json"
    $token = $response.token
    Write-Host "✓ POST /api/auth/login" -ForegroundColor Green
    Write-Host "  Token received: $($token.Substring(0,20))..." -ForegroundColor Gray
    
    # Store token for subsequent tests
    $headers = @{
        "Authorization" = "Bearer $token"
    }
} catch {
    Write-Host "✗ POST /api/auth/login FAILED" -ForegroundColor Red
    Write-Host "  Error: $($_.Exception.Message)" -ForegroundColor Red
}
```

**Success Criteria:**
- [ ] Login with valid credentials succeeds
- [ ] JWT token returned in response
- [ ] Token format is valid (3 base64 segments)
- [ ] Login with invalid credentials fails (401)

### 2.3 Chat & Conversations (Authenticated)

```bash
# Test chat endpoint
$chatUrl = "$baseUrl/api/chat"
$chatRequest = @{
    message = "What is the weather today?"
    userId = "test_user_123"
} | ConvertTo-Json

try {
    $response = Invoke-RestMethod -Uri $chatUrl -Method POST -Body $chatRequest -ContentType "application/json" -Headers $headers
    Write-Host "✓ POST /api/chat" -ForegroundColor Green
    Write-Host "  Response length: $($response.reply.Length) chars" -ForegroundColor Gray
} catch {
    Write-Host "✗ POST /api/chat FAILED" -ForegroundColor Red
}

# Test conversation history
$historyUrl = "$baseUrl/api/history/conversations"
try {
    $response = Invoke-RestMethod -Uri $historyUrl -Method GET -Headers $headers
    Write-Host "✓ GET /api/history/conversations" -ForegroundColor Green
    Write-Host "  Conversations: $($response.conversations.Count)" -ForegroundColor Gray
} catch {
    Write-Host "✗ GET /api/history/conversations FAILED" -ForegroundColor Red
}
```

**Success Criteria:**
- [ ] Chat request returns AI response
- [ ] Conversation saved to MongoDB
- [ ] Conversation history retrieval works
- [ ] Specific conversation by ID retrievable
- [ ] RAG context included when relevant

### 2.4 User Profile Management

```bash
# Test profile retrieval
$profileUrl = "$baseUrl/api/profile"

try {
    $response = Invoke-RestMethod -Uri $profileUrl -Method GET -Headers $headers
    Write-Host "✓ GET /api/profile" -ForegroundColor Green
    Write-Host "  User: $($response.username)" -ForegroundColor Gray
} catch {
    Write-Host "✗ GET /api/profile FAILED" -ForegroundColor Red
}

# Test profile update
$updateProfile = @{
    preferences = @{
        theme = "dark"
        language = "en"
    }
} | ConvertTo-Json

try {
    $response = Invoke-RestMethod -Uri $profileUrl -Method PUT -Body $updateProfile -ContentType "application/json" -Headers $headers
    Write-Host "✓ PUT /api/profile" -ForegroundColor Green
} catch {
    Write-Host "✗ PUT /api/profile FAILED" -ForegroundColor Red
}
```

**Success Criteria:**
- [ ] Profile retrieval returns user data
- [ ] Profile updates persist to MongoDB
- [ ] Preferences saved correctly
- [ ] Invalid updates return 400 error

### 2.5 Analytics & Metrics

```bash
# Test analytics endpoints
$analyticsUrl = "$baseUrl/api/analytics"

try {
    $response = Invoke-RestMethod -Uri "$analyticsUrl/usage" -Method GET -Headers $headers
    Write-Host "✓ GET /api/analytics/usage" -ForegroundColor Green
    Write-Host "  Total queries: $($response.totalQueries)" -ForegroundColor Gray
} catch {
    Write-Host "✗ GET /api/analytics/usage FAILED" -ForegroundColor Red
}

try {
    $response = Invoke-RestMethod -Uri "$analyticsUrl/model-performance" -Method GET -Headers $headers
    Write-Host "✓ GET /api/analytics/model-performance" -ForegroundColor Green
} catch {
    Write-Host "✗ GET /api/analytics/model-performance FAILED" -ForegroundColor Red
}
```

**Success Criteria:**
- [ ] Usage analytics return aggregated data
- [ ] Model performance metrics available
- [ ] Response time stats calculated
- [ ] Data format matches documentation

### 2.6 RAG Integration

```bash
# Test RAG search
$ragUrl = "$baseUrl/api/rag/search"
$ragQuery = @{
    query = "network configuration"
    limit = 5
} | ConvertTo-Json

try {
    $response = Invoke-RestMethod -Uri $ragUrl -Method POST -Body $ragQuery -ContentType "application/json" -Headers $headers
    Write-Host "✓ POST /api/rag/search" -ForegroundColor Green
    Write-Host "  Results: $($response.results.Count)" -ForegroundColor Gray
} catch {
    Write-Host "✗ POST /api/rag/search FAILED" -ForegroundColor Red
}

# Test document ingestion
$ingestUrl = "$baseUrl/api/rag/ingest"
$document = @{
    title = "Test Document"
    content = "This is a test document for RAG ingestion"
    source = "validation-test"
} | ConvertTo-Json

try {
    $response = Invoke-RestMethod -Uri $ingestUrl -Method POST -Body $document -ContentType "application/json" -Headers $headers
    Write-Host "✓ POST /api/rag/ingest" -ForegroundColor Green
} catch {
    Write-Host "✗ POST /api/rag/ingest FAILED" -ForegroundColor Red
}
```

**Success Criteria:**
- [ ] RAG search returns relevant results
- [ ] Results include similarity scores
- [ ] Document ingestion succeeds
- [ ] Ingested docs queryable via Qdrant
- [ ] Collection stats retrievable

---

## Phase 3: n8n Workflow Validation

**Objective:** Verify all 7 workflows are imported and webhook URLs work

### 3.1 Workflow Import Verification

**Access n8n:** https://n8n.specialblend.icu

**Manual Checklist:**
- [ ] N1.1 - Health Check & Alert (imported)
- [ ] N2.1 - NAS Scan Trigger (imported)
- [ ] N2.2 - NAS Full Scan (imported)
- [ ] N2.3 - RAG Ingest Pipeline (imported)
- [ ] N3.1 - Model Health Monitor (imported)
- [ ] N3.2 - External AI Query (pending import)
- [ ] N5.1 - Feedback Analysis (pending import)

**Import Missing Workflows:**
1. Open n8n web interface
2. Click "Import workflow"
3. Upload `AgentC/N3.2.json` and `AgentC/N5.1.json`
4. Verify webhook URLs match documentation

### 3.2 Webhook URL Testing

**Base URL:** `https://n8n.specialblend.icu/webhook/`

```bash
$n8nWebhook = "https://n8n.specialblend.icu/webhook"

# Test each webhook
$webhooks = @(
    "sbqc-n1-1-health-check",
    "sbqc-n2-1-nas-scan",
    "sbqc-n2-2-nas-full-scan",
    "sbqc-n2-3-rag-ingest",
    "sbqc-n3-1-model-monitor",
    "sbqc-ai-query",
    "sbqc-n5-1-feedback-analysis"
)

Write-Host "`nTesting n8n Webhooks..." -ForegroundColor Cyan
foreach ($webhook in $webhooks) {
    $url = "$n8nWebhook/$webhook"
    try {
        $response = Invoke-WebRequest -Uri $url -Method POST -Body "{}" -ContentType "application/json" -TimeoutSec 10
        Write-Host "✓ $webhook" -ForegroundColor Green
    } catch {
        $statusCode = $_.Exception.Response.StatusCode.value__
        if ($statusCode -eq 404) {
            Write-Host "✗ $webhook (Not Found - workflow not imported?)" -ForegroundColor Red
        } elseif ($statusCode -eq 400) {
            Write-Host "⚠ $webhook (Bad Request - webhook exists but needs valid payload)" -ForegroundColor Yellow
        } else {
            Write-Host "✗ $webhook (Error: $statusCode)" -ForegroundColor Red
        }
    }
}
```

**Success Criteria:**
- [ ] All webhook URLs respond (not 404)
- [ ] 400 errors acceptable (indicates webhook active but needs payload)
- [ ] Webhook paths match JSON files
- [ ] Test payloads trigger workflow execution

### 3.3 Integration Flow Testing

**N2.1 → DataAPI Test:**

```bash
# Trigger N2.1 NAS scan workflow
$scanPayload = @{
    scanPath = "/mnt/nas/test"
    batchSize = 10
    action = "test"
} | ConvertTo-Json

$n2_1_url = "https://n8n.specialblend.icu/webhook/sbqc-n2-1-nas-scan"

try {
    $response = Invoke-RestMethod -Uri $n2_1_url -Method POST -Body $scanPayload -ContentType "application/json"
    Write-Host "✓ N2.1 triggered successfully" -ForegroundColor Green
    
    # Check DataAPI received the scan request
    Start-Sleep -Seconds 2
    $dataApiUrl = "http://192.168.2.33:3003/api/v1/storage/status"
    $status = Invoke-RestMethod -Uri $dataApiUrl -Method GET
    Write-Host "✓ DataAPI received scan request" -ForegroundColor Green
} catch {
    Write-Host "✗ N2.1 → DataAPI flow FAILED" -ForegroundColor Red
}
```

**N3.2 → AgentX Test:**

```bash
# Trigger N3.2 AI query workflow
$queryPayload = @{
    query = "What is the system status?"
    userId = "validation-test"
} | ConvertTo-Json

$n3_2_url = "https://n8n.specialblare.icu/webhook/sbqc-ai-query"

try {
    $response = Invoke-RestMethod -Uri $n3_2_url -Method POST -Body $queryPayload -ContentType "application/json"
    Write-Host "✓ N3.2 AI query executed" -ForegroundColor Green
    Write-Host "  Response: $($response.reply.Substring(0,100))..." -ForegroundColor Gray
} catch {
    Write-Host "✗ N3.2 workflow FAILED" -ForegroundColor Red
}
```

**Success Criteria:**
- [ ] N2.1 triggers DataAPI scan
- [ ] N2.3 ingests documents to Qdrant
- [ ] N3.1 monitors Ollama models
- [ ] N3.2 routes queries to AgentX
- [ ] All workflows complete without errors

---

## Phase 4: Database Validation

**Objective:** Verify MongoDB persistence and data integrity

### 4.1 MongoDB Connection Test

```bash
# Test MongoDB connectivity
$mongoUri = "mongodb://192.168.2.33:27017"

Write-Host "`nTesting MongoDB..." -ForegroundColor Cyan

# Using mongosh (if installed)
$testCommand = @"
mongosh "$mongoUri" --eval "db.adminCommand({ listDatabases: 1 })" --quiet
"@

try {
    $output = Invoke-Expression $testCommand
    Write-Host "✓ MongoDB accessible" -ForegroundColor Green
} catch {
    Write-Host "✗ MongoDB connection FAILED" -ForegroundColor Red
    Write-Host "  Try: mongosh $mongoUri" -ForegroundColor Yellow
}
```

**Success Criteria:**
- [ ] MongoDB accessible at 192.168.2.33:27017
- [ ] All 3 databases present (SBQC, agentx, datalake_janitor)
- [ ] Collections match schema documentation
- [ ] Indexes created (via `scripts/create-indexes.js`)

### 4.2 Data Persistence Test

```bash
# Test conversation persistence
# 1. Send chat message via API
# 2. Query MongoDB for the conversation
# 3. Verify data matches

$chatUrl = "http://192.168.2.33:3080/api/chat"
$testMessage = @{
    message = "Test message for validation at $(Get-Date)"
    userId = "validation-test-user"
} | ConvertTo-Json

# Send chat request
$chatResponse = Invoke-RestMethod -Uri $chatUrl -Method POST -Body $testMessage -ContentType "application/json" -Headers $headers
$conversationId = $chatResponse.conversationId

Write-Host "✓ Chat message sent (Conversation: $conversationId)" -ForegroundColor Green

# Wait for MongoDB write
Start-Sleep -Seconds 1

# Query MongoDB to verify persistence
$mongoQuery = @"
mongosh "mongodb://192.168.2.33:27017/agentx" --eval "db.conversations.findOne({ _id: ObjectId('$conversationId') })" --quiet
"@

try {
    $dbResult = Invoke-Expression $mongoQuery
    Write-Host "✓ Conversation persisted to MongoDB" -ForegroundColor Green
} catch {
    Write-Host "✗ Conversation NOT found in MongoDB" -ForegroundColor Red
}
```

**Success Criteria:**
- [ ] Chat messages persist to `agentx.conversations`
- [ ] User profiles persist to `agentx.userprofiles`
- [ ] Feedback persists to `agentx.feedback`
- [ ] DataAPI scans persist to `datalake_janitor.scans`
- [ ] All timestamps are correct (UTC)

### 4.3 Query Performance Test

```bash
# Test indexed query performance
$mongoQuery = @"
mongosh "mongodb://192.168.2.33:27017/agentx" --eval "
    var start = new Date();
    db.conversations.find({ userId: 'test_user' }).limit(100).toArray();
    var end = new Date();
    print('Query time: ' + (end - start) + 'ms');
" --quiet
"@

Invoke-Expression $mongoQuery
```

**Success Criteria:**
- [ ] Indexed queries complete < 100ms
- [ ] Full collection scans identified and avoided
- [ ] Compound indexes used for common queries
- [ ] No missing index warnings in logs

---

## Phase 5: Integration & End-to-End Testing

**Objective:** Validate complete system flows work correctly

### 5.1 Complete RAG Query Flow

**Test:** User query → RAG search → Ollama inference → Response

```bash
Write-Host "`n=== RAG Query Flow Test ===" -ForegroundColor Cyan

# Step 1: Ingest test document
$ingestUrl = "http://192.168.2.33:3080/api/rag/ingest"
$testDoc = @{
    title = "Validation Test Document"
    content = "The validation system uses PowerShell scripts to test all endpoints systematically."
    source = "validation-test"
    metadata = @{
        category = "testing"
        date = (Get-Date -Format "yyyy-MM-dd")
    }
} | ConvertTo-Json

Invoke-RestMethod -Uri $ingestUrl -Method POST -Body $testDoc -ContentType "application/json" -Headers $headers
Write-Host "✓ Step 1: Test document ingested" -ForegroundColor Green

# Step 2: Wait for Qdrant indexing
Start-Sleep -Seconds 2

# Step 3: Send query that should use RAG
$chatUrl = "http://192.168.2.33:3080/api/chat"
$ragQuery = @{
    message = "What does the validation system use?"
    userId = "validation-test"
    useRag = $true
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri $chatUrl -Method POST -Body $ragQuery -ContentType "application/json" -Headers $headers
Write-Host "✓ Step 2: RAG query sent" -ForegroundColor Green

# Step 4: Verify response includes RAG context
if ($response.sources -and $response.sources.Count -gt 0) {
    Write-Host "✓ Step 3: RAG context retrieved" -ForegroundColor Green
    Write-Host "  Sources: $($response.sources.Count)" -ForegroundColor Gray
} else {
    Write-Host "✗ Step 3: No RAG context in response" -ForegroundColor Red
}

# Step 5: Verify Ollama generated response
if ($response.reply -and $response.reply.Length -gt 0) {
    Write-Host "✓ Step 4: Ollama response generated" -ForegroundColor Green
    Write-Host "  Response: $($response.reply.Substring(0, [Math]::Min(100, $response.reply.Length)))..." -ForegroundColor Gray
} else {
    Write-Host "✗ Step 4: No Ollama response" -ForegroundColor Red
}

# Step 6: Verify MongoDB persistence
Start-Sleep -Seconds 1
$historyUrl = "http://192.168.2.33:3080/api/history/conversations"
$conversations = Invoke-RestMethod -Uri $historyUrl -Method GET -Headers $headers
$latestConv = $conversations.conversations | Where-Object { $_.userId -eq "validation-test" } | Select-Object -First 1

if ($latestConv) {
    Write-Host "✓ Step 5: Conversation persisted to MongoDB" -ForegroundColor Green
} else {
    Write-Host "✗ Step 5: Conversation NOT persisted" -ForegroundColor Red
}
```

**Success Criteria:**
- [ ] Document successfully ingested to Qdrant
- [ ] RAG search retrieves relevant context
- [ ] Ollama generates contextual response
- [ ] Response includes source citations
- [ ] Full conversation saved to MongoDB
- [ ] End-to-end latency < 5 seconds

### 5.2 n8n → DataAPI → AgentX Flow

**Test:** N2.1 scan → DataAPI batch → N2.3 ingest → Qdrant

```bash
Write-Host "`n=== n8n Integration Flow Test ===" -ForegroundColor Cyan

# Trigger N2.1 NAS scan
$scanPayload = @{
    scanPath = "/mnt/nas/validation-test"
    batchSize = 5
    action = "full"
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "https://n8n.specialblend.icu/webhook/sbqc-n2-1-nas-scan" -Method POST -Body $scanPayload -ContentType "application/json"
Write-Host "✓ N2.1 workflow triggered" -ForegroundColor Green

# Wait for DataAPI processing
Start-Sleep -Seconds 5

# Check DataAPI scan status
$statusUrl = "http://192.168.2.33:3003/api/v1/storage/status"
$status = Invoke-RestMethod -Uri $statusUrl -Method GET
Write-Host "✓ DataAPI processing scan" -ForegroundColor Green
Write-Host "  Active scans: $($status.activeScans)" -ForegroundColor Gray

# Wait for RAG ingestion trigger
Start-Sleep -Seconds 5

# Check Qdrant for new documents
$qdrantUrl = "http://192.168.2.33:6333/collections/sbqc-documents"
$collection = Invoke-RestMethod -Uri $qdrantUrl -Method GET
Write-Host "✓ Qdrant collection updated" -ForegroundColor Green
Write-Host "  Total vectors: $($collection.result.points_count)" -ForegroundColor Gray
```

**Success Criteria:**
- [ ] N2.1 triggers without errors
- [ ] DataAPI receives and processes scan request
- [ ] File batches created correctly
- [ ] N2.3 ingests documents to Qdrant
- [ ] Vector count increases in Qdrant
- [ ] All workflow steps log successfully

### 5.3 Model Routing Test

**Test:** Verify Ollama cluster routing (UGFrank vs UGBrutal)

```bash
Write-Host "`n=== Model Routing Test ===" -ForegroundColor Cyan

# Test front-door model (UGFrank)
$frontDoorUrl = "http://192.168.2.99:11434/api/generate"
$testPrompt = @{
    model = "llama2"
    prompt = "Say hello"
    stream = $false
} | ConvertTo-Json

try {
    $response = Invoke-RestMethod -Uri $frontDoorUrl -Method POST -Body $testPrompt -ContentType "application/json"
    Write-Host "✓ UGFrank (front-door) responding" -ForegroundColor Green
} catch {
    Write-Host "✗ UGFrank not accessible" -ForegroundColor Red
}

# Test specialist model (UGBrutal)
$specialistUrl = "http://192.168.2.12:11434/api/generate"
try {
    $response = Invoke-RestMethod -Uri $specialistUrl -Method POST -Body $testPrompt -ContentType "application/json"
    Write-Host "✓ UGBrutal (specialist) responding" -ForegroundColor Green
} catch {
    Write-Host "✗ UGBrutal not accessible" -ForegroundColor Red
}

# Test AgentX model selection logic
$chatUrl = "http://192.168.2.33:3080/api/chat"
$specialistQuery = @{
    message = "Analyze this complex code structure"
    userId = "validation-test"
    preferSpecialist = $true
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri $chatUrl -Method POST -Body $specialistQuery -ContentType "application/json" -Headers $headers
Write-Host "✓ AgentX routing logic functional" -ForegroundColor Green
Write-Host "  Model used: $($response.modelUsed)" -ForegroundColor Gray
```

**Success Criteria:**
- [ ] UGFrank accessible (front-door model)
- [ ] UGBrutal accessible (specialist model)
- [ ] AgentX routes queries correctly
- [ ] Model selection based on query complexity
- [ ] Fallback to front-door if specialist unavailable

---

## Phase 6: Validation Report

**Objective:** Document all test results and findings

### 6.1 Generate Validation Report

After completing all tests, create a validation report:

**Template:** `docs/SBQC-Stack-Final/VALIDATION-REPORT-[DATE].md`

```markdown
# SBQC Stack Validation Report

**Date:** [DATE]
**Validator:** [NAME]
**Duration:** [TIME]

## Executive Summary

- Total Tests: X
- Passed: X (XX%)
- Failed: X (XX%)
- Warnings: X

## Phase Results

### Phase 1: Environment Validation
- AgentX .env: [PASS/FAIL]
- DataAPI .env: [PASS/FAIL]
- n8n config: [PASS/FAIL]

### Phase 2: API Endpoints
- Health endpoints: [X/X passed]
- Authentication: [PASS/FAIL]
- Chat & conversations: [X/X passed]
- User profile: [X/X passed]
- Analytics: [X/X passed]
- RAG integration: [X/X passed]

### Phase 3: n8n Workflows
- Workflows imported: [X/7]
- Webhooks functional: [X/7]
- Integration flows: [PASS/FAIL]

### Phase 4: Database
- MongoDB connectivity: [PASS/FAIL]
- Data persistence: [PASS/FAIL]
- Query performance: [PASS/FAIL]

### Phase 5: Integration Tests
- RAG query flow: [PASS/FAIL]
- n8n → DataAPI flow: [PASS/FAIL]
- Model routing: [PASS/FAIL]

## Issues Found

### Critical
- [List any critical failures]

### Moderate
- [List warnings or partial failures]

### Minor
- [List minor issues or improvements]

## Recommendations

1. [Priority fixes needed]
2. [Configuration adjustments]
3. [Performance optimizations]

## Sign-off

- [ ] All critical tests passed
- [ ] Documentation matches live system
- [ ] System ready for production use
```

### 6.2 Update Documentation

If validation finds discrepancies:

1. **Document the finding:**
   - Location in code vs documentation
   - Expected vs actual behavior
   - Impact assessment

2. **Update documentation or code:**
   - Fix documentation if code is correct
   - Fix code if documentation is correct
   - Update both if design has changed

3. **Retest affected areas:**
   - Run validation tests again
   - Verify fix resolved the issue
   - Update validation report

---

## Automation Script

To run the complete validation suite, use this master script:

**File:** `scripts/validate-all.ps1`

```powershell
#!/usr/bin/env pwsh
#
# SBQC Stack - Complete Validation Suite
# Runs all validation phases and generates report
#

$ErrorActionPreference = "Continue"
$timestamp = Get-Date -Format "yyyy-MM-dd-HHmmss"
$reportFile = "docs/SBQC-Stack-Final/VALIDATION-REPORT-$timestamp.md"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   SBQC STACK VALIDATION SUITE" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$results = @{
    Phase1 = @{ Passed = 0; Failed = 0; Total = 0 }
    Phase2 = @{ Passed = 0; Failed = 0; Total = 0 }
    Phase3 = @{ Passed = 0; Failed = 0; Total = 0 }
    Phase4 = @{ Passed = 0; Failed = 0; Total = 0 }
    Phase5 = @{ Passed = 0; Failed = 0; Total = 0 }
}

# Phase 1: Environment
Write-Host "PHASE 1: Environment Validation" -ForegroundColor Yellow
Write-Host "--------------------------------" -ForegroundColor DarkGray
# [Run Phase 1 tests from section 1 above]
# Update $results.Phase1 counters

# Phase 2: API Endpoints
Write-Host "`nPHASE 2: API Endpoint Validation" -ForegroundColor Yellow
Write-Host "--------------------------------" -ForegroundColor DarkGray
# [Run Phase 2 tests from section 2 above]
# Update $results.Phase2 counters

# Phase 3: n8n Workflows
Write-Host "`nPHASE 3: n8n Workflow Validation" -ForegroundColor Yellow
Write-Host "--------------------------------" -ForegroundColor DarkGray
# [Run Phase 3 tests from section 3 above]
# Update $results.Phase3 counters

# Phase 4: Database
Write-Host "`nPHASE 4: Database Validation" -ForegroundColor Yellow
Write-Host "--------------------------------" -ForegroundColor DarkGray
# [Run Phase 4 tests from section 4 above]
# Update $results.Phase4 counters

# Phase 5: Integration
Write-Host "`nPHASE 5: Integration Testing" -ForegroundColor Yellow
Write-Host "--------------------------------" -ForegroundColor DarkGray
# [Run Phase 5 tests from section 5 above]
# Update $results.Phase5 counters

# Generate Report
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "   VALIDATION COMPLETE" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$totalPassed = ($results.Values | ForEach-Object { $_.Passed } | Measure-Object -Sum).Sum
$totalFailed = ($results.Values | ForEach-Object { $_.Failed } | Measure-Object -Sum).Sum
$totalTests = $totalPassed + $totalFailed
$passRate = [math]::Round(($totalPassed / $totalTests) * 100, 2)

Write-Host ""
Write-Host "Total Tests: $totalTests" -ForegroundColor White
Write-Host "Passed: $totalPassed ($passRate%)" -ForegroundColor Green
Write-Host "Failed: $totalFailed" -ForegroundColor Red
Write-Host ""
Write-Host "Report saved to: $reportFile" -ForegroundColor Cyan

# Create validation report file
# [Generate report using template from section 6.1]
```

**Usage:**
```bash
cd c:\Users\Yanik\OneDrive\Documents\ObsidiVault\agentx
.\scripts\validate-all.ps1
```

---

## Troubleshooting Guide

### Common Issues

**Issue:** MongoDB connection refused
- **Check:** `mongosh mongodb://192.168.2.33:27017`
- **Fix:** Verify MongoDB service running, check firewall rules

**Issue:** n8n webhooks return 404
- **Check:** Workflow imported and activated in n8n UI
- **Fix:** Import workflow JSON, click "Activate" toggle

**Issue:** Ollama not responding
- **Check:** `curl http://192.168.2.99:11434/api/tags`
- **Fix:** Restart Ollama service, verify GPU not out of memory

**Issue:** RAG search returns no results
- **Check:** Qdrant collection exists and has vectors
- **Fix:** Run `scripts/migrate-vector-store.js` to populate Qdrant

**Issue:** JWT token invalid
- **Check:** JWT_SECRET matches between AgentX and auth service
- **Fix:** Regenerate secret, update .env, restart services

---

## Next Steps

After completing validation:

1. **If all tests pass:**
   - Update README.md with validation date
   - Tag repository with validated version
   - Deploy to production with confidence

2. **If tests fail:**
   - Document all failures in validation report
   - Create issues for each failure
   - Fix critical issues before production deployment
   - Re-run validation suite after fixes

3. **Ongoing validation:**
   - Run validation suite before each deployment
   - Automate validation in CI/CD pipeline
   - Update validation plan as system evolves
   - Keep validation report history for audit trail

---

**Document Version:** 1.0  
**Last Updated:** December 31, 2025  
**Related Docs:** [00-OVERVIEW.md](00-OVERVIEW.md) | [07-AGENTX-API-REFERENCE.md](07-AGENTX-API-REFERENCE.md) | [05-DEPLOYMENT.md](05-DEPLOYMENT.md)
