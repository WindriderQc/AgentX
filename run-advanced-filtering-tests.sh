#!/bin/bash
# Quick-start script for running Advanced Filtering E2E tests
#
# Usage:
#   ./run-advanced-filtering-tests.sh [options]
#
# Options:
#   --headed        Run in headed mode (see browser)
#   --debug         Run in debug mode
#   --ui            Run in UI mode (interactive)
#   --chromium      Run only in Chromium
#   --all-browsers  Run in all browsers (default: Chromium only)
#

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Parse arguments
HEADED=""
DEBUG=""
UI=""
PROJECT="--project=chromium"

while [[ $# -gt 0 ]]; do
  case $1 in
    --headed)
      HEADED="--headed"
      shift
      ;;
    --debug)
      DEBUG="--debug"
      shift
      ;;
    --ui)
      UI="--ui"
      shift
      ;;
    --chromium)
      PROJECT="--project=chromium"
      shift
      ;;
    --all-browsers)
      PROJECT=""
      shift
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

echo -e "${YELLOW}Advanced Filtering E2E Tests${NC}"
echo "================================="
echo ""

# Check if Playwright is installed
if ! npx playwright --version &> /dev/null; then
  echo -e "${RED}Error: Playwright is not installed${NC}"
  echo "Install with: npx playwright install chromium"
  exit 1
fi

# Check if server is running
BASE_URL="${BASE_URL:-http://localhost:3080}"
if ! curl -s "${BASE_URL}/health" > /dev/null 2>&1; then
  echo -e "${YELLOW}Warning: Server is not running on ${BASE_URL}${NC}"
  echo "Start the server with: npm start"
  echo ""
  read -p "Continue anyway? (y/n) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

# Run tests
echo -e "${GREEN}Running Advanced Filtering Tests...${NC}"
echo ""

if [ -n "$UI" ]; then
  npx playwright test tests/e2e/advanced-filtering.spec.js --ui
elif [ -n "$DEBUG" ]; then
  npx playwright test tests/e2e/advanced-filtering.spec.js --debug $PROJECT
else
  npx playwright test tests/e2e/advanced-filtering.spec.js $HEADED $PROJECT
fi

TEST_EXIT_CODE=$?

if [ $TEST_EXIT_CODE -eq 0 ]; then
  echo ""
  echo -e "${GREEN}✅ All tests passed!${NC}"
  echo ""
  echo "View detailed report:"
  echo "  npx playwright show-report"
else
  echo ""
  echo -e "${RED}❌ Some tests failed${NC}"
  echo ""
  echo "View test results:"
  echo "  npx playwright show-report"
  echo ""
  echo "Debug failed tests:"
  echo "  ./run-advanced-filtering-tests.sh --debug"
  exit 1
fi
