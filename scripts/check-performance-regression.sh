#!/bin/bash
# Performance Regression Check Script
#
# This script queries the baseline comparison API and exits with non-zero status
# if regression is detected. Useful for CI/CD pipelines.
#
# Usage: ./scripts/check-performance-regression.sh
#
# Features:
# - Compares current metrics against active baseline
# - Exits with code 1 if regression detected
# - Exits with code 0 if no regression
# - Displays detailed regression information
# - CI/CD friendly output
#
# Example (CI/CD pipeline):
#   ./scripts/check-performance-regression.sh || exit 1

set -e  # Exit on error

# Configuration
AGENTX_URL=${AGENTX_URL:-http://localhost:3080}
HOURS=${HOURS:-24}  # Lookback period for current metrics

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${YELLOW}==========================================${NC}"
echo -e "${YELLOW}Performance Regression Check${NC}"
echo -e "${YELLOW}==========================================${NC}"
echo ""

# Check if jq is installed
if ! command -v jq &> /dev/null; then
  echo -e "${RED}Error: jq is not installed${NC}"
  echo "Install with: sudo apt-get install jq (Ubuntu) or brew install jq (macOS)"
  exit 1
fi

echo -e "${BLUE}Checking metrics from last ${HOURS} hours...${NC}"
echo ""

# Fetch comparison
COMPARISON=$(curl -s "${AGENTX_URL}/api/performance/baseline-compare?hours=${HOURS}")

# Check if API is accessible
if [ -z "$COMPARISON" ]; then
  echo -e "${RED}Error: Could not fetch comparison from ${AGENTX_URL}/api/performance/baseline-compare${NC}"
  echo "Make sure AgentX is running on $AGENTX_URL"
  exit 1
fi

# Check for API errors
STATUS=$(echo "$COMPARISON" | jq -r '.status // "unknown"')
if [ "$STATUS" = "error" ]; then
  ERROR_MSG=$(echo "$COMPARISON" | jq -r '.message // "Unknown error"')
  echo -e "${RED}API Error: $ERROR_MSG${NC}"
  echo ""

  # If no baseline exists, this is not a regression (warn but exit 0)
  if echo "$ERROR_MSG" | grep -q "No baseline"; then
    echo -e "${YELLOW}Warning: No baseline configured${NC}"
    echo "Create a baseline first: ./scripts/create-performance-baseline.sh <name>"
    echo ""
    echo "Skipping regression check."
    exit 0
  fi

  exit 1
fi

# Extract data
BASELINE_NAME=$(echo "$COMPARISON" | jq -r '.data.baseline.name // "unknown"')
REGRESSION_DETECTED=$(echo "$COMPARISON" | jq -r '.data.regression_detected // false')

echo -e "${BLUE}Active Baseline:${NC} $BASELINE_NAME"
echo ""

# Display metrics comparison
echo -e "${YELLOW}Metrics Comparison:${NC}"
echo ""

# Function to display metric comparison
display_metric() {
  local metric_name=$1
  local label=$2
  local unit=$3

  local current=$(echo "$COMPARISON" | jq -r ".data.current.${metric_name} // 0")
  local baseline=$(echo "$COMPARISON" | jq -r ".data.baseline.metrics.${metric_name} // 0")
  local diff=$(echo "$COMPARISON" | jq -r ".data.diff_percentage.${metric_name} // 0")

  # Color code based on diff
  local color=$GREEN
  if (( $(echo "$diff > 10" | bc -l) )); then
    color=$YELLOW
  fi
  if (( $(echo "$diff > 20" | bc -l) )); then
    color=$RED
  fi

  # Format with sign
  local diff_display=$diff
  if (( $(echo "$diff > 0" | bc -l) )); then
    diff_display="+$diff"
  fi

  printf "  %-20s: %8s%-5s (baseline: %8s%-5s) ${color}%s%%${NC}\n" \
    "$label" "$current" "$unit" "$baseline" "$unit" "$diff_display"
}

display_metric "avg_response_time" "Avg Response Time" "ms"
display_metric "p95_latency" "P95 Latency" "ms"
display_metric "error_rate" "Error Rate" "%"
display_metric "throughput_rps" "Throughput" "rps"

echo ""

# Check for regressions
if [ "$REGRESSION_DETECTED" = "true" ]; then
  echo -e "${RED}==========================================${NC}"
  echo -e "${RED}❌ Performance Regression Detected!${NC}"
  echo -e "${RED}==========================================${NC}"
  echo ""

  # Display regression details
  REGRESSIONS=$(echo "$COMPARISON" | jq -r '.data.regressions // []')
  REGRESSION_COUNT=$(echo "$REGRESSIONS" | jq 'length')

  echo -e "${YELLOW}Regressions Found: $REGRESSION_COUNT${NC}"
  echo ""

  # Display each regression
  echo "$REGRESSIONS" | jq -r '.[] | "  • \(.metric): \(.current) (baseline: \(.baseline)) - Threshold: \(.threshold)"'

  echo ""
  echo -e "${YELLOW}Recommendations:${NC}"
  echo "  1. Review recent code changes"
  echo "  2. Check system resource utilization"
  echo "  3. Investigate slow endpoints in dashboard"
  echo "  4. Run detailed profiling if needed"
  echo ""

  exit 1
else
  echo -e "${GREEN}==========================================${NC}"
  echo -e "${GREEN}✅ No Performance Regression Detected${NC}"
  echo -e "${GREEN}==========================================${NC}"
  echo ""
  echo "All metrics are within acceptable thresholds."
  echo ""

  exit 0
fi
