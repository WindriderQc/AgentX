#!/bin/bash
# CI/CD Pipeline Validation Script
# Run on production server (192.168.2.33) to verify all deployment components
# Usage: ./scripts/validate-cicd.sh

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
PASS=0
FAIL=0
WARN=0

pass() { echo -e "  ${GREEN}PASS${NC} $1"; ((PASS++)); }
fail() { echo -e "  ${RED}FAIL${NC} $1"; ((FAIL++)); }
warn() { echo -e "  ${YELLOW}WARN${NC} $1"; ((WARN++)); }

echo "=== CI/CD Pipeline Validation ==="
echo ""

# -------------------------------------------------------------------
# 1. Git Repository Health
# -------------------------------------------------------------------
echo "1. Git Repository"

DEPLOY_DIR="${AGENTX_DEPLOY_PATH:-/home/yb/codes/AgentX}"
if [ -d "$DEPLOY_DIR/.git" ]; then
  pass "Deploy directory exists: $DEPLOY_DIR"
else
  fail "Deploy directory missing: $DEPLOY_DIR"
fi

BRANCH=$(git -C "$DEPLOY_DIR" branch --show-current 2>/dev/null || echo "")
if [ "$BRANCH" = "main" ]; then
  pass "Production is on main branch"
else
  warn "Production on branch '$BRANCH' (expected 'main')"
fi

git -C "$DEPLOY_DIR" fetch origin main --dry-run 2>/dev/null && \
  pass "Can reach GitHub remote" || \
  fail "Cannot reach GitHub remote (network issue)"

BEHIND=$(git -C "$DEPLOY_DIR" rev-list HEAD..origin/main --count 2>/dev/null || echo "?")
if [ "$BEHIND" = "0" ]; then
  pass "Up to date with origin/main"
elif [ "$BEHIND" = "?" ]; then
  warn "Could not determine sync status"
else
  warn "$BEHIND commit(s) behind origin/main"
fi
echo ""

# -------------------------------------------------------------------
# 2. Self-Hosted Runner
# -------------------------------------------------------------------
echo "2. Self-Hosted GitHub Actions Runner"

RUNNER_DIR="$DEPLOY_DIR/actions-runner"
if [ -d "$RUNNER_DIR" ]; then
  pass "Runner directory exists: $RUNNER_DIR"
else
  fail "Runner directory missing: $RUNNER_DIR"
fi

if [ -f "$RUNNER_DIR/svc.sh" ]; then
  RUNNER_STATUS=$("$RUNNER_DIR/svc.sh" status 2>&1 || true)
  if echo "$RUNNER_STATUS" | grep -qi "active\|running"; then
    pass "Runner service is active"
  else
    fail "Runner service is NOT active"
    echo "       → Run: cd $RUNNER_DIR && ./svc.sh start"
  fi
else
  warn "svc.sh not found - runner may use a different service manager"
fi

if [ -d "$RUNNER_DIR/_diag" ]; then
  LATEST_LOG=$(ls -t "$RUNNER_DIR/_diag"/Runner_*.log 2>/dev/null | head -1)
  if [ -n "$LATEST_LOG" ]; then
    LAST_ACTIVITY=$(stat -c '%Y' "$LATEST_LOG" 2>/dev/null || echo "0")
    NOW=$(date +%s)
    AGE=$(( (NOW - LAST_ACTIVITY) / 3600 ))
    if [ "$AGE" -lt 24 ]; then
      pass "Runner log activity within last ${AGE}h"
    else
      warn "Runner last log activity was ${AGE}h ago"
    fi
  fi
fi
echo ""

# -------------------------------------------------------------------
# 3. PM2 Process Manager
# -------------------------------------------------------------------
echo "3. PM2 Process Manager"

if command -v pm2 &>/dev/null; then
  pass "pm2 is installed"
else
  fail "pm2 not found in PATH"
fi

AGENTX_STATUS=$(pm2 jlist 2>/dev/null | jq -r '.[] | select(.name=="agentx") | .pm2_env.status' 2>/dev/null || echo "")
if [ "$AGENTX_STATUS" = "online" ]; then
  pass "agentx process is online"
else
  fail "agentx process status: '${AGENTX_STATUS:-not found}'"
fi
echo ""

# -------------------------------------------------------------------
# 4. Health Endpoint
# -------------------------------------------------------------------
echo "4. Health Endpoint"

HEALTH=$(curl -sf -m 5 http://localhost:3080/health 2>/dev/null || echo "")
if [ -n "$HEALTH" ]; then
  STATUS=$(echo "$HEALTH" | jq -r '.status' 2>/dev/null || echo "")
  if [ "$STATUS" = "ok" ]; then
    pass "/health returns status=ok"
  else
    fail "/health returned status='$STATUS'"
  fi
else
  fail "/health unreachable on localhost:3080"
fi
echo ""

# -------------------------------------------------------------------
# 5. Backup Scripts
# -------------------------------------------------------------------
echo "5. Backup Scripts"

for script in backup-mongodb.sh backup-qdrant.sh; do
  if [ -x "$DEPLOY_DIR/scripts/$script" ]; then
    pass "$script is executable"
  elif [ -f "$DEPLOY_DIR/scripts/$script" ]; then
    warn "$script exists but is not executable"
  else
    warn "$script not found"
  fi
done
echo ""

# -------------------------------------------------------------------
# 6. Deploy Workflow File
# -------------------------------------------------------------------
echo "6. Deploy Workflow"

DEPLOY_YML="$DEPLOY_DIR/.github/workflows/deploy.yml"
if [ -f "$DEPLOY_YML" ]; then
  pass "deploy.yml exists"
  if grep -q "self-hosted" "$DEPLOY_YML"; then
    pass "deploy.yml uses self-hosted runner"
  else
    fail "deploy.yml does NOT reference self-hosted runner"
  fi
  if grep -q "pm2 reload" "$DEPLOY_YML"; then
    pass "deploy.yml uses pm2 reload"
  else
    warn "deploy.yml may not use pm2 reload"
  fi
  if grep -q "Rollback" "$DEPLOY_YML"; then
    pass "deploy.yml has rollback step"
  else
    warn "deploy.yml has no rollback mechanism"
  fi
else
  fail "deploy.yml not found"
fi
echo ""

# -------------------------------------------------------------------
# 7. Dependencies
# -------------------------------------------------------------------
echo "7. Required Tools"

for cmd in node npm git curl jq mongosh; do
  if command -v "$cmd" &>/dev/null; then
    pass "$cmd available"
  else
    warn "$cmd not found"
  fi
done
echo ""

# -------------------------------------------------------------------
# Summary
# -------------------------------------------------------------------
echo "=== Results ==="
echo -e "  ${GREEN}PASS: $PASS${NC}  ${RED}FAIL: $FAIL${NC}  ${YELLOW}WARN: $WARN${NC}"
echo ""

if [ "$FAIL" -eq 0 ]; then
  echo -e "${GREEN}Pipeline is ready. Cloud agents can merge to main and auto-deploy will work.${NC}"
  exit 0
else
  echo -e "${RED}$FAIL check(s) failed. Fix these before relying on auto-deploy.${NC}"
  exit 1
fi
