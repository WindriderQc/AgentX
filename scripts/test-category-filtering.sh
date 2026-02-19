#!/bin/bash
# Integration Test: Category Filtering System
# Tests model registry and enhanced benchmark dashboard endpoints

set -e

BASE_URL="${1:-http://localhost:3080}"
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "========================================="
echo "Category Filtering Integration Test"
echo "========================================="
echo "Testing against: $BASE_URL"
echo ""

# Test counter
TESTS_PASSED=0
TESTS_FAILED=0

# Helper functions
test_endpoint() {
    local name="$1"
    local url="$2"
    local expected_status="${3:-200}"

    echo -n "Testing: $name ... "

    response=$(curl -s -w "\n%{http_code}" "$url")
    status_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')

    if [ "$status_code" -eq "$expected_status" ]; then
        echo -e "${GREEN}✓ PASS${NC} (HTTP $status_code)"
        ((TESTS_PASSED++))
        return 0
    else
        echo -e "${RED}✗ FAIL${NC} (HTTP $status_code, expected $expected_status)"
        echo "Response: $body" | head -3
        ((TESTS_FAILED++))
        return 1
    fi
}

test_json_field() {
    local name="$1"
    local url="$2"
    local jq_query="$3"
    local expected="$4"

    echo -n "Testing: $name ... "

    response=$(curl -s "$url")
    result=$(echo "$response" | jq -r "$jq_query" 2>/dev/null || echo "JQ_ERROR")

    if [ "$result" = "$expected" ]; then
        echo -e "${GREEN}✓ PASS${NC} (got: $result)"
        ((TESTS_PASSED++))
        return 0
    else
        echo -e "${RED}✗ FAIL${NC} (got: $result, expected: $expected)"
        ((TESTS_FAILED++))
        return 1
    fi
}

echo "=== Model Registry Endpoints ==="
echo ""

# Test 1: List all models
test_endpoint "GET /api/models/registry (list all)" \
    "$BASE_URL/api/models/registry"

# Test 2: Get models by category
test_endpoint "GET /api/models/registry?category=coding" \
    "$BASE_URL/api/models/registry?category=coding"

# Test 3: Get category stats
test_endpoint "GET /api/models/registry/stats" \
    "$BASE_URL/api/models/registry/stats"

# Test 4: Get grouped models
test_endpoint "GET /api/models/registry/grouped" \
    "$BASE_URL/api/models/registry/grouped"

# Test 5: Get models in coding category
test_endpoint "GET /api/models/registry/category/coding" \
    "$BASE_URL/api/models/registry/category/coding"

# Test 6: Get models with production tag
test_endpoint "GET /api/models/registry/tag/production" \
    "$BASE_URL/api/models/registry/tag/production"

# Test 7: Get specific model
test_endpoint "GET /api/models/registry/qwen2.5-7b-instruct-q4_0" \
    "$BASE_URL/api/models/registry/qwen2.5-7b-instruct-q4_0"

echo ""
echo "=== Enhanced Benchmark Dashboard ==="
echo ""

# Test 8: Dashboard without filters
test_endpoint "GET /api/benchmark/dashboard (no filters)" \
    "$BASE_URL/api/benchmark/dashboard"

# Test 9: Dashboard with model category filter
test_endpoint "GET /api/benchmark/dashboard?modelCategory=coding" \
    "$BASE_URL/api/benchmark/dashboard?modelCategory=coding"

# Test 10: Dashboard with prompt category filter
test_endpoint "GET /api/benchmark/dashboard?promptCategory=reasoning" \
    "$BASE_URL/api/benchmark/dashboard?promptCategory=reasoning"

# Test 11: Dashboard with combined filters
test_endpoint "GET /api/benchmark/dashboard?modelCategory=coding&promptCategory=coding" \
    "$BASE_URL/api/benchmark/dashboard?modelCategory=coding&promptCategory=coding"

# Test 12: Dashboard with tag filter
test_endpoint "GET /api/benchmark/dashboard?tag=production" \
    "$BASE_URL/api/benchmark/dashboard?tag=production"

echo ""
echo "=== Data Validation Tests ==="
echo ""

# Test 13: Verify model count
test_json_field "Model count >= 11" \
    "$BASE_URL/api/models/registry" \
    '.data.count' \
    "11"

# Test 14: Verify status field
test_json_field "Response status = success" \
    "$BASE_URL/api/models/registry" \
    '.status' \
    "success"

# Test 15: Verify coding category has models
echo -n "Testing: Coding category has models ... "
response=$(curl -s "$BASE_URL/api/models/registry/category/coding")
count=$(echo "$response" | jq -r '.data.count' 2>/dev/null || echo "0")
if [ "$count" -gt "0" ]; then
    echo -e "${GREEN}✓ PASS${NC} ($count models)"
    ((TESTS_PASSED++))
else
    echo -e "${RED}✗ FAIL${NC} (0 models found)"
    ((TESTS_FAILED++))
fi

# Test 16: Verify production tag has models
echo -n "Testing: Production tag has models ... "
response=$(curl -s "$BASE_URL/api/models/registry/tag/production")
count=$(echo "$response" | jq -r '.data.count' 2>/dev/null || echo "0")
if [ "$count" -gt "0" ]; then
    echo -e "${GREEN}✓ PASS${NC} ($count models)"
    ((TESTS_PASSED++))
else
    echo -e "${RED}✗ FAIL${NC} (0 models found)"
    ((TESTS_FAILED++))
fi

echo ""
echo "=== Frontend UI Elements (Manual Check) ==="
echo ""
echo "${YELLOW}Please verify manually:${NC}"
echo "  1. Open $BASE_URL/benchmark.html"
echo "  2. Check for 'Model Category' dropdown"
echo "  3. Check for 'Task Type' dropdown"
echo "  4. Check for 'Clear Filters' button"
echo "  5. Check for 'Profile' selector (Interactive/Reasoning/Coding)"
echo "  6. Select filters and verify leaderboard updates"
echo "  7. Click 'Clear Filters' and verify reset"
echo ""

echo "========================================="
echo "Test Results"
echo "========================================="
echo -e "${GREEN}PASSED: $TESTS_PASSED${NC}"
echo -e "${RED}FAILED: $TESTS_FAILED${NC}"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "${GREEN}✓ ALL TESTS PASSED!${NC}"
    exit 0
else
    echo -e "${RED}✗ SOME TESTS FAILED${NC}"
    echo ""
    echo "Common issues:"
    echo "  - Server not running: npm start or pm2 restart agentx"
    echo "  - Routes not mounted: Check src/app.js for model-registry routes"
    echo "  - Model registry empty: Registry auto-syncs on startup. Restart server or POST /api/models/registry/sync-hosts"
    exit 1
fi
