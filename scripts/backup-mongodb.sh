#!/bin/bash
set -e

# MongoDB Backup Script for AgentX
# Usage: ./scripts/backup-mongodb.sh [backup_dir]

BACKUP_DIR="${1:-/mnt/datalake/backups/mongodb}"
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="agentx_${DATE}"
BACKUP_PATH="${BACKUP_DIR}/${BACKUP_NAME}"
RETENTION_DAYS=7

# Load environment variables
if [ -f .env ]; then
  export $(cat .env | grep -v '^#' | xargs)
fi

# Validate MongoDB URI
if [ -z "$MONGODB_URI" ]; then
  echo "❌ Error: MONGODB_URI not set"
  exit 1
fi

echo "🗄️  Starting MongoDB backup..."
echo "Target: $BACKUP_PATH"

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Run mongodump
echo "Running mongodump..."
mongodump --uri="$MONGODB_URI" --out="$BACKUP_PATH" 2>&1 | tee "${BACKUP_PATH}.log"

if [ $? -eq 0 ]; then
  echo "✓ Dump completed successfully"
else
  echo "❌ Dump failed!"
  exit 1
fi

# Compress backup
echo "Compressing backup..."
tar -czf "${BACKUP_PATH}.tar.gz" -C "$BACKUP_DIR" "$BACKUP_NAME"
COMPRESSED_SIZE=$(du -h "${BACKUP_PATH}.tar.gz" | cut -f1)
echo "✓ Compressed to ${COMPRESSED_SIZE}"

# Remove uncompressed directory
rm -rf "$BACKUP_PATH"

# Cleanup old backups (keep last N days)
echo "Cleaning up old backups (retention: ${RETENTION_DAYS} days)..."
find "$BACKUP_DIR" -name "agentx_*.tar.gz" -mtime +${RETENTION_DAYS} -delete
REMAINING=$(find "$BACKUP_DIR" -name "agentx_*.tar.gz" | wc -l)
echo "✓ ${REMAINING} backups retained"

# Optional: Upload to S3/cloud storage
if [ -n "$AWS_S3_BUCKET" ]; then
  echo "Uploading to S3..."
  aws s3 cp "${BACKUP_PATH}.tar.gz" "s3://${AWS_S3_BUCKET}/mongodb/" || echo "⚠️  S3 upload failed (continuing)"
fi

# Create backup metadata
cat > "${BACKUP_PATH}.meta.json" <<EOF
{
  "timestamp": "$(date -Iseconds)",
  "backup_name": "$BACKUP_NAME",
  "size": "$COMPRESSED_SIZE",
  "mongodb_uri": "${MONGODB_URI%%@*}@***",
  "collections": $(mongosh "$MONGODB_URI" --quiet --eval "db.getCollectionNames()" | jq -c .),
  "retention_days": $RETENTION_DAYS
}
EOF

echo "✅ MongoDB backup completed: ${BACKUP_PATH}.tar.gz"
echo ""
echo "Restore with: ./scripts/restore-mongodb.sh ${BACKUP_PATH}.tar.gz"
