#!/bin/bash
# Test n8n workflow deployment with proper API handling
set -e

N8N_URL="http://192.168.2.199:5678"
N8N_API_KEY="${N8N_API_KEY:-eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkNGEwZDRhMi1lZTM1LTRkNTAtYjUxMC00ZjQyNTRmODBkMjMiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwiaWF0IjoxNzY2MDM3NjUyfQ.6M1ytDtLOq8zuVk1-g9KeYgwTVdv9QPh2HnBebWCHeg}"
WORKFLOW_FILE="/home/yb/codes/AgentX/AgentC/N0.0-test-deployment.json"

echo "Testing n8n workflow deployment..."
echo ""

# Test 1: Check API connectivity (no auth)
echo "Test 1: API connectivity"
response=$(curl -s "$N8N_URL/healthz")
echo "Health check: $response"
echo ""

# Test 2: Try to create workflow via POST (no auth - n8n might allow this)
echo "Test 2: Creating workflow via POST /api/v1/workflows"

# Clean the JSON - keep only essential fields
cleaned_json=$(jq '{
  name,
  nodes,
  connections,
  settings
}' "$WORKFLOW_FILE")

echo "Sending workflow with $(echo "$cleaned_json" | jq '.nodes | length') nodes..."

response=$(curl -s -w "\n%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" \
  -d "$cleaned_json" \
  "$N8N_URL/api/v1/workflows" 2>/dev/null || echo -e "\n000")

http_code=$(echo "$response" | tail -n 1)
body=$(echo "$response" | head -n -1)

echo "HTTP Status: $http_code"
echo "Response:"
echo "$body" | jq '.' 2>/dev/null || echo "$body"
echo ""

if [ "$http_code" = "200" ] || [ "$http_code" = "201" ]; then
    workflow_id=$(echo "$body" | jq -r '.data.id // .id' 2>/dev/null)
    echo "✓ Success! Workflow ID: $workflow_id"

    # Verify the workflow has nodes
    echo ""
    echo "Test 3: Verifying workflow has nodes"
    verify=$(curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" "$N8N_URL/api/v1/workflows/$workflow_id")
    node_count=$(echo "$verify" | jq -r '.data.nodes // .nodes | length' 2>/dev/null || echo "0")
    echo "Nodes in created workflow: $node_count"

    if [ "$node_count" -gt 0 ]; then
        echo "✓ Workflow created successfully with nodes!"
    else
        echo "✗ Workflow created but has NO nodes!"
    fi
else
    echo "✗ Failed to create workflow"
fi
