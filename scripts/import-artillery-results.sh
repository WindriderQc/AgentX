#!/bin/bash
# Import Artillery Results Script
#
# This script runs an Artillery load test, saves JSON output, and imports it to AgentX.
# Usage: ./scripts/import-artillery-results.sh [basic-load|stress-test|smoke-test]
#
# Features:
# - Runs Artillery load test from /tests/load/*.yml configs
# - Saves JSON results to /data/load-tests/ with timestamp
# - Automatically imports to AgentX via API
# - Validates test completion and import success
#
# Example:
#   ./scripts/import-artillery-results.sh basic-load
#   ./scripts/import-artillery-results.sh stress-test

set -e  # Exit on error

# Configuration
TEST_NAME=${1:-basic-load}
OUTPUT_DIR="./data/load-tests"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
OUTPUT_FILE="${OUTPUT_DIR}/${TEST_NAME}-${TIMESTAMP}.json"
AGENTX_URL=${AGENTX_URL:-http://localhost:3080}

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}==========================================${NC}"
echo -e "${YELLOW}Artillery Load Test & Import${NC}"
echo -e "${YELLOW}==========================================${NC}"
echo ""

# Validate test name
TEST_FILE="./tests/load/${TEST_NAME}.yml"
if [ ! -f "$TEST_FILE" ]; then
  echo -e "${RED}Error: Test configuration not found: $TEST_FILE${NC}"
  echo ""
  echo "Available tests:"
  ls -1 ./tests/load/*.yml 2>/dev/null | xargs -n1 basename | sed 's/\.yml$//' || echo "  No tests found in ./tests/load/"
  exit 1
fi

# Ensure output directory exists
mkdir -p "$OUTPUT_DIR"

# Run Artillery test
echo -e "${YELLOW}Running Artillery test: ${TEST_NAME}${NC}"
echo "  Config: $TEST_FILE"
echo "  Output: $OUTPUT_FILE"
echo ""

# Check if artillery is installed
if ! command -v artillery &> /dev/null; then
  echo -e "${RED}Error: Artillery is not installed${NC}"
  echo "Install with: npm install -g artillery"
  exit 1
fi

# Run test and capture exit code
if artillery run "$TEST_FILE" --output "$OUTPUT_FILE"; then
  echo ""
  echo -e "${GREEN}✓ Artillery test completed successfully${NC}"
else
  echo ""
  echo -e "${RED}✗ Artillery test failed!${NC}"
  exit 1
fi

# Check if output file was created
if [ ! -f "$OUTPUT_FILE" ]; then
  echo -e "${RED}Error: Output file was not created: $OUTPUT_FILE${NC}"
  exit 1
fi

# Display file size
FILE_SIZE=$(du -h "$OUTPUT_FILE" | cut -f1)
echo "  Results saved: $OUTPUT_FILE ($FILE_SIZE)"
echo ""

# Import to AgentX API
echo -e "${YELLOW}Importing results to AgentX Performance Dashboard...${NC}"
echo "  API URL: ${AGENTX_URL}/api/performance/load-tests"
echo ""

# Build JSON payload
PAYLOAD=$(cat <<EOF
{
  "name": "${TEST_NAME}-${TIMESTAMP}",
  "scenario": "${TEST_NAME}",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "raw_report": $(cat "$OUTPUT_FILE")
}
EOF
)

# Send to API
RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X POST "${AGENTX_URL}/api/performance/load-tests" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

# Parse response
HTTP_BODY=$(echo "$RESPONSE" | sed -e 's/HTTP_STATUS\:.*//g')
HTTP_STATUS=$(echo "$RESPONSE" | tr -d '\n' | sed -e 's/.*HTTP_STATUS://')

# Check if import succeeded
if [ "$HTTP_STATUS" -eq 201 ]; then
  echo -e "${GREEN}✓ Import successful!${NC}"
  echo ""
  echo "Response:"
  echo "$HTTP_BODY" | jq '.' 2>/dev/null || echo "$HTTP_BODY"
  echo ""
  echo -e "${GREEN}==========================================${NC}"
  echo -e "${GREEN}Load test complete and imported!${NC}"
  echo -e "${GREEN}==========================================${NC}"
  exit 0
else
  echo -e "${RED}✗ Import failed (HTTP $HTTP_STATUS)${NC}"
  echo ""
  echo "Response:"
  echo "$HTTP_BODY" | jq '.' 2>/dev/null || echo "$HTTP_BODY"
  exit 1
fi
