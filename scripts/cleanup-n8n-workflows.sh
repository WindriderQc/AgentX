#!/bin/bash

# Cleanup obsolete n8n workflows
# Usage: ./scripts/cleanup-n8n-workflows.sh [N1.2|TEST|all]

set -e

N8N_URL="${N8N_URL:-http://localhost:5678}"
N8N_API_KEY="${N8N_API_KEY:-}"

if [ -z "$N8N_API_KEY" ]; then
    echo "❌ N8N_API_KEY not set. Set it with: export N8N_API_KEY=..."
    exit 1
fi

echo "╔═══════════════════════════════════════════════════════════╗"
echo "║  n8n Workflow Cleanup Script v1.0                         ║"
echo "╚═══════════════════════════════════════════════════════════╝"

# Get list of workflows
echo "ℹ Fetching workflows from $N8N_URL..."
WORKFLOWS=$(curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" "$N8N_URL/api/v1/workflows" | jq '.data')

DELETE_TARGET="${1:-}"

# Function to delete workflow by name
delete_workflow() {
    local pattern=$1
    local workflow_id=$(echo "$WORKFLOWS" | jq -r ".[] | select(.name | test(\"$pattern\")) | .id" | head -1)
    
    if [ -z "$workflow_id" ]; then
        echo "⚠️  No workflow matching pattern: $pattern"
        return 1
    fi
    
    local workflow_name=$(echo "$WORKFLOWS" | jq -r ".[] | select(.id == $workflow_id) | .name")
    
    echo "ℹ Deleting workflow: $workflow_name (ID: $workflow_id)"
    
    curl -s -X DELETE \
        -H "X-N8N-API-KEY: $N8N_API_KEY" \
        "$N8N_URL/api/v1/workflows/$workflow_id" > /dev/null
    
    echo "✓ Deleted: $workflow_name"
}

case "$DELETE_TARGET" in
    N1.2)
        delete_workflow "N1.2|Health Probe"
        ;;
    TEST)
        delete_workflow "TEST PACK|One-click"
        ;;
    all)
        echo "Deleting all obsolete workflows..."
        delete_workflow "N1.2|Health Probe"
        delete_workflow "TEST PACK|One-click"
        ;;
    "")
        echo "Usage: $0 [N1.2|TEST|all]"
        echo ""
        echo "Examples:"
        echo "  $0 N1.2    # Delete N1.2 workflow"
        echo "  $0 TEST    # Delete TEST PACK workflow"
        echo "  $0 all     # Delete all obsolete workflows"
        exit 1
        ;;
    *)
        echo "❌ Unknown target: $DELETE_TARGET"
        exit 1
        ;;
esac

echo ""
echo "✓ Cleanup complete"
