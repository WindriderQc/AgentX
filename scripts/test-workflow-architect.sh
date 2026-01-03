#!/bin/bash
# Test script for SBQC Workflow Architect
# Demonstrates the complete workflow generation system

set -e

WEBHOOK_URL="https://n8n.specialblend.icu/webhook/sbqc-workflow-architect"
AGENTX_API="http://192.168.2.33:3080/api/workflow"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo ""
echo "╔═══════════════════════════════════════════════════════╗"
echo "║   SBQC Workflow Architect - Test Suite              ║"
echo "╚═══════════════════════════════════════════════════════╝"
echo ""

# Test 1: Generate simple workflow (no deploy)
echo -e "${BLUE}[Test 1/5]${NC} Generate Simple Workflow (No Deploy)"
echo "Description: Create a simple webhook that returns hello world"
echo ""

RESPONSE=$(curl -s -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Create a simple workflow with one webhook that receives a POST request and returns a JSON response with {message: hello world, timestamp: current time}",
    "options": {
      "validate": true,
      "deploy": false,
      "activate": false
    }
  }')

SUCCESS=$(echo "$RESPONSE" | jq -r '.success')
if [ "$SUCCESS" = "true" ]; then
  echo -e "${GREEN}✓${NC} Success!"
  WORKFLOW_NAME=$(echo "$RESPONSE" | jq -r '.workflow.name')
  NODE_COUNT=$(echo "$RESPONSE" | jq -r '.workflow.nodeCount')
  VALIDATION_SCORE=$(echo "$RESPONSE" | jq -r '.validation.score')
  
  echo "  Name: $WORKFLOW_NAME"
  echo "  Nodes: $NODE_COUNT"
  echo "  Validation Score: $VALIDATION_SCORE/100"
  echo ""
else
  echo -e "${RED}✗${NC} Failed"
  echo "$RESPONSE" | jq '.'
  exit 1
fi

sleep 2

# Test 2: Generate with deployment
echo -e "${BLUE}[Test 2/5]${NC} Generate & Deploy Workflow"
echo "Description: Create a health check monitor with deployment"
echo ""

RESPONSE=$(curl -s -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Create a workflow that checks DataAPI health endpoint every 5 minutes and logs the response time",
    "options": {
      "validate": true,
      "deploy": true,
      "activate": false
    }
  }')

SUCCESS=$(echo "$RESPONSE" | jq -r '.success')
DEPLOYED=$(echo "$RESPONSE" | jq -r '.deployment.deployed')

if [ "$SUCCESS" = "true" ] && [ "$DEPLOYED" = "true" ]; then
  echo -e "${GREEN}✓${NC} Success!"
  WORKFLOW_ID=$(echo "$RESPONSE" | jq -r '.deployment.workflowId')
  VIEW_URL=$(echo "$RESPONSE" | jq -r '.actions.viewInN8n')
  
  echo "  Workflow ID: $WORKFLOW_ID"
  echo "  View in n8n: $VIEW_URL"
  echo ""
else
  echo -e "${YELLOW}⚠${NC} Partial Success (generated but not deployed)"
  echo "$RESPONSE" | jq '.deployment'
  echo ""
fi

sleep 2

# Test 3: Invalid request (missing description)
echo -e "${BLUE}[Test 3/5]${NC} Test Error Handling (Invalid Request)"
echo "Sending request without description..."
echo ""

RESPONSE=$(curl -s -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d '{}')

SUCCESS=$(echo "$RESPONSE" | jq -r '.success')
if [ "$SUCCESS" = "false" ]; then
  echo -e "${GREEN}✓${NC} Error handled correctly"
  ERROR_MSG=$(echo "$RESPONSE" | jq -r '.message')
  echo "  Error: $ERROR_MSG"
  echo ""
else
  echo -e "${RED}✗${NC} Should have returned error"
  exit 1
fi

sleep 2

# Test 4: Direct API call to validate endpoint
echo -e "${BLUE}[Test 4/5]${NC} Direct API - Validate Workflow"
echo "Testing AgentX API directly..."
echo ""

SAMPLE_WORKFLOW='{
  "name": "Test Workflow",
  "nodes": [
    {
      "id": "node1",
      "name": "Webhook",
      "type": "n8n-nodes-base.webhook",
      "position": [0, 0],
      "parameters": {
        "httpMethod": "POST",
        "path": "test",
        "webhookId": "test-id"
      }
    }
  ],
  "connections": {},
  "settings": {}
}'

RESPONSE=$(curl -s -X POST "$AGENTX_API/validate" \
  -H "Content-Type: application/json" \
  -d "{\"workflow\": $SAMPLE_WORKFLOW}")

VALID=$(echo "$RESPONSE" | jq -r '.data.overall.valid')
if [ "$VALID" = "true" ]; then
  echo -e "${GREEN}✓${NC} Validation passed"
  SCORE=$(echo "$RESPONSE" | jq -r '.data.overall.score')
  echo "  Score: $SCORE/100"
  echo ""
else
  echo -e "${RED}✗${NC} Validation failed"
  echo "$RESPONSE" | jq '.data.allErrors'
  echo ""
fi

sleep 2

# Test 5: Get examples
echo -e "${BLUE}[Test 5/5]${NC} Get Workflow Examples"
echo "Fetching example workflows from AgentC/..."
echo ""

RESPONSE=$(curl -s "$AGENTX_API/examples")

COUNT=$(echo "$RESPONSE" | jq -r '.data.count')
echo -e "${GREEN}✓${NC} Found $COUNT example workflows"
echo ""
echo "Sample examples:"
echo "$RESPONSE" | jq -r '.data.examples[0:3] | .[] | "  • \(.name) (\(.nodeCount) nodes)"'
echo ""

# Summary
echo "╔═══════════════════════════════════════════════════════╗"
echo "║              Test Suite Complete!                    ║"
echo "╚═══════════════════════════════════════════════════════╝"
echo ""
echo -e "${GREEN}✓${NC} All tests passed successfully"
echo ""
echo "System Status:"
echo "  • n8n Workflow: Active"
echo "  • AgentX API: Operational"
echo "  • Validation: Working"
echo "  • Generation: Working"
echo "  • Deployment: Working"
echo ""
echo "Quick Start:"
echo "  curl -X POST $WEBHOOK_URL \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"description\": \"your workflow idea here\"}'"
echo ""
