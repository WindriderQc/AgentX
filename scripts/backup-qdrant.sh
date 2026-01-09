#!/bin/bash
set -e

# Qdrant Snapshot Backup Script
# Usage: ./scripts/backup-qdrant.sh [backup_dir]

QDRANT_URL="${QDRANT_URL:-http://localhost:6333}"
COLLECTION="${QDRANT_COLLECTION:-agentx_rag}"
BACKUP_DIR="${1:-/mnt/datalake/backups/qdrant}"
DATE=$(date +%Y%m%d_%H%M%S)
RETENTION_DAYS=7

echo "🗂️  Starting Qdrant backup..."
echo "Collection: $COLLECTION"

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Create snapshot via API
echo "Creating snapshot..."
SNAPSHOT_RESPONSE=$(curl -s -X POST "$QDRANT_URL/collections/$COLLECTION/snapshots")
SNAPSHOT_NAME=$(echo "$SNAPSHOT_RESPONSE" | jq -r '.result.name')

if [ "$SNAPSHOT_NAME" == "null" ] || [ -z "$SNAPSHOT_NAME" ]; then
  echo "❌ Failed to create snapshot"
  echo "Response: $SNAPSHOT_RESPONSE"
  exit 1
fi

echo "✓ Snapshot created: $SNAPSHOT_NAME"

# Download snapshot
OUTPUT_FILE="${BACKUP_DIR}/${COLLECTION}_${DATE}.snapshot"
echo "Downloading snapshot..."
curl -s "$QDRANT_URL/collections/$COLLECTION/snapshots/$SNAPSHOT_NAME" \
  -o "$OUTPUT_FILE"

SNAPSHOT_SIZE=$(du -h "$OUTPUT_FILE" | cut -f1)
echo "✓ Downloaded: $SNAPSHOT_SIZE"

# Cleanup old snapshots
echo "Cleaning up old snapshots..."
find "$BACKUP_DIR" -name "${COLLECTION}_*.snapshot" -mtime +${RETENTION_DAYS} -delete

# Delete remote snapshot (optional, to save disk space)
curl -s -X DELETE "$QDRANT_URL/collections/$COLLECTION/snapshots/$SNAPSHOT_NAME" > /dev/null

echo "✅ Qdrant backup completed: $OUTPUT_FILE"
echo ""
echo "Restore with: ./scripts/restore-qdrant.sh $OUTPUT_FILE"
