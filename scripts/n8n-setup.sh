#!/bin/bash
# n8n Full Setup Script — The Kawabonga Script
# Validates, deploys, activates, configures webhooks, and smoke tests
#
# Usage:
#   ./scripts/n8n-setup.sh              # Full setup (all stages)
#   ./scripts/n8n-setup.sh --check      # Validate env + test connectivity only
#   ./scripts/n8n-setup.sh --deploy     # Deploy + activate only
#   ./scripts/n8n-setup.sh --smoke      # Smoke test only

set -euo pipefail

# ─── Load environment ────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [ -f "$PROJECT_ROOT/.env" ]; then
    set -a
    source <(grep -v '^#' "$PROJECT_ROOT/.env" | grep -v '^$')
    set +a
fi

N8N_URL="${N8N_URL:-http://localhost:5678}"
N8N_API_KEY="${N8N_API_KEY:-}"
N8N_WEBHOOK_BASE_URL="${N8N_WEBHOOK_BASE_URL:-$N8N_URL/webhook}"

# ─── Colors ──────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

log_info()    { echo -e "${BLUE}ℹ${NC}  $1"; }
log_success() { echo -e "${GREEN}✓${NC}  $1"; }
log_warn()    { echo -e "${YELLOW}⚠${NC}  $1"; }
log_error()   { echo -e "${RED}✗${NC}  $1"; }
log_stage()   { echo ""; echo -e "${BOLD}━━━ Stage $1: $2 ━━━${NC}"; }

ERRORS=0

# ─── Stage 1: Validate environment ──────────────────────────────────
stage_validate() {
    log_stage 1 "Validate environment"

    local ok=true

    if [ -z "$N8N_URL" ]; then
        log_error "N8N_URL is not set"
        ok=false
    else
        log_success "N8N_URL = $N8N_URL"
    fi

    if [ -z "$N8N_API_KEY" ]; then
        log_error "N8N_API_KEY is not set"
        ok=false
    else
        log_success "N8N_API_KEY is set (${#N8N_API_KEY} chars)"
    fi

    if [ -z "$N8N_WEBHOOK_BASE_URL" ]; then
        log_warn "N8N_WEBHOOK_BASE_URL not set (will use $N8N_URL/webhook)"
    else
        log_success "N8N_WEBHOOK_BASE_URL = $N8N_WEBHOOK_BASE_URL"
    fi

    if ! command -v jq &>/dev/null; then
        log_error "jq is not installed (required)"
        ok=false
    else
        log_success "jq available"
    fi

    if ! command -v curl &>/dev/null; then
        log_error "curl is not installed (required)"
        ok=false
    fi

    if [ "$ok" != "true" ]; then
        log_error "Environment validation failed — fix issues above"
        return 1
    fi

    log_success "Environment OK"
}

# ─── Stage 2: Test n8n API connectivity ─────────────────────────────
stage_connectivity() {
    log_stage 2 "Test n8n API connectivity"

    # Health check
    local health_status
    health_status=$(curl -s -m 10 "$N8N_URL/healthz" 2>/dev/null || echo "unreachable")

    if echo "$health_status" | jq -e '.status == "ok"' &>/dev/null; then
        log_success "n8n health: OK"
    else
        log_error "n8n health check failed at $N8N_URL/healthz"
        log_info "Response: $health_status"
        return 1
    fi

    # API auth check
    local response
    response=$(curl -s -w "\n%{http_code}" \
        -H "X-N8N-API-KEY: $N8N_API_KEY" \
        "$N8N_URL/api/v1/workflows" 2>/dev/null || echo -e "\n000")

    local http_code body
    http_code=$(echo "$response" | tail -n 1)
    body=$(echo "$response" | head -n -1)

    if [ "$http_code" = "200" ]; then
        local wf_count
        wf_count=$(echo "$body" | jq -r '.data | length' 2>/dev/null || echo "?")
        log_success "API authenticated — $wf_count workflows currently on server"
    else
        log_error "API auth failed (HTTP $http_code)"
        return 1
    fi
}

# ─── Stage 3: Deploy all workflows ──────────────────────────────────
stage_deploy() {
    log_stage 3 "Deploy all AgentC workflows"

    local deploy_script="$SCRIPT_DIR/deploy-n8n-workflows.sh"

    if [ ! -f "$deploy_script" ]; then
        log_error "Deploy script not found: $deploy_script"
        return 1
    fi

    chmod +x "$deploy_script"

    # Run deploy script (which now also activates)
    log_info "Running deploy-n8n-workflows.sh..."
    if bash "$deploy_script"; then
        log_success "Deployment complete"
    else
        log_error "Deployment failed"
        return 1
    fi
}

# ─── Stage 4: Verify activation ─────────────────────────────────────
stage_verify_activation() {
    log_stage 4 "Verify workflow activation"

    local response
    response=$(curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
        "$N8N_URL/api/v1/workflows" 2>/dev/null || echo '{"data":[]}')

    local total active inactive
    total=$(echo "$response" | jq -r '.data | length' 2>/dev/null || echo "0")
    active=$(echo "$response" | jq -r '[.data[] | select(.active == true)] | length' 2>/dev/null || echo "0")
    inactive=$(echo "$response" | jq -r '[.data[] | select(.active != true)] | length' 2>/dev/null || echo "0")

    log_info "Total: $total | Active: $active | Inactive: $inactive"

    if [ "$inactive" -gt 0 ]; then
        log_warn "Some workflows are not active. Attempting activation..."
        echo "$response" | jq -r '.data[] | select(.active != true) | "\(.id) \(.name)"' 2>/dev/null | \
        while read -r wf_id wf_name; do
            local act_code
            act_code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
                -H "X-N8N-API-KEY: $N8N_API_KEY" \
                "$N8N_URL/api/v1/workflows/$wf_id/activate" 2>/dev/null || echo "000")

            if [ "$act_code" = "200" ]; then
                log_success "Activated: $wf_name"
            else
                log_warn "Could not activate $wf_name (HTTP $act_code)"
            fi
        done
    else
        log_success "All $total workflows are active"
    fi
}

# ─── Stage 5: Extract webhook paths → update .env ───────────────────
stage_extract_webhooks() {
    log_stage 5 "Extract webhook paths and update .env"

    local workflows_dir="$PROJECT_ROOT/AgentC"
    local env_file="$PROJECT_ROOT/.env"

    # Map env var → workflow file webhook path
    # N8N_WEBHOOK_RAG_INGEST    → N2.3 sbqc-n2-3-rag-ingest
    # N8N_WEBHOOK_CHAT_COMPLETE → N3.2 sbqc-ai-query
    # N8N_WEBHOOK_ANALYTICS     → N5.1 sbqc-n5-1-feedback-analysis
    # N8N_WEBHOOK_GENERIC       → N0.0 test-deployment (sbqc-deployment-test)

    local -A WEBHOOK_MAP=(
        ["N8N_WEBHOOK_RAG_INGEST"]="$workflows_dir/N2.3.json"
        ["N8N_WEBHOOK_CHAT_COMPLETE"]="$workflows_dir/N3.2.json"
        ["N8N_WEBHOOK_ANALYTICS"]="$workflows_dir/N5.1.json"
        ["N8N_WEBHOOK_GENERIC"]="$workflows_dir/N0.0-test-deployment.json"
    )

    for env_var in "${!WEBHOOK_MAP[@]}"; do
        local wf_file="${WEBHOOK_MAP[$env_var]}"
        if [ ! -f "$wf_file" ]; then
            log_warn "Workflow file not found for $env_var: $wf_file"
            continue
        fi

        local webhook_path
        webhook_path=$(jq -r '.nodes[] | select(.type == "n8n-nodes-base.webhook") | .parameters.path' "$wf_file" 2>/dev/null | head -1)

        if [ -z "$webhook_path" ] || [ "$webhook_path" = "null" ]; then
            log_warn "No webhook path found in $wf_file for $env_var"
            continue
        fi

        # Update .env (replace existing line or leave as-is if already correct)
        if grep -q "^${env_var}=" "$env_file"; then
            sed -i "s|^${env_var}=.*|${env_var}=${webhook_path}|" "$env_file"
            log_success "$env_var=$webhook_path"
        else
            echo "${env_var}=${webhook_path}" >> "$env_file"
            log_success "$env_var=$webhook_path (appended)"
        fi
    done

    log_success "Webhook paths updated in .env"
}

# ─── Stage 6: Smoke test ────────────────────────────────────────────
stage_smoke() {
    log_stage 6 "Smoke test"

    local pass=0
    local fail=0

    # Test 1: n8n health
    log_info "Test 1: n8n healthz"
    local h
    h=$(curl -s -m 5 "$N8N_URL/healthz" 2>/dev/null || echo "")
    if echo "$h" | jq -e '.status == "ok"' &>/dev/null; then
        log_success "n8n healthz: OK"
        pass=$((pass + 1))
    else
        log_error "n8n healthz: FAILED"
        fail=$((fail + 1))
    fi

    # Test 2: Workflow count
    log_info "Test 2: Workflow count"
    local wf_count
    wf_count=$(curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" "$N8N_URL/api/v1/workflows" 2>/dev/null | \
        jq -r '.data | length' 2>/dev/null || echo "0")
    if [ "$wf_count" -gt 0 ]; then
        log_success "$wf_count workflows deployed"
        pass=$((pass + 1))
    else
        log_error "No workflows found"
        fail=$((fail + 1))
    fi

    # Test 3: AgentX n8n health (if AgentX is running)
    log_info "Test 3: AgentX /api/n8n/health"
    local agentx_n8n
    agentx_n8n=$(curl -s -m 5 "http://localhost:3080/api/n8n/health" 2>/dev/null || echo "")
    if echo "$agentx_n8n" | jq -e '.status == "success"' &>/dev/null; then
        log_success "AgentX n8n health: OK"
        pass=$((pass + 1))
    else
        log_warn "AgentX n8n health: unavailable (is AgentX running?)"
    fi

    # Test 4: Deployment test webhook
    log_info "Test 4: Deployment test webhook"
    local deploy_test
    deploy_test=$(curl -s -m 10 "$N8N_WEBHOOK_BASE_URL/test-deployment" 2>/dev/null || echo "")
    if [ -n "$deploy_test" ] && [ "$deploy_test" != "" ]; then
        log_success "Webhook test-deployment responded"
        pass=$((pass + 1))
    else
        log_warn "Webhook test-deployment: no response (workflow may need activation)"
    fi

    echo ""
    echo -e "${BOLD}Smoke test results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"

    if [ "$fail" -gt 0 ]; then
        return 1
    fi
}

# ─── Main ────────────────────────────────────────────────────────────
main() {
    echo ""
    echo -e "${BOLD}╔═══════════════════════════════════════════════════════╗${NC}"
    echo -e "${BOLD}║          n8n Setup — The Kawabonga Script            ║${NC}"
    echo -e "${BOLD}╚═══════════════════════════════════════════════════════╝${NC}"

    case "${1:-}" in
        --check)
            stage_validate && stage_connectivity
            exit $?
            ;;
        --deploy)
            stage_validate && stage_connectivity && stage_deploy && stage_verify_activation
            exit $?
            ;;
        --smoke)
            stage_validate && stage_smoke
            exit $?
            ;;
        "")
            # Full setup
            stage_validate || exit 1
            stage_connectivity || exit 1
            stage_deploy || exit 1
            stage_verify_activation
            stage_extract_webhooks
            stage_smoke

            echo ""
            echo -e "${GREEN}${BOLD}Kawabonga! n8n setup complete.${NC}"
            echo ""
            ;;
        *)
            echo "Usage: $0 [--check | --deploy | --smoke]"
            exit 1
            ;;
    esac
}

main "$@"
