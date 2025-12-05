#!/bin/bash
# AgentX Load Testing Suite
# Runs comprehensive performance benchmarks

set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║          AgentX Load Testing Suite                    ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check if server is running
echo -e "${YELLOW}🔍 Checking server status...${NC}"
if ! curl -s http://localhost:3080/health > /dev/null; then
    echo -e "${RED}❌ AgentX server is not running on port 3080${NC}"
    echo "   Please start the server first: npm start"
    exit 1
fi
echo -e "${GREEN}✅ Server is running${NC}"
echo ""

# Create reports directory
mkdir -p tests/load/reports
REPORT_DIR="tests/load/reports"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Test 1: Basic Load Test
echo -e "${YELLOW}📊 Test 1: Basic Load Test (180s)${NC}"
echo "   Testing mixed scenarios with gradual ramp-up..."
echo ""
npx artillery run tests/load/basic-load.yml \
    --output "${REPORT_DIR}/basic-load-${TIMESTAMP}.json" \
    2>&1 | tee "${REPORT_DIR}/basic-load-${TIMESTAMP}.log"

echo ""
echo -e "${GREEN}✅ Basic load test complete${NC}"
echo ""

# Generate HTML report for basic test
echo -e "${YELLOW}📈 Generating HTML report...${NC}"
npx artillery report \
    "${REPORT_DIR}/basic-load-${TIMESTAMP}.json" \
    --output "${REPORT_DIR}/basic-load-${TIMESTAMP}.html"
echo -e "${GREEN}✅ Report generated: ${REPORT_DIR}/basic-load-${TIMESTAMP}.html${NC}"
echo ""

# Wait between tests
echo -e "${YELLOW}⏳ Cooling down (10s)...${NC}"
sleep 10
echo ""

# Test 2: Stress Test
echo -e "${YELLOW}📊 Test 2: Stress Test (90s)${NC}"
echo "   Testing high load scenarios (50-100 req/sec)..."
echo ""
npx artillery run tests/load/stress-test.yml \
    --output "${REPORT_DIR}/stress-test-${TIMESTAMP}.json" \
    2>&1 | tee "${REPORT_DIR}/stress-test-${TIMESTAMP}.log"

echo ""
echo -e "${GREEN}✅ Stress test complete${NC}"
echo ""

# Generate HTML report for stress test
echo -e "${YELLOW}📈 Generating HTML report...${NC}"
npx artillery report \
    "${REPORT_DIR}/stress-test-${TIMESTAMP}.json" \
    --output "${REPORT_DIR}/stress-test-${TIMESTAMP}.html"
echo -e "${GREEN}✅ Report generated: ${REPORT_DIR}/stress-test-${TIMESTAMP}.html${NC}"
echo ""

# Summary
echo -e "${GREEN}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║          Load Testing Complete!                        ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${YELLOW}📁 Reports saved to:${NC}"
echo "   ${REPORT_DIR}/basic-load-${TIMESTAMP}.html"
echo "   ${REPORT_DIR}/stress-test-${TIMESTAMP}.html"
echo ""
echo -e "${YELLOW}📊 Next steps:${NC}"
echo "   1. Open HTML reports in browser for detailed metrics"
echo "   2. Check metrics dashboard: http://localhost:3080/metrics.html"
echo "   3. Review server logs for any errors"
echo "   4. Compare results with baseline performance"
echo ""
