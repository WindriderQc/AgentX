#!/bin/bash
# SBQC System Health Check Script
# Performs comprehensive health checks on all SBQC components
# Usage: ./scripts/health-check.sh

echo "=== SBQC System Health Check ==="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 1. Services
echo "1. Service Status:"
echo "   pm2 Services:"
pm2 status 2>/dev/null | grep -E "(agentx|dataapi)" || echo "   ${RED}✗${NC} pm2 not responding"
echo ""
echo "   Docker Containers:"
docker ps 2>/dev/null | grep -E "(n8n|mongo)" | awk '{print "   " $NF, $7}' || echo "   ${RED}✗${NC} Docker not responding"
echo ""
echo "   Ollama Service:"
sudo systemctl is-active ollama 2>/dev/null | xargs -I {} echo "   {}" || echo "   ${RED}✗${NC} systemctl failed"
echo ""

# 2. Health Endpoints
echo "2. Health Endpoints:"
echo -n "   AgentX: "
AGENTX_HEALTH=$(curl -s -m 5 http://192.168.2.33:3080/health 2>/dev/null | jq -r '.status' 2>/dev/null)
if [ "$AGENTX_HEALTH" = "ok" ]; then
    echo -e "${GREEN}✓${NC} OK"
else
    echo -e "${RED}✗${NC} FAILED (Status: $AGENTX_HEALTH)"
fi

echo -n "   DataAPI: "
DATAAPI_HEALTH=$(curl -s -m 5 http://192.168.2.33:3003/health 2>/dev/null | jq -r '.status' 2>/dev/null)
if [ -n "$DATAAPI_HEALTH" ]; then
    echo -e "${GREEN}✓${NC} OK (Status: $DATAAPI_HEALTH)"
else
    echo -e "${RED}✗${NC} FAILED"
fi

echo -n "   n8n: "
N8N_HEALTH=$(curl -s -m 5 https://n8n.specialblend.icu/webhook/sbqc-health 2>/dev/null | jq -r '.overall_status' 2>/dev/null)
if [ "$N8N_HEALTH" = "healthy" ]; then
    echo -e "${GREEN}✓${NC} healthy"
else
    echo -e "${YELLOW}⚠${NC} $N8N_HEALTH (or unreachable)"
fi
echo ""

# 3. Database
echo "3. Database:"
MONGO_PING=$(mongosh --quiet --eval "db.adminCommand('ping').ok" mongodb://localhost:27017/agentx 2>/dev/null)
if [ "$MONGO_PING" = "1" ]; then
    echo -e "   MongoDB: ${GREEN}✓${NC} OK"
else
    echo -e "   MongoDB: ${RED}✗${NC} FAILED"
fi
echo ""

# 4. AI Service
echo "4. Ollama:"
MODEL_COUNT=$(curl -s -m 5 http://localhost:11434/api/tags 2>/dev/null | jq -r '.models | length' 2>/dev/null)
if [ -n "$MODEL_COUNT" ] && [ "$MODEL_COUNT" -gt 0 ]; then
    echo -e "   Models available: ${GREEN}$MODEL_COUNT${NC}"
else
    echo -e "   ${RED}✗${NC} No models available or Ollama not responding"
fi
echo ""

# 5. Webhooks
echo "5. Webhook Tests:"
echo -n "   Deployment Test: "
DEPLOY_TEST=$(curl -s -m 5 https://n8n.specialblend.icu/webhook/test-deployment 2>/dev/null | jq -r '.status' 2>/dev/null)
if [ "$DEPLOY_TEST" = "success" ]; then
    echo -e "${GREEN}✓${NC} success"
else
    echo -e "${RED}✗${NC} FAILED"
fi
echo ""

# 6. Disk Space
echo "6. Disk Space:"
df -h | grep -E "(Filesystem|/$|/home)" | awk '{printf "   %-30s %5s / %5s (%s)\n", $1, $3, $2, $5}'
echo ""

# 7. Memory
echo "7. Memory:"
free -h | grep -E "(Mem|Swap)" | awk '{printf "   %-10s %8s / %8s used\n", $1, $3, $2}'
echo ""

# Summary
echo "=== Health Check Complete ==="

# Exit code based on critical services
if [ "$AGENTX_HEALTH" = "ok" ] && [ "$MONGO_PING" = "1" ] && [ "$MODEL_COUNT" -gt 0 ]; then
    echo -e "${GREEN}✓ All critical services operational${NC}"
    exit 0
else
    echo -e "${RED}✗ Some critical services are down - review output above${NC}"
    exit 1
fi
