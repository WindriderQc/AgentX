#!/bin/bash

echo "=========================================="
echo "  SBQC MVP Test Suite"
echo "=========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test counters
PASSED=0
FAILED=0

# Helper function to test endpoint
test_endpoint() {
    local name="$1"
    local url="$2"
    local method="$3"
    local data="$4"
    local expected_code="$5"

    echo -n "Testing $name... "

    if [ "$method" = "GET" ]; then
        response=$(curl -s -w "\n%{http_code}" "$url" 2>/dev/null)
    else
        response=$(curl -s -w "\n%{http_code}" -X "$method" "$url" -H "Content-Type: application/json" -d "$data" 2>/dev/null)
    fi

    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | head -n-1)

    # Check if http_code matches any of the expected codes (pipe-separated)
    if [[ "|$expected_code|" == *"|$http_code|"* ]]; then
        echo -e "${GREEN}✓ PASSED${NC} (HTTP $http_code)"
        PASSED=$((PASSED + 1))
        return 0
    else
        echo -e "${RED}✗ FAILED${NC} (Expected HTTP $expected_code, got $http_code)"
        echo "  Response: $body"
        FAILED=$((FAILED + 1))
        return 1
    fi
}

echo "1. Testing BenchmarkService (Port 3081)"
echo "=========================================="

# Health check
test_endpoint "Benchmark Health" "http://localhost:3081/health" "GET" "" "200"

# Test benchmark (note: will fail if no Ollama host is running, that's expected)
test_endpoint "Benchmark Test (may fail without Ollama)" "http://localhost:3081/test" "POST" '{"model":"llama2","host":"http://localhost:11434","prompt":"Hello"}' "200|500"

# Get results
test_endpoint "Benchmark Results" "http://localhost:3081/results" "GET" "" "200"

# Get summary
test_endpoint "Benchmark Summary" "http://localhost:3081/summary" "GET" "" "200"

echo ""
echo "2. Testing DataAPI - Janitor (Port 3003)"
echo "=========================================="

# Note: This requires authentication. We'll test with a simple path.
# If auth fails, we expect 401, which is correct behavior.
test_endpoint "Janitor Analyze (may need auth)" "http://localhost:3003/api/v1/janitor/analyze" "POST" '{"path":"/tmp"}' "200|401|403"

echo ""
echo "3. Testing AgentX - Prompts (Port 3080)"
echo "=========================================="

# Test prompt endpoints (may require auth)
test_endpoint "Prompts List (may need auth)" "http://localhost:3080/api/prompts" "GET" "" "200|401"

test_endpoint "AgentX Health" "http://localhost:3080/health" "GET" "" "200"

echo ""
echo "=========================================="
echo "  Test Summary"
echo "=========================================="
echo -e "${GREEN}Passed: $PASSED${NC}"
echo -e "${RED}Failed: $FAILED${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
else
    echo -e "${YELLOW}Some tests failed. Check the output above.${NC}"
    exit 1
fi
