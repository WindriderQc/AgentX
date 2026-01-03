#!/bin/bash
# Create Performance Baseline Script
#
# This script captures current system metrics and creates a performance baseline.
# Usage: ./scripts/create-performance-baseline.sh <baseline-name> [description]
#
# Features:
# - Captures current metrics from dashboard API
# - Creates baseline via API with extracted metrics
# - Automatically activates the new baseline
# - Validates baseline creation success
#
# Example:
#   ./scripts/create-performance-baseline.sh "v1.0-baseline" "Production baseline"
#   ./scripts/create-performance-baseline.sh "2026-01-baseline"

set -e  # Exit on error

# Configuration
NAME=$1
DESCRIPTION=${2:-"Baseline created on $(date +%Y-%m-%d)"}
AGENTX_URL=${AGENTX_URL:-http://localhost:3080}

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${YELLOW}==========================================${NC}"
echo -e "${YELLOW}Performance Baseline Creation${NC}"
echo -e "${YELLOW}==========================================${NC}"
echo ""

# Validate arguments
if [ -z "$NAME" ]; then
  echo -e "${RED}Error: Baseline name is required${NC}"
  echo ""
  echo "Usage: $0 <baseline-name> [description]"
  echo ""
  echo "Example:"
  echo "  $0 \"v1.0-baseline\" \"Production baseline\""
  exit 1
fi

# Check if jq is installed
if ! command -v jq &> /dev/null; then
  echo -e "${RED}Error: jq is not installed${NC}"
  echo "Install with: sudo apt-get install jq (Ubuntu) or brew install jq (macOS)"
  exit 1
fi

echo -e "${BLUE}Baseline Name:${NC} $NAME"
echo -e "${BLUE}Description:${NC} $DESCRIPTION"
echo ""

# Get current metrics from dashboard
echo -e "${YELLOW}Fetching current metrics...${NC}"
CURRENT_METRICS=$(curl -s "${AGENTX_URL}/api/performance/dashboard")

# Check if dashboard is accessible
if [ -z "$CURRENT_METRICS" ]; then
  echo -e "${RED}Error: Could not fetch metrics from ${AGENTX_URL}/api/performance/dashboard${NC}"
  echo "Make sure AgentX is running on $AGENTX_URL"
  exit 1
fi

# Extract metrics using jq
AVG_LATENCY=$(echo "$CURRENT_METRICS" | jq -r '.data.metrics_24h.avg_latency // 0')
P95_LATENCY=$(echo "$CURRENT_METRICS" | jq -r '.data.metrics_24h.p95_latency // 0')
ERROR_RATE=$(echo "$CURRENT_METRICS" | jq -r '.data.metrics_24h.error_rate // 0')
THROUGHPUT=$(echo "$CURRENT_METRICS" | jq -r '.data.metrics_24h.throughput_rps // 0')

echo -e "${GREEN}✓ Metrics captured${NC}"
echo "  Average Latency: ${AVG_LATENCY}ms"
echo "  P95 Latency: ${P95_LATENCY}ms"
echo "  Error Rate: ${ERROR_RATE}%"
echo "  Throughput: ${THROUGHPUT} req/s"
echo ""

# Validate metrics
if [ "$AVG_LATENCY" = "0" ] || [ "$AVG_LATENCY" = "null" ]; then
  echo -e "${YELLOW}Warning: No recent performance data available${NC}"
  echo "The baseline will be created with current values, but they may be incomplete."
  echo ""
  read -p "Continue anyway? (y/n) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 1
  fi
fi

# Create baseline
echo -e "${YELLOW}Creating baseline...${NC}"

PAYLOAD=$(cat <<EOF
{
  "name": "$NAME",
  "description": "$DESCRIPTION",
  "metrics": {
    "avg_response_time": $AVG_LATENCY,
    "p95_latency": $P95_LATENCY,
    "error_rate": $ERROR_RATE,
    "throughput_rps": $THROUGHPUT
  },
  "source": "manual",
  "activate": true
}
EOF
)

# Send to API
RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X POST "${AGENTX_URL}/api/performance/baselines" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

# Parse response
HTTP_BODY=$(echo "$RESPONSE" | sed -e 's/HTTP_STATUS\:.*//g')
HTTP_STATUS=$(echo "$RESPONSE" | tr -d '\n' | sed -e 's/.*HTTP_STATUS://')

# Check if creation succeeded
if [ "$HTTP_STATUS" -eq 201 ]; then
  echo -e "${GREEN}✓ Baseline created and activated!${NC}"
  echo ""
  echo "Response:"
  echo "$HTTP_BODY" | jq '.' 2>/dev/null || echo "$HTTP_BODY"
  echo ""

  # Extract baseline ID
  BASELINE_ID=$(echo "$HTTP_BODY" | jq -r '.data._id // .data.id // "unknown"')

  echo -e "${GREEN}==========================================${NC}"
  echo -e "${GREEN}Baseline Created Successfully!${NC}"
  echo -e "${GREEN}==========================================${NC}"
  echo ""
  echo -e "${BLUE}Baseline ID:${NC} $BASELINE_ID"
  echo -e "${BLUE}Status:${NC} Active"
  echo ""
  echo "This baseline will now be used for regression detection."
  exit 0
else
  echo -e "${RED}✗ Baseline creation failed (HTTP $HTTP_STATUS)${NC}"
  echo ""
  echo "Response:"
  echo "$HTTP_BODY" | jq '.' 2>/dev/null || echo "$HTTP_BODY"
  exit 1
fi
