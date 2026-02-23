#!/usr/bin/env bash
# Roundtable CLI — async: POST then poll until done, then fetch transcript
# Usage: bash scripts/roundtable-cli.sh "Your question here" [rounds]
set -euo pipefail

BASE_URL="${AGENTX_URL:-http://localhost:3080}"
QUESTION="${1:?Usage: roundtable-cli.sh \"question\" [rounds]}"
ROUNDS="${2:-2}"
POLL_INTERVAL=5

echo "Starting roundtable: \"$QUESTION\" (${ROUNDS} rounds)"

# POST — create + fire-and-forget
RESPONSE=$(curl -s -X POST "${BASE_URL}/api/roundtable" \
  -H 'Content-Type: application/json' \
  -d "$(python3 -c "import json; print(json.dumps({'question': '''${QUESTION}''', 'rounds': ${ROUNDS}}))")")

ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['_id'])")
STATUS=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")

echo "Created roundtable: $ID (status: $STATUS)"

# Poll until complete
while true; do
  sleep "$POLL_INTERVAL"
  POLL=$(curl -s "${BASE_URL}/api/roundtable/${ID}")
  STATUS=$(echo "$POLL" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['status'])")
  TURNS=$(echo "$POLL" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['data'].get('turns',[])))")
  echo "  Status: $STATUS | Turns: $TURNS"

  if [[ "$STATUS" != "pending" && "$STATUS" != "running" ]]; then
    break
  fi
done

echo ""
echo "=== Transcript ==="
echo ""
curl -s "${BASE_URL}/api/roundtable/${ID}/transcript"
