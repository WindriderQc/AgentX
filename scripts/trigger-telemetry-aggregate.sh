#!/usr/bin/env bash
# Trigger a SpecialX telemetry_aggregate task — called hourly by cron.
# Aggregates InferenceLog → HostUsageLedger for the cluster schedule heatmap.
set -euo pipefail

AGENTX_URL="${AGENTX_URL:-http://localhost:3080}"
API_KEY="${AGENTX_API_KEY:-agentx-prod-api-key-2024}"

result=$(curl -sf -m 15 \
  -X POST "${AGENTX_URL}/api/specialx/tasks" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${API_KEY}" \
  -d '{"type":"telemetry_aggregate","source":"cron","priority":3}' \
  2>&1) || {
  echo "[telemetry-aggregate] ERROR: curl failed — $result"
  exit 1
}

echo "[telemetry-aggregate] OK — $(date -u +%Y-%m-%dT%H:%M:%SZ): $result"
