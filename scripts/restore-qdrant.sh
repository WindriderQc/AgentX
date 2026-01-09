#!/bin/bash
set -e

# Qdrant Restore Script
# Usage: ./scripts/restore-qdrant.sh <snapshot_file>

if [ -z "$1" ]; then
  echo "Usage: ./scripts/restore-qdrant.sh <snapshot_file>"
  echo ""
  echo "Available snapshots:"
  find /mnt/datalake/backups/qdrant -name "*.snapshot" -printf "%T@ %p\n" | sort -rn | cut -d' ' -f2- | head -10
  exit 1
fi

SNAPSHOT_FILE="$1"
QDRANT_URL="${QDRANT_URL:-http://localhost:6333}"
COLLECTION="${QDRANT_COLLECTION:-agentx_rag}"

# Confirm restore
echo "⚠️  WARNING: This will restore Qdrant collection from snapshot"
echo "Snapshot: $SNAPSHOT_FILE"
echo "Collection: $COLLECTION"
echo ""
read -p "Type 'yes' to proceed: " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
  echo "Restore cancelled"
  exit 0
fi

echo "🔄 Starting Qdrant restore..."

# Upload snapshot
SNAPSHOT_NAME=$(basename "$SNAPSHOT_FILE")
echo "Uploading snapshot..."
curl -X PUT "$QDRANT_URL/collections/$COLLECTION/snapshots/upload" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "@$SNAPSHOT_FILE"

echo "✓ Snapshot uploaded: $SNAPSHOT_NAME"

# Recover from snapshot
echo "Recovering collection..."
curl -X PUT "$QDRANT_URL/collections/$COLLECTION/snapshots/$SNAPSHOT_NAME/recover"

echo "✅ Qdrant restore completed"
echo ""
echo "Verify with: curl $QDRANT_URL/collections/$COLLECTION"
