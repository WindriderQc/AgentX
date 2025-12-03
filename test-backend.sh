#!/bin/bash
# AgentX Backend Test Script
# Tests all V1 and V2 endpoints

BASE_URL="http://localhost:3080"
USER_ID="test_user_$(date +%s)"

echo "🧪 AgentX Backend Test Suite"
echo "============================"
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Test health endpoint
echo "1. Testing health endpoint..."
HEALTH=$(curl -s "$BASE_URL/health")
if echo "$HEALTH" | grep -q "ok"; then
    echo -e "${GREEN}✓ Health check passed${NC}"
else
    echo -e "${RED}✗ Health check failed${NC}"
    exit 1
fi
echo ""

# Test user profile creation
echo "2. Creating user profile..."
PROFILE=$(curl -s -X POST "$BASE_URL/api/profile" \
    -H "Content-Type: application/json" \
    -d "{
        \"userId\": \"$USER_ID\",
        \"name\": \"Test User\",
        \"role\": \"Developer\",
        \"response_style\": \"detailed\",
        \"code_preference\": \"code-heavy\"
    }")

if echo "$PROFILE" | grep -q "success"; then
    echo -e "${GREEN}✓ User profile created${NC}"
    echo "Profile: $(echo $PROFILE | jq -r '.data.name')"
else
    echo -e "${RED}✗ User profile creation failed${NC}"
    exit 1
fi
echo ""

# Test chat endpoint (requires Ollama)
echo "3. Testing chat endpoint..."
echo "   (Note: This requires Ollama to be running with llama2 model)"
read -p "   Do you have Ollama running? (y/n) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    CHAT=$(curl -s -X POST "$BASE_URL/api/chat" \
        -H "Content-Type: application/json" \
        -d "{
            \"userId\": \"$USER_ID\",
            \"message\": \"Say hello in one sentence\",
            \"model\": \"llama2\",
            \"options\": {
                \"temperature\": 0.7
            }
        }")
    
    if echo "$CHAT" | grep -q "success"; then
        echo -e "${GREEN}✓ Chat endpoint works${NC}"
        CONVERSATION_ID=$(echo $CHAT | jq -r '.data.conversationId')
        MESSAGE_ID=$(echo $CHAT | jq -r '.data.messageId')
        echo "   Conversation ID: $CONVERSATION_ID"
        echo "   Message ID: $MESSAGE_ID"
        echo "   Response: $(echo $CHAT | jq -r '.data.response' | cut -c1-80)..."
        
        # Test feedback
        echo ""
        echo "4. Testing feedback endpoint..."
        FEEDBACK=$(curl -s -X POST "$BASE_URL/api/feedback" \
            -H "Content-Type: application/json" \
            -d "{
                \"messageId\": \"$MESSAGE_ID\",
                \"rating\": 1,
                \"comment\": \"Great test response!\"
            }")
        
        if echo "$FEEDBACK" | grep -q "success"; then
            echo -e "${GREEN}✓ Feedback submitted${NC}"
        else
            echo -e "${RED}✗ Feedback submission failed${NC}"
        fi
        
        # Test conversation retrieval
        echo ""
        echo "5. Testing conversation retrieval..."
        CONV=$(curl -s "$BASE_URL/api/conversations/$CONVERSATION_ID")
        if echo "$CONV" | grep -q "success"; then
            echo -e "${GREEN}✓ Conversation retrieved${NC}"
            MSG_COUNT=$(echo $CONV | jq '.data.messages | length')
            echo "   Messages in conversation: $MSG_COUNT"
        else
            echo -e "${RED}✗ Conversation retrieval failed${NC}"
        fi
        
        # Test conversations list
        echo ""
        echo "6. Testing conversations list..."
        CONVS=$(curl -s "$BASE_URL/api/conversations?userId=$USER_ID")
        if echo "$CONVS" | grep -q "success"; then
            echo -e "${GREEN}✓ Conversations list retrieved${NC}"
            CONV_COUNT=$(echo $CONVS | jq '.data | length')
            echo "   Total conversations: $CONV_COUNT"
        else
            echo -e "${RED}✗ Conversations list failed${NC}"
        fi
        
    else
        echo -e "${RED}✗ Chat endpoint failed${NC}"
        echo "Error: $(echo $CHAT | jq -r '.message')"
    fi
else
    echo "   Skipping chat endpoint test"
    echo "   To test chat: Start Ollama and run: ollama pull llama2"
fi

echo ""
echo "7. Testing profile retrieval..."
PROFILE_GET=$(curl -s "$BASE_URL/api/user/profile?userId=$USER_ID")
if echo "$PROFILE_GET" | grep -q "success"; then
    echo -e "${GREEN}✓ Profile retrieved${NC}"
    echo "   Name: $(echo $PROFILE_GET | jq -r '.data.name')"
    echo "   Style: $(echo $PROFILE_GET | jq -r '.data.response_style')"
else
    echo -e "${RED}✗ Profile retrieval failed${NC}"
fi

echo ""
echo "============================"
echo "✅ Backend test suite complete"
echo ""
echo "📊 Summary:"
echo "   - Health check: working"
echo "   - User profiles: working"
echo "   - Chat endpoint: $([ $REPLY = 'y' ] && echo 'tested' || echo 'skipped')"
echo "   - Feedback: $([ $REPLY = 'y' ] && echo 'tested' || echo 'skipped')"
echo "   - Conversations: $([ $REPLY = 'y' ] && echo 'tested' || echo 'skipped')"
echo ""
echo "🔗 Next steps:"
echo "   1. Check API_DOCS.md for complete endpoint documentation"
echo "   2. Test with your frontend"
echo "   3. Review data in ./data/agentx.db"
