#!/bin/bash
# Test judge model responses from both hosts
# Usage: ./test-judge-hosts.sh

set -euo pipefail

HOST_12="http://192.168.2.12:11434"
HOST_99="http://192.168.2.99:11434"
JUDGE_MODEL="qwen2.5:7b-instruct-q5_K_M"

# Simple test prompt
TEST_PROMPT='You are a quality evaluator. Analyze the given response and score it across multiple dimensions.

CRITERIA TO EVALUATE:
1. correctness (0-10): Does code work & produce correct output?
2. clarity (0-10): Is code readable & well-structured?
3. efficiency (0-10): Reasonable performance?
4. robustness (0-10): Handles errors gracefully?

TASK: Write a Python function to calculate factorial
EXPECTED: See criteria
RESPONSE TO EVALUATE:
def factorial(n):
    if n == 0:
        return 1
    return n * factorial(n-1)

CRITICAL INSTRUCTIONS:
1. Score each criterion on a 0-10 scale (integers or decimals)
2. The '\''overall'\'' score must ALSO be 0-10 (weighted average, NOT a sum)
3. You MUST respond with a JSON object (not an array, not text)
4. Every dimension must have a numeric score

Respond ONLY with a JSON object in this EXACT format:
{
  "correctness": 8.5,
  "clarity": 7.0,
  "efficiency": 6.5,
  "robustness": 5.0,
  "overall": 7.2,
  "explanation": "brief reason"
}

Do NOT respond with just keys, do NOT respond with an array, do NOT add explanatory text outside the JSON.'

echo "======================================"
echo "Testing Judge Model on Both Hosts"
echo "======================================"
echo ""

# Function to test a host
test_host() {
    local HOST=$1
    local NAME=$2
    
    echo "----------------------------------------"
    echo "Testing: $NAME"
    echo "Host: $HOST"
    echo "Model: $JUDGE_MODEL"
    echo "----------------------------------------"
    
    # Check if model exists
    echo "Checking if model exists..."
    if ! curl -s "$HOST/api/tags" | jq -e ".models[] | select(.name == \"$JUDGE_MODEL\")" > /dev/null; then
        echo "❌ Model $JUDGE_MODEL not found on $NAME"
        echo ""
        return 1
    fi
    echo "✓ Model found"
    echo ""
    
    # Make request and capture response
    echo "Sending judge prompt..."
    local START=$(date +%s%3N)
    
    RESPONSE=$(curl -s -X POST "$HOST/api/generate" \
        -H "Content-Type: application/json" \
        -d "{
            \"model\": \"$JUDGE_MODEL\",
            \"prompt\": $(echo "$TEST_PROMPT" | jq -Rs .),
            \"stream\": false,
            \"options\": {
                \"temperature\": 0.3,
                \"num_predict\": 500,
                \"num_ctx\": 8192
            }
        }")
    
    local END=$(date +%s%3N)
    local DURATION=$((END - START))
    
    echo "Response time: ${DURATION}ms"
    echo ""
    
    # Extract response text
    RESPONSE_TEXT=$(echo "$RESPONSE" | jq -r '.response // empty')
    
    if [ -z "$RESPONSE_TEXT" ]; then
        echo "❌ Empty response from $NAME"
        echo "Full response: $RESPONSE"
        echo ""
        return 1
    fi
    
    echo "Response length: ${#RESPONSE_TEXT} characters"
    echo ""
    echo "--- Raw Response (first 500 chars) ---"
    echo "$RESPONSE_TEXT" | head -c 500
    echo ""
    echo "---------------------------------------"
    echo ""
    
    # Try to extract JSON
    echo "Attempting JSON extraction..."
    
    # Method 1: Code block
    JSON_EXTRACTED=$(echo "$RESPONSE_TEXT" | sed -n '/```json/,/```/p' | sed '1d;$d' || true)
    
    if [ -z "$JSON_EXTRACTED" ]; then
        # Method 2: Try using the whole response if it looks like JSON
        if echo "$RESPONSE_TEXT" | grep -q '^[[:space:]]*{' ; then
            JSON_EXTRACTED="$RESPONSE_TEXT"
        fi
    fi
    
    if [ -z "$JSON_EXTRACTED" ]; then
        echo "❌ No JSON found in response"
        echo ""
        echo "--- Full Response Text ---"
        echo "$RESPONSE_TEXT"
        echo "-------------------------"
        echo ""
        return 1
    fi
    
    echo "JSON extracted (${#JSON_EXTRACTED} chars):"
    echo "$JSON_EXTRACTED"
    echo ""
    
    # Try to parse JSON
    echo "Attempting JSON parse..."
    if echo "$JSON_EXTRACTED" | jq . > /dev/null 2>&1; then
        echo "✅ Valid JSON!"
        echo ""
        echo "--- Parsed JSON ---"
        echo "$JSON_EXTRACTED" | jq .
        echo "-------------------"
    else
        echo "❌ Invalid JSON!"
        echo ""
        echo "jq error:"
        echo "$JSON_EXTRACTED" | jq . 2>&1 || true
    fi
    
    echo ""
    return 0
}

# Test both hosts
test_host "$HOST_99" "192.168.2.99 (Primary)"
test_host "$HOST_12" "192.168.2.12 (Secondary)"

echo "======================================"
echo "Test Complete"
echo "======================================"
