#!/bin/bash
# Master Test Script
# Runs all test suites: Unit/Integration (Jest) and E2E (Shell scripts)

set -e # Exit on first error

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}Starting AgentX Test Suite...${NC}"

# 1. Run Unit & Integration Tests (Jest)
echo ""
echo -e "${YELLOW}[1/4] Running Jest Tests (Unit/Integration)...${NC}"
npm test

# 2. Check if Server is running for E2E tests
echo ""
echo -e "${YELLOW}Checking server status for E2E tests...${NC}"
PORT="${PORT:-3080}"
BASE_URL="${BASE_URL:-http://localhost:$PORT}"

if ! curl -s "$BASE_URL/health" > /dev/null; then
    echo -e "${RED}Server is not running on port $PORT.${NC}"
    echo "Starting server in background..."

    # Start server in background
    # Use the test-server.js which uses in-memory MongoDB
    nohup node tests/test-server.js > logs/test-server.log 2>&1 &
    SERVER_PID=$!

    # Wait for server to start
    echo "Waiting for server to start..."
    for i in {1..30}; do
        if curl -s "$BASE_URL/health" > /dev/null; then
            echo -e "${GREEN}Server started (PID: $SERVER_PID)${NC}"
            SERVER_STARTED_BY_SCRIPT=true
            break
        fi
        sleep 1
    done

    if [ "$SERVER_STARTED_BY_SCRIPT" != "true" ]; then
        echo -e "${RED}Failed to start server.${NC}"
        cat logs/test-server.log
        exit 1
    fi
else
    echo -e "${GREEN}Server is already running.${NC}"
    SERVER_STARTED_BY_SCRIPT=false
fi

# Function to cleanup server if we started it
cleanup() {
    if [ "$SERVER_STARTED_BY_SCRIPT" = "true" ]; then
        echo ""
        echo -e "${YELLOW}Stopping background server (PID: $SERVER_PID)...${NC}"
        kill $SERVER_PID
    fi
}
trap cleanup EXIT

# 3. Run E2E Scripts
echo ""
echo -e "${YELLOW}[2/4] Running Backend E2E Tests (V1/V2)...${NC}"
./test-backend.sh

echo ""
echo -e "${YELLOW}[3/4] Running V3 RAG Tests...${NC}"
./test-v3-rag.sh

echo ""
echo -e "${YELLOW}[4/4] Running V4 Analytics Tests...${NC}"
./test-v4-analytics.sh

echo ""
echo -e "${GREEN}✅ All Tests Passed Successfully!${NC}"
