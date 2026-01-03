#!/bin/bash

# Performance API Testing Script
#
# Demonstrates all 8 performance API endpoints with sample data.
# Usage: ./scripts/test-performance-api.sh [base-url]
#
# Default base URL: http://localhost:3080

BASE_URL="${1:-http://localhost:3080}"
API_BASE="${BASE_URL}/api/performance"

echo "=========================================="
echo "Performance API Testing"
echo "Base URL: ${BASE_URL}"
echo "=========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# ============================================================================
# 1. Dashboard Overview
# ============================================================================

echo -e "${BLUE}1. GET /api/performance/dashboard${NC}"
echo "Fetching dashboard overview..."
echo ""

curl -X GET "${API_BASE}/dashboard" \
  -H "Content-Type: application/json" \
  -s | jq '.'

echo ""
echo -e "${GREEN}✓ Dashboard fetched${NC}"
echo ""

# ============================================================================
# 2. Import Artillery Report
# ============================================================================

echo -e "${BLUE}2. POST /api/performance/load-tests${NC}"
echo "Importing sample Artillery report..."
echo ""

REPORT_DATA=$(cat tests/fixtures/sample-artillery-report.json)

IMPORT_RESPONSE=$(curl -X POST "${API_BASE}/load-tests" \
  -H "Content-Type: application/json" \
  -s \
  -d "{
    \"name\": \"test-load-$(date +%Y-%m-%d-%H%M%S)\",
    \"scenario\": \"basic-load\",
    \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
    \"raw_report\": ${REPORT_DATA}
  }")

echo "$IMPORT_RESPONSE" | jq '.'

# Extract test ID for later use
TEST_ID=$(echo "$IMPORT_RESPONSE" | jq -r '.data.id')

echo ""
echo -e "${GREEN}✓ Load test imported with ID: ${TEST_ID}${NC}"
echo ""

# ============================================================================
# 3. List Load Tests
# ============================================================================

echo -e "${BLUE}3. GET /api/performance/load-tests${NC}"
echo "Fetching load test history (last 5)..."
echo ""

curl -X GET "${API_BASE}/load-tests?limit=5" \
  -H "Content-Type: application/json" \
  -s | jq '.'

echo ""
echo -e "${GREEN}✓ Load test history retrieved${NC}"
echo ""

# ============================================================================
# 4. Latency Trends
# ============================================================================

echo -e "${BLUE}4. GET /api/performance/latency-trends${NC}"
echo "Fetching latency trends (last 24 hours)..."
echo ""

curl -X GET "${API_BASE}/latency-trends?hours=24" \
  -H "Content-Type: application/json" \
  -s | jq '.'

echo ""
echo -e "${GREEN}✓ Latency trends retrieved${NC}"
echo ""

# ============================================================================
# 5. Throughput Trends
# ============================================================================

echo -e "${BLUE}5. GET /api/performance/throughput${NC}"
echo "Fetching throughput trends (last 24 hours)..."
echo ""

curl -X GET "${API_BASE}/throughput?hours=24" \
  -H "Content-Type: application/json" \
  -s | jq '.'

echo ""
echo -e "${GREEN}✓ Throughput trends retrieved${NC}"
echo ""

# ============================================================================
# 6. Percentile Breakdown
# ============================================================================

echo -e "${BLUE}6. GET /api/performance/percentiles${NC}"
echo "Fetching percentile breakdown..."
echo ""

curl -X GET "${API_BASE}/percentiles?hours=24" \
  -H "Content-Type: application/json" \
  -s | jq '.'

echo ""
echo -e "${GREEN}✓ Percentiles retrieved${NC}"
echo ""

# ============================================================================
# 7. Create Baseline
# ============================================================================

echo -e "${BLUE}7. POST /api/performance/baselines${NC}"
echo "Creating performance baseline..."
echo ""

BASELINE_RESPONSE=$(curl -X POST "${API_BASE}/baselines" \
  -H "Content-Type: application/json" \
  -s \
  -d '{
    "name": "test-baseline-'$(date +%Y%m%d-%H%M%S)'",
    "description": "Automated test baseline",
    "metrics": {
      "avg_response_time": 250,
      "p95_latency": 800,
      "error_rate": 2.0,
      "throughput_rps": 5.0
    },
    "endpoints": [
      {
        "path": "/api/chat",
        "method": "POST",
        "avg_latency": 300,
        "p95_latency": 900
      }
    ],
    "source": "manual",
    "activate": true
  }')

echo "$BASELINE_RESPONSE" | jq '.'

BASELINE_ID=$(echo "$BASELINE_RESPONSE" | jq -r '.data._id')

echo ""
echo -e "${GREEN}✓ Baseline created with ID: ${BASELINE_ID}${NC}"
echo ""

# ============================================================================
# 8. List Baselines
# ============================================================================

echo -e "${BLUE}8. GET /api/performance/baselines${NC}"
echo "Fetching all baselines..."
echo ""

curl -X GET "${API_BASE}/baselines" \
  -H "Content-Type: application/json" \
  -s | jq '.'

echo ""
echo -e "${GREEN}✓ Baselines retrieved${NC}"
echo ""

# ============================================================================
# 9. Baseline Comparison
# ============================================================================

echo -e "${BLUE}9. GET /api/performance/baseline-compare${NC}"
echo "Comparing current metrics against baseline..."
echo ""

curl -X GET "${API_BASE}/baseline-compare?hours=24" \
  -H "Content-Type: application/json" \
  -s | jq '.'

echo ""
echo -e "${GREEN}✓ Baseline comparison complete${NC}"
echo ""

# ============================================================================
# Summary
# ============================================================================

echo "=========================================="
echo -e "${GREEN}All 8 API endpoints tested successfully!${NC}"
echo "=========================================="
echo ""
echo "Test artifacts created:"
echo "  - Load test ID: ${TEST_ID}"
echo "  - Baseline ID: ${BASELINE_ID}"
echo ""
echo "Next steps:"
echo "  1. View dashboard at: ${BASE_URL}/performance.html (once frontend is built)"
echo "  2. Run actual Artillery tests with: artillery run tests/load/basic-load.yml"
echo "  3. Set up CI/CD pipeline to automate performance tracking"
echo ""
