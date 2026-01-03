#!/bin/bash
# Auto-Deployment Script with Validation
# Validates, fixes, deploys, and activates n8n workflows

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Load environment
if [ -f ".env" ]; then
    source .env
fi

N8N_URL="${N8N_URL:-https://n8n.specialblend.icu}"
N8N_API_KEY="${N8N_API_KEY:-}"

if [ -z "$N8N_API_KEY" ]; then
    echo -e "${RED}✗ N8N_API_KEY not set in .env${NC}"
    exit 1
fi

# Check if workflow file provided
if [ $# -eq 0 ] || [ "$1" == "--help" ] || [ "$1" == "-h" ]; then
    echo "Usage: $0 <workflow-file.json> [--no-activate]"
    echo ""
    echo "Options:"
    echo "  --no-activate    Deploy but don't activate the workflow"
    echo ""
    echo "Example: $0 AgentC/N3.2.json"
    exit 0
fi

WORKFLOW_FILE="$1"
AUTO_ACTIVATE=true

if [ "$2" == "--no-activate" ]; then
    AUTO_ACTIVATE=false
fi

# Resolve file path
if [ ! -f "$WORKFLOW_FILE" ]; then
    if [ -f "AgentC/$WORKFLOW_FILE" ]; then
        WORKFLOW_FILE="AgentC/$WORKFLOW_FILE"
    else
        echo -e "${RED}✗ Workflow file not found: $WORKFLOW_FILE${NC}"
        exit 1
    fi
fi

echo -e "${BLUE}╔═══════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Auto-Deploy Workflow with Validation v1.0          ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════════════════╝${NC}"
echo ""

# Step 1: Validate JSON syntax
echo -e "${BLUE}[1/6]${NC} Validating JSON syntax..."
if ! jq empty "$WORKFLOW_FILE" 2>/dev/null; then
    echo -e "${RED}✗ Invalid JSON syntax${NC}"
    exit 1
fi
echo -e "${GREEN}✓${NC} Valid JSON"

# Step 2: Check workflow structure
echo -e "${BLUE}[2/6]${NC} Checking workflow structure..."
NAME=$(jq -r '.name // empty' "$WORKFLOW_FILE")
NODES_COUNT=$(jq '.nodes | length' "$WORKFLOW_FILE")
CONNECTIONS_COUNT=$(jq '.connections | length' "$WORKFLOW_FILE")

if [ -z "$NAME" ]; then
    echo -e "${RED}✗ Missing workflow name${NC}"
    exit 1
fi

echo -e "${GREEN}✓${NC} Name: $NAME"
echo -e "${GREEN}✓${NC} Nodes: $NODES_COUNT"
echo -e "${GREEN}✓${NC} Connections: $CONNECTIONS_COUNT"

# Step 3: Validate webhooks
echo -e "${BLUE}[3/6]${NC} Validating webhook nodes..."
WEBHOOK_NODES=$(jq -r '.nodes[] | select(.type == "n8n-nodes-base.webhook") | .name' "$WORKFLOW_FILE")
WEBHOOK_COUNT=$(echo "$WEBHOOK_NODES" | grep -c . || echo "0")

if [ "$WEBHOOK_COUNT" -gt 0 ]; then
    echo -e "${BLUE}ℹ${NC} Found $WEBHOOK_COUNT webhook node(s)"

    # Check for webhookId and httpMethod
    MISSING_WEBHOOK_ID=$(jq -r '.nodes[] | select(.type == "n8n-nodes-base.webhook" and (.webhookId == null or .webhookId == "")) | .name' "$WORKFLOW_FILE")
    MISSING_HTTP_METHOD=$(jq -r '.nodes[] | select(.type == "n8n-nodes-base.webhook" and (.parameters.httpMethod == null or .parameters.httpMethod == "")) | .name' "$WORKFLOW_FILE")

    if [ -n "$MISSING_WEBHOOK_ID" ]; then
        echo -e "${YELLOW}⚠${NC} Warning: Webhook nodes missing webhookId:"
        echo "$MISSING_WEBHOOK_ID" | sed 's/^/    - /'
    fi

    if [ -n "$MISSING_HTTP_METHOD" ]; then
        echo -e "${YELLOW}⚠${NC} Warning: Webhook nodes missing httpMethod:"
        echo "$MISSING_HTTP_METHOD" | sed 's/^/    - /'
    fi

    if [ -z "$MISSING_WEBHOOK_ID" ] && [ -z "$MISSING_HTTP_METHOD" ]; then
        echo -e "${GREEN}✓${NC} All webhooks properly configured"
    fi
else
    echo -e "${BLUE}ℹ${NC} No webhook nodes (scheduled workflow)"
fi

# Step 4: Check connection format
echo -e "${BLUE}[4/6]${NC} Validating node connections..."
NODE_NAMES=$(jq -r '.nodes[].name' "$WORKFLOW_FILE")
CONNECTION_KEYS=$(jq -r '.connections | keys[]' "$WORKFLOW_FILE" 2>/dev/null || echo "")

INVALID_CONNECTIONS=""
for key in $CONNECTION_KEYS; do
    if ! echo "$NODE_NAMES" | grep -Fxq "$key"; then
        INVALID_CONNECTIONS="$INVALID_CONNECTIONS\n  - $key (not found in node names)"
    fi
done

if [ -n "$INVALID_CONNECTIONS" ]; then
    echo -e "${YELLOW}⚠${NC} Warning: Connections may use node IDs instead of names:$INVALID_CONNECTIONS"
    echo -e "${BLUE}ℹ${NC} Consider running: jq -f scripts/fix-workflow-connections.jq $WORKFLOW_FILE"
else
    echo -e "${GREEN}✓${NC} Connections use node names correctly"
fi

# Step 5: Deploy workflow
echo -e "${BLUE}[5/6]${NC} Deploying workflow to n8n..."

# Check if workflow exists
EXISTING_WORKFLOW=$(curl -s -X GET \
    -H "X-N8N-API-KEY: $N8N_API_KEY" \
    "$N8N_URL/api/v1/workflows" | \
    jq -r --arg name "$NAME" '.data[] | select(.name == $name) | .id')

# Prepare cleaned JSON
CLEANED_JSON=$(jq '{name, nodes, connections, settings}' "$WORKFLOW_FILE")

if [ -n "$EXISTING_WORKFLOW" ]; then
    echo -e "${BLUE}ℹ${NC} Found existing workflow (ID: $EXISTING_WORKFLOW)"

    # Delete old version
    curl -s -X DELETE \
        -H "X-N8N-API-KEY: $N8N_API_KEY" \
        "$N8N_URL/api/v1/workflows/$EXISTING_WORKFLOW" > /dev/null

    echo -e "${BLUE}ℹ${NC} Deleted old version"
fi

# Create new workflow
RESPONSE=$(curl -s -X POST \
    -H "Content-Type: application/json" \
    -H "X-N8N-API-KEY: $N8N_API_KEY" \
    -d "$CLEANED_JSON" \
    "$N8N_URL/api/v1/workflows")

NEW_ID=$(echo "$RESPONSE" | jq -r '.id // empty')

if [ -z "$NEW_ID" ]; then
    echo -e "${RED}✗ Deployment failed${NC}"
    echo "$RESPONSE" | jq .
    exit 1
fi

echo -e "${GREEN}✓${NC} Deployed (ID: $NEW_ID)"

# Step 6: Activate workflow
if [ "$AUTO_ACTIVATE" = true ]; then
    echo -e "${BLUE}[6/6]${NC} Activating workflow..."

    ACTIVATE_RESPONSE=$(curl -s -X POST \
        -H "X-N8N-API-KEY: $N8N_API_KEY" \
        "$N8N_URL/api/v1/workflows/$NEW_ID/activate")

    IS_ACTIVE=$(echo "$ACTIVATE_RESPONSE" | jq -r '.active')

    if [ "$IS_ACTIVE" = "true" ]; then
        echo -e "${GREEN}✓${NC} Workflow activated"
    else
        echo -e "${YELLOW}⚠${NC} Activation may have failed"
        echo "$ACTIVATE_RESPONSE" | jq .
    fi
else
    echo -e "${BLUE}[6/6]${NC} Skipping activation (--no-activate flag)"
fi

echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║              Deployment Successful!                   ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}Workflow:${NC} $NAME"
echo -e "${BLUE}ID:${NC} $NEW_ID"
echo -e "${BLUE}Status:${NC} $([ "$AUTO_ACTIVATE" = true ] && echo "Active" || echo "Inactive")"

# Show webhook endpoints if any
if [ "$WEBHOOK_COUNT" -gt 0 ]; then
    echo -e "${BLUE}Webhooks:${NC}"
    jq -r '.nodes[] | select(.type == "n8n-nodes-base.webhook") | "  • \(.parameters.httpMethod // "GET") https://n8n.specialblend.icu/webhook/\(.parameters.path)"' "$WORKFLOW_FILE"
fi

echo ""
