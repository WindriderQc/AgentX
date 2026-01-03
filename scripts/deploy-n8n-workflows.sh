#!/bin/bash
# n8n Workflow Deployment Script
# Automatically imports/updates workflows to n8n instance via REST API
# 
# Usage:
#   ./deploy-n8n-workflows.sh                    # Deploy all workflows
#   ./deploy-n8n-workflows.sh N3.1.json          # Deploy specific workflow
#   ./deploy-n8n-workflows.sh --check            # Check API connectivity

set -e

# Load environment variables from .env if it exists
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [ -f "$PROJECT_ROOT/.env" ]; then
    export $(grep -v '^#' "$PROJECT_ROOT/.env" | grep -v '^$' | xargs)
fi

# Configuration
N8N_URL="${N8N_URL:-https://n8n.specialblend.icu}"
N8N_API_KEY="${N8N_API_KEY:-}"
WORKFLOWS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../AgentC" && pwd)"
COLORED_OUTPUT=true

# Colors
if [ "$COLORED_OUTPUT" = true ]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    BLUE='\033[0;34m'
    NC='\033[0m' # No Color
else
    RED=''
    GREEN=''
    YELLOW=''
    BLUE=''
    NC=''
fi

# Helper functions
log_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

log_success() {
    echo -e "${GREEN}✓${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

log_error() {
    echo -e "${RED}✗${NC} $1"
}

# Check if jq is installed
if ! command -v jq &> /dev/null; then
    log_error "jq is required but not installed. Install with: sudo apt-get install jq"
    exit 1
fi

# Check API connectivity
check_n8n_api() {
    log_info "Checking n8n API connectivity at $N8N_URL..."

    if [ -z "$N8N_API_KEY" ]; then
        log_error "N8N_API_KEY not set! Please set it in .env file or environment."
        return 1
    fi

    response=$(curl -s -w "\n%{http_code}" -H "X-N8N-API-KEY: $N8N_API_KEY" "$N8N_URL/api/v1/workflows" || echo "000")
    
    http_code=$(echo "$response" | tail -n 1)
    body=$(echo "$response" | head -n -1)
    
    if [ "$http_code" = "200" ]; then
        workflow_count=$(echo "$body" | jq -r '.data | length' 2>/dev/null || echo "0")
        log_success "Connected to n8n API (${workflow_count} workflows found)"
        return 0
    elif [ "$http_code" = "401" ]; then
        log_error "Authentication failed. Check N8N_API_KEY environment variable."
        return 1
    elif [ "$http_code" = "000" ]; then
        log_error "Cannot reach n8n at $N8N_URL. Is the service running?"
        return 1
    else
        log_error "API returned HTTP $http_code"
        return 1
    fi
}

# Get workflow IDs by name (may return multiple lines if duplicates exist)
get_workflow_ids() {
    local workflow_name="$1"

    workflows=$(curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" "$N8N_URL/api/v1/workflows" 2>/dev/null || echo '{"data":[]}')
    echo "$workflows" | jq -r ".data[] | select(.name == \"$workflow_name\") | .id" 2>/dev/null | sed '/^null$/d' | sed '/^$/d'
}

# Import or update workflow
deploy_workflow() {
    local workflow_file="$1"
    local workflow_name=$(basename "$workflow_file" .json)
    
    if [ ! -f "$workflow_file" ]; then
        log_error "Workflow file not found: $workflow_file"
        return 1
    fi
    
    # Validate JSON
    if ! jq empty "$workflow_file" 2>/dev/null; then
        log_error "Invalid JSON in $workflow_file"
        return 1
    fi
    
    # Get workflow name from JSON
    local wf_name=$(jq -r '.name' "$workflow_file")
    log_info "Deploying workflow: $wf_name"
    
    # Check if workflow exists (may have duplicates)
    local existing_ids
    existing_ids=$(get_workflow_ids "$wf_name" || true)

    if [ -n "$existing_ids" ]; then
        local id_count
        id_count=$(echo "$existing_ids" | wc -l | tr -d ' ')
        if [ "$id_count" -gt 1 ]; then
            log_warning "Found $id_count workflows named '$wf_name' (duplicates). Deleting all before redeploy."
        else
            log_info "Found existing workflow (ID: $existing_ids), replacing..."
        fi

        # Delete all matching workflows (PUT doesn't preserve connections properly)
        while IFS= read -r existing_id; do
            [ -z "$existing_id" ] && continue

            delete_response=$(curl -s -w "\n%{http_code}" -X DELETE \
                -H "X-N8N-API-KEY: $N8N_API_KEY" \
                "$N8N_URL/api/v1/workflows/$existing_id" 2>/dev/null || echo -e "\n000")

            delete_code=$(echo "$delete_response" | tail -n 1)
            if [ "$delete_code" != "200" ]; then
                log_error "Failed to delete old workflow '$wf_name' (ID: $existing_id) (HTTP $delete_code)"
                return 1
            fi
        done <<< "$existing_ids"

        # Create new workflow (same code as below)
        local cleaned_json=$(jq '{name, nodes, connections, settings}' "$workflow_file")

        response=$(curl -s -w "\n%{http_code}" -X POST \
            -H "Content-Type: application/json" \
            -H "X-N8N-API-KEY: $N8N_API_KEY" \
            -d "$cleaned_json" \
            "$N8N_URL/api/v1/workflows" 2>/dev/null || echo -e "\n000")

        http_code=$(echo "$response" | tail -n 1)
        body=$(echo "$response" | head -n -1)

        if [ "$http_code" = "200" ] || [ "$http_code" = "201" ]; then
            new_id=$(echo "$body" | jq -r '.data.id // .id' 2>/dev/null || echo "unknown")
            log_success "Replaced workflow: $wf_name (New ID: $new_id)"
            return 0
        else
            log_error "Failed to recreate workflow (HTTP $http_code)"
            echo "$body" | jq '.' 2>/dev/null || echo "$body"
            return 1
        fi
    else
        # Create new workflow
        log_info "Workflow not found, creating new..."

        # Keep only essential fields for creation: name, nodes, connections, settings
        local cleaned_json=$(jq '{name, nodes, connections, settings}' "$workflow_file")

        response=$(curl -s -w "\n%{http_code}" -X POST \
            -H "Content-Type: application/json" \
            -H "X-N8N-API-KEY: $N8N_API_KEY" \
            -d "$cleaned_json" \
            "$N8N_URL/api/v1/workflows" 2>/dev/null || echo -e "\n000")
        
        http_code=$(echo "$response" | tail -n 1)
        body=$(echo "$response" | head -n -1)
        
        if [ "$http_code" = "200" ] || [ "$http_code" = "201" ]; then
            new_id=$(echo "$body" | jq -r '.data.id' 2>/dev/null || echo "unknown")
            log_success "Created workflow: $wf_name (ID: $new_id)"
            return 0
        else
            log_error "Failed to create workflow (HTTP $http_code)"
            echo "$body" | jq '.' 2>/dev/null || echo "$body"
            return 1
        fi
    fi
}

# Main script
main() {
    echo ""
    echo "╔═══════════════════════════════════════════════════════════╗"
    echo "║       n8n Workflow Deployment Script v1.0                ║"
    echo "╚═══════════════════════════════════════════════════════════╝"
    echo ""
    
    # Check for --check flag
    if [ "$1" = "--check" ]; then
        check_n8n_api
        exit $?
    fi
    
    # Check API connectivity first
    if ! check_n8n_api; then
        log_error "Cannot proceed without API connectivity"
        echo ""
        log_info "Troubleshooting steps:"
        echo "  1. Verify n8n is running: docker ps | grep n8n"
        echo "  2. Check firewall: curl http://192.168.2.199:5678/healthz"
        echo "  3. Set API key: export N8N_API_KEY='your-api-key'"
        echo ""
        exit 1
    fi
    
    echo ""
    
    # Deploy specific workflow or all
    if [ -n "$1" ] && [ "$1" != "--check" ]; then
        # Deploy specific workflow
        if [[ "$1" == *.json ]]; then
            workflow_path="$WORKFLOWS_DIR/$1"
        else
            workflow_path="$WORKFLOWS_DIR/$1.json"
        fi
        
        if [ ! -f "$workflow_path" ]; then
            log_error "Workflow not found: $workflow_path"
            exit 1
        fi
        
        deploy_workflow "$workflow_path"
        exit $?
    else
        # Deploy all workflows
        log_info "Deploying all workflows from $WORKFLOWS_DIR..."
        echo ""
        
        success_count=0
        fail_count=0
        
        for workflow_file in "$WORKFLOWS_DIR"/N*.json; do
            if [ -f "$workflow_file" ]; then
                if deploy_workflow "$workflow_file"; then
                    ((success_count++))
                else
                    ((fail_count++))
                fi
                echo ""
            fi
        done
        
        # Summary
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        log_success "Deployed $success_count workflows"
        if [ $fail_count -gt 0 ]; then
            log_error "Failed $fail_count workflows"
        fi
        echo ""
        
        exit $([ $fail_count -eq 0 ] && echo 0 || echo 1)
    fi
}

# Run main function
main "$@"
