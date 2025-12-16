#!/bin/bash
# V4 Analytics & Dataset API Test Script
# Tests all V4 endpoints per specs/V4_ANALYTICS_ARCHITECTURE.md

BASE_URL="${1:-http://localhost:3080}"
OLLAMA_HOST="${2:-192.168.2.99:11434}"

echo "==================================="
echo "V4 API Test Suite"
echo "Base URL: $BASE_URL"
echo "Ollama: $OLLAMA_HOST"
echo "==================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Helper function to test endpoint
test_endpoint() {
    local name="$1"
    local method="$2"
    local endpoint="$3"
    local data="$4"
    
    echo -e "${YELLOW}Testing: $name${NC}"
    echo "  Method: $method"
    echo "  Endpoint: $endpoint"
    
    if [ "$method" = "GET" ]; then
        response=$(curl -s -w "\n%{http_code}" "$BASE_URL$endpoint")
    else
        response=$(curl -s -w "\n%{http_code}" -X "$method" \
            -H "Content-Type: application/json" \
            -d "$data" \
            "$BASE_URL$endpoint")
    fi
    
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | head -n-1)
    
    if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
        echo -e "  ${GREEN}✓ Success ($http_code)${NC}"
        echo "  Response: $(echo "$body" | jq -c '.' 2>/dev/null || echo "$body")"
    else
        echo -e "  ${RED}✗ Failed ($http_code)${NC}"
        echo "  Response: $body"
    fi
    echo ""
}

# 0. Server health check
echo "=== 0. Health Check ==="
test_endpoint "Health Check" "GET" "/health" ""

# 1. Create test conversation with chat endpoint
echo "=== 1. Create Test Conversation ==="
CHAT_DATA=$(cat <<EOF
{
    "target": "$OLLAMA_HOST",
    "model": "llama3.2:1b",
    "message": "What is 2+2?",
    "messages": [],
    "options": {
        "temperature": 0.7
    }
}
EOF
)

test_endpoint "Chat (creates conversation with prompt version)" "POST" "/api/chat" "$CHAT_DATA"

# 2. Test Analytics: Usage
echo "=== 2. Analytics - Usage Stats ==="
test_endpoint "Usage (default 7 days)" "GET" "/api/analytics/usage" ""
test_endpoint "Usage by model" "GET" "/api/analytics/usage?groupBy=model" ""
test_endpoint "Usage by promptVersion" "GET" "/api/analytics/usage?groupBy=promptVersion" ""
test_endpoint "Usage by day" "GET" "/api/analytics/usage?groupBy=day" ""

# 3. Test Analytics: Feedback
echo "=== 3. Analytics - Feedback Stats ==="
test_endpoint "Feedback (overall)" "GET" "/api/analytics/feedback" ""
test_endpoint "Feedback by promptVersion" "GET" "/api/analytics/feedback?groupBy=promptVersion" ""
test_endpoint "Feedback by model" "GET" "/api/analytics/feedback?groupBy=model" ""

# 4. Test Analytics: RAG Stats
echo "=== 4. Analytics - RAG Performance ==="
test_endpoint "RAG Stats" "GET" "/api/analytics/rag-stats" ""

# 5. Test Dataset: Conversation Export
echo "=== 5. Dataset - Conversation Export ==="
test_endpoint "Export conversations (default)" "GET" "/api/dataset/conversations" ""
test_endpoint "Export with limit=2" "GET" "/api/dataset/conversations?limit=2" ""
test_endpoint "Export with positive feedback only" "GET" "/api/dataset/conversations?minFeedback=1" ""

# 6. Test Dataset: Prompt Management
echo "=== 6. Dataset - Prompt Management ==="

# 6a. List all prompts
test_endpoint "List all prompts" "GET" "/api/dataset/prompts" ""

# 6b. List active prompts
test_endpoint "List active prompts" "GET" "/api/dataset/prompts?status=active" ""

# 6c. Create new prompt (proposed)
# Use timestamp to create unique version number
TEST_VERSION=$(date +%s | tail -c 4)
NEW_PROMPT_DATA=$(cat <<EOF
{
    "name": "default_chat",
    "version": $TEST_VERSION,
    "systemPrompt": "You are AgentX v$TEST_VERSION, an efficient and concise AI assistant. Answer directly and accurately.",
    "description": "Test prompt v$TEST_VERSION - more direct",
    "status": "proposed",
    "author": "test-script"
}
EOF
)

PROMPT_RESPONSE=$(curl -s -X POST "$BASE_URL/api/dataset/prompts" \
  -H "Content-Type: application/json" \
  -d "$NEW_PROMPT_DATA")

echo "  Response: $(echo "$PROMPT_RESPONSE" | jq -c '{status: .status, id: .data._id, version: .data.version, message: .message}')"

# Extract the new prompt ID for activation test
NEW_PROMPT_ID=$(echo "$PROMPT_RESPONSE" | jq -r '.data._id')

if [ "$NEW_PROMPT_ID" != "null" ] && [ -n "$NEW_PROMPT_ID" ]; then
    echo -e "  ${GREEN}✓ Prompt created with ID: $NEW_PROMPT_ID${NC}"
else
    ERROR_MSG=$(echo "$PROMPT_RESPONSE" | jq -r '.message')
    echo -e "  ${RED}✗ Failed to create prompt: $ERROR_MSG${NC}"
fi

# 6d. List proposed prompts
test_endpoint "List proposed prompts" "GET" "/api/dataset/prompts?status=proposed" ""

# 6e. Activate the new prompt
if [ "$NEW_PROMPT_ID" != "null" ] && [ -n "$NEW_PROMPT_ID" ]; then
    echo ""
    echo "Testing: Activate prompt (v2)"
    echo "  Method: PATCH"
    echo "  Endpoint: /api/dataset/prompts/$NEW_PROMPT_ID/activate"
    
    ACTIVATE_RESPONSE=$(curl -s -X PATCH "$BASE_URL/api/dataset/prompts/$NEW_PROMPT_ID/activate" \
      -H "Content-Type: application/json")
    
    if echo "$ACTIVATE_RESPONSE" | jq -e '.status == "success"' > /dev/null 2>&1; then
        echo -e "  ${GREEN}✓ Passed${NC}"
        echo "  Response: $(echo "$ACTIVATE_RESPONSE" | jq -c '{status: .status, message: .message}')"
    else
        echo -e "  ${RED}✗ Failed${NC}"
        echo "  Response: $(echo "$ACTIVATE_RESPONSE" | jq -c .)"
    fi
    
    # Verify it's now active
    echo ""
    test_endpoint "Verify prompt is active" "GET" "/api/dataset/prompts?status=active&name=default_chat" ""
else
    echo -e "  ${YELLOW}⊘ Skipping activation test (no prompt ID)${NC}"
fi

# 7. Advanced: Date Range Query
echo "=== 7. Advanced - Date Range Filtering ==="
FROM_DATE=$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-7d +%Y-%m-%dT%H:%M:%SZ)
TO_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)

test_endpoint "Usage with date range" "GET" "/api/analytics/usage?from=$FROM_DATE&to=$TO_DATE" ""
test_endpoint "Feedback with date range" "GET" "/api/analytics/feedback?from=$FROM_DATE&to=$TO_DATE" ""

# 8. Summary
echo "==================================="
echo -e "${GREEN}V4 API Test Suite Complete${NC}"
echo "==================================="
echo ""
echo "Next steps:"
echo "1. Review test outputs above"
echo "2. Check MongoDB for PromptConfig collection"
echo "3. Verify conversations have promptVersion fields"
echo "4. Test prompt activation: PATCH /api/dataset/prompts/<id>/activate"
echo "5. Monitor analytics over time as usage grows"
echo ""
echo "For Agent C (n8n integration):"
echo "  - All 3 analytics endpoints ready: /usage, /feedback, /rag-stats"
echo "  - Dataset export ready: /dataset/conversations with filters"
echo "  - Prompt proposal ready: POST /dataset/prompts"
echo "  - Prompt activation ready: PATCH /dataset/prompts/:id/activate"
